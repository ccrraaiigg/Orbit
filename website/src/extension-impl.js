// Exported as a factory so that the installed extension's
// <ext>/src/extension.js shim can call require('vscode') from within the
// extension directory (where VS Code can identify the calling extension)
// and pass the vscode API in. When this file lives outside the extension
// directory (as it does in the workspace via symlinked install), a direct
// require('vscode') here would log a warning:
//   "Could not identify extension for 'vscode' require call from ..."
module.exports = function (vscode) {
    const http = require('http');
    const path = require('path');
    const fs = require('fs');
    const os = require('os');

    const devHosts = new Set(['melody', 'rhythm']);
    const shortHostname = os.hostname().split('.')[0].toLowerCase();
    const mcpHost = devHosts.has(shortHostname) ? '192.168.1.140' : 'localhost';

    let server = null;

    function activate(context) {
        const startCmd = vscode.commands.registerCommand('orbit.start', async () => {
            if (server) {
                const addr = server.address();
                const url = `http://localhost:${addr.port}/orbit.html`;
                await vscode.commands.executeCommand('simpleBrowser.show', url);
                return;
            }

            const app = require(path.join(context.extensionPath, 'app'));
            server = http.createServer(app);

            server.listen(8089, () => {
                const addr = server.address();
                const url = `http://localhost:${addr.port}/orbit.html`;
                vscode.window.showInformationMessage(`Orbit running on port ${addr.port}`);
                vscode.commands.executeCommand('simpleBrowser.show', url);
            });

            server.on('error', (err) => {
                vscode.window.showErrorMessage(`Orbit server error: ${err.message}`);
                server = null;
            });
        });

        const stopCmd = vscode.commands.registerCommand('orbit.stop', () => {
            if (server) {
                server.close();
                server = null;
                // Drop cached app.js and route modules so the next start
                // picks up edits to those files. The workspace app.js and
                // routes/*.js are reached via symlinks from the installed
                // extension dir, but Node's require cache is keyed by the
                // resolved real path, so a fresh require alone is not
                // enough — we must invalidate first.
                try {
                    Object.keys(require.cache).forEach((k) => {
                        if (k.endsWith('/app.js') || k.includes('/routes/')) {
                            delete require.cache[k];
                        }
                    });
                } catch (_) {}
                vscode.window.showInformationMessage('Orbit stopped.');
            } else {
                vscode.window.showInformationMessage('Orbit is not running.');
            }
        });

        context.subscriptions.push(startCmd, stopCmd);

        // Command to open steering file from extension details page
        const openSteeringCmd = vscode.commands.registerCommand('orbit.openSteering', () => {
            const steeringPath = vscode.Uri.file(path.join(context.extensionPath, 'agents', 'orbit.agent.md'));
            vscode.commands.executeCommand('vscode.open', steeringPath);
        });
        context.subscriptions.push(openSteeringCmd);

        // Chat participant: @orbit
        const agentMdPath = path.join(context.extensionPath, 'agents', 'orbit.agent.md');
        const agentInstructions = fs.readFileSync(agentMdPath, 'utf8');

        const participant = vscode.chat.createChatParticipant('orbit.orbit', async (request, chatContext, response, token) => {
            try {
                const messages = [vscode.LanguageModelChatMessage.User(agentInstructions)];

                // Replay chat history so multi-turn works.
                for (const turn of (chatContext.history || [])) {
                    if (turn instanceof vscode.ChatRequestTurn) {
                        if (turn.participant === 'orbit.orbit') {
                            messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
                        }
                    } else if (turn instanceof vscode.ChatResponseTurn) {
                        if (turn.participant === 'orbit.orbit') {
                            const text = (turn.response || [])
                                .map(p => (p && p.value && typeof p.value.value === 'string') ? p.value.value : '')
                                .join('');
                            if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
                        }
                    }
                }

                messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

                // Build the tool list available to the model. Filter out our own
                // chat participant or anything without a description.
                const allTools = (vscode.lm.tools || []).filter(t => t && t.name && t.description);
                const toolMap = new Map(allTools.map(t => [t.name, t]));
                const toolsForModel = allTools.map(t => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema
                }));

                const MAX_ITERATIONS = 16;
                for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
                    if (token.isCancellationRequested) return;

                    const lmResponse = await request.model.sendRequest(
                        messages,
                        { tools: toolsForModel },
                        token
                    );

                    const toolCalls = [];
                    const assistantParts = [];
                    for await (const part of lmResponse.stream) {
                        if (token.isCancellationRequested) return;
                        if (part instanceof vscode.LanguageModelTextPart) {
                            response.markdown(part.value);
                            assistantParts.push(part);
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            toolCalls.push(part);
                            assistantParts.push(part);
                        }
                    }

                    if (toolCalls.length === 0) return;

                    // Record the assistant turn (text + tool calls) before tool results.
                    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                    for (const call of toolCalls) {
                        if (token.isCancellationRequested) return;
                        const tool = toolMap.get(call.name);
                        if (!tool) {
                            messages.push(vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelToolResultPart(call.callId, [
                                    new vscode.LanguageModelTextPart(`Tool '${call.name}' is not available.`)
                                ])
                            ]));
                            continue;
                        }
                        try {
                            response.progress(`Invoking ${call.name}…`);
                            const result = await vscode.lm.invokeTool(call.name, {
                                input: call.input,
                                toolInvocationToken: request.toolInvocationToken
                            }, token);
                            messages.push(vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelToolResultPart(call.callId, result.content)
                            ]));
                        } catch (toolErr) {
                            messages.push(vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelToolResultPart(call.callId, [
                                    new vscode.LanguageModelTextPart(
                                        `Tool '${call.name}' failed: ${toolErr && toolErr.message || toolErr}`
                                    )
                                ])
                            ]));
                        }
                    }
                }

                response.markdown(`\n\n_(Tool-loop iteration cap reached.)_`);
            } catch (e) {
                response.markdown(`\n\n**Orbit participant error:** ${e && e.message || e}`);
                console.error('[orbit] participant error:', e);
            }
        });
        participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'public', 'pictures', 'icons', 'participant', 'orbit.jpg');
        context.subscriptions.push(participant);

        // Diagnostic: log what VS Code thinks our manifest contributes look like.
        try {
            const ext = vscode.extensions.getExtension('BlackPageDigital.orbit');
            const contributes = ext && ext.packageJSON && ext.packageJSON.contributes;
            const mcp = contributes && contributes.mcpServerDefinitionProviders;
            console.log('[orbit] packageJSON.contributes keys:', contributes && Object.keys(contributes));
            console.log('[orbit] mcpServerDefinitionProviders:', JSON.stringify(mcp));
        } catch (e) {
            console.log('[orbit] manifest inspect failed:', e && e.message);
        }

        try {
            const mcpProvider = vscode.lm.registerMcpServerDefinitionProvider('orbitBackend', {
                provideMcpServerDefinitions() {
                    return [
                        new vscode.McpHttpServerDefinition(
                            '2300-backend',
                            vscode.Uri.parse(`http://${mcpHost}:15072/mcpservice/v1/mcp`)
                        )
                    ];
                }
            });
            context.subscriptions.push(mcpProvider);
            console.log('[orbit] MCP provider registered');
        } catch (e) {
            console.error('[orbit] MCP provider registration failed:', e && e.message);
        }
    }

    function deactivate() {
        if (server) {
            server.close();
            server = null;
        }
    }

    return { activate, deactivate };
};
