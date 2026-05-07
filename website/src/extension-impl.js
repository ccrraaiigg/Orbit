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
    const isDevHost = devHosts.has(shortHostname);
    const mcpHost = isDevHost ? '192.168.1.140' : 'localhost';

    function orbitUrl(port) {
        const base = `http://localhost:${port}/orbit.html`;
        return isDevHost ? `${base}?backend=192.168.1.140` : base;
    }

    let server = null;

    // ---- WebDAV mount management (macOS + Windows) -----------------------
    // The Smalltalk backend exposes a WebDAV server. We mount it locally
    // so the user (and agents) can read/write Smalltalk classes as files.
    //   macOS:   /Volumes/webdav  via AppleScript `mount volume` (no sudo;
    //            volume name comes from the trailing URL path component).
    //   Windows: W:               via `net use W: <url>` (requires the
    //            WebClient service; usually running on Windows 11).
    const WEBDAV_MAC_MOUNT = '/Volumes/webdav';
    const WEBDAV_WIN_DRIVE = 'W:';

    function webdavUrl() {
        const host = isDevHost ? '192.168.1.140' : '127.0.0.1';
        return `http://${host}:19073/webdav`;
    }

    function isWebdavMounted() {
        try {
            if (process.platform === 'darwin') {
                return fs.existsSync(WEBDAV_MAC_MOUNT);
            }
            if (process.platform === 'win32') {
                return fs.existsSync(WEBDAV_WIN_DRIVE + '\\');
            }
        } catch (_) {}
        return false;
    }

    function mountWebdav() {
        return new Promise((resolve) => {
            if (isWebdavMounted()) { resolve({ alreadyMounted: true }); return; }
            const { exec } = require('child_process');
            let cmd;
            if (process.platform === 'darwin') {
                const script = `mount volume "${webdavUrl()}"`;
                cmd = `osascript -e ${JSON.stringify(script)}`;
            } else if (process.platform === 'win32') {
                // `net use` accepts http(s) URLs via the WebClient service.
                cmd = `net use ${WEBDAV_WIN_DRIVE} ${webdavUrl()} /persistent:no`;
            } else {
                resolve({ skipped: 'unsupported-platform' });
                return;
            }
            exec(cmd, (err, _stdout, stderr) => {
                if (err) {
                    vscode.window.showWarningMessage(
                        `Orbit: WebDAV mount failed: ${(stderr || err.message).trim()}`
                    );
                    resolve({ error: err });
                } else {
                    resolve({ mounted: true });
                }
            });
        });
    }

    function unmountWebdav() {
        return new Promise((resolve) => {
            if (!isWebdavMounted()) { resolve({ notMounted: true }); return; }
            const { exec } = require('child_process');
            let cmd;
            if (process.platform === 'darwin') {
                cmd = `/usr/sbin/diskutil unmount ${WEBDAV_MAC_MOUNT}`;
            } else if (process.platform === 'win32') {
                cmd = `net use ${WEBDAV_WIN_DRIVE} /delete /yes`;
            } else {
                resolve({ skipped: 'unsupported-platform' });
                return;
            }
            exec(cmd, (err, _stdout, stderr) => {
                if (err) {
                    vscode.window.showWarningMessage(
                        `Orbit: WebDAV unmount failed: ${(stderr || err.message).trim()}`
                    );
                    resolve({ error: err });
                } else {
                    resolve({ unmounted: true });
                }
            });
        });
    }

    function webdavMountEnabled() {
        try {
            return vscode.workspace
                .getConfiguration('orbit')
                .get('mountWebdav', true);
        } catch (_) { return true; }
    }

    // Output channel reused by the isolated-subagent feature so that
    // ad-hoc command runs have somewhere visible to stream stdout/stderr.
    let subagentChannel = null;
    function getSubagentChannel() {
        if (!subagentChannel) {
            subagentChannel = vscode.window.createOutputChannel('Orbit Subagent');
        }
        return subagentChannel;
    }

    // Spawn a `copilot` CLI subprocess in non-interactive mode with the
    // Orbit MCP backend injected, and resolve with its captured stdout
    // when it exits cleanly. Tool calls performed by the spawned process
    // are dispatched by that process and never reach VS Code's chat
    // activity UI; only the final text response (this function's return
    // value) does.
    function spawnIsolatedSubagent({ prompt, model, cwd, token, onStderr, extensionPath }) {
        const { spawn } = require('child_process');

        // The Copilot CLI's HTTP MCP client has no OAuth flow support;
        // it can only attach static `headers`. The Orbit backend
        // requires a Bearer token, so we read one from a gitignored
        // file and inject it. Sources, in order of precedence:
        //   1. ORBIT_MCP_BEARER environment variable
        //   2. <extensionPath>/secrets/mcp-bearer.txt
        //   3. ~/.orbit/mcp-bearer
        let bearer = (process.env.ORBIT_MCP_BEARER || '').trim();
        if (!bearer && extensionPath) {
            try {
                const p = path.join(extensionPath, 'secrets', 'mcp-bearer.txt');
                if (fs.existsSync(p)) bearer = fs.readFileSync(p, 'utf8').trim();
            } catch (_) {}
        }
        if (!bearer) {
            try {
                const p = path.join(os.homedir(), '.orbit', 'mcp-bearer');
                if (fs.existsSync(p)) bearer = fs.readFileSync(p, 'utf8').trim();
            } catch (_) {}
        }

        const orbitServer = {
            type: 'http',
            url: `http://${mcpHost}:15072/mcpservice/v1/mcp`
        };
        if (bearer) {
            orbitServer.headers = { Authorization: `Bearer ${bearer}` };
        }

        // Stdio MCP server that exposes a `spawnNestedSubagent` tool.
        // The script reads ORBIT_MCP_CONFIG from the env to discover
        // which MCP servers to re-attach in the grandchild, and
        // ORBIT_SUBAGENT_DEPTH for depth-limit enforcement.
        const nestedScript = extensionPath
            ? path.join(extensionPath, 'bin', 'orbit-nested-subagent-mcp.js')
            : null;
        const mcpServers = { 'orbit-backend': orbitServer };
        if (nestedScript && fs.existsSync(nestedScript)) {
            mcpServers['orbit-nested-subagent'] = {
                type: 'stdio',
                command: process.execPath,
                args: [nestedScript],
                tools: ['*']
            };
        }

        // Write the MCP config to a temp file. We pass it as @file so
        // children can re-attach the same servers transitively.
        const crypto = require('crypto');
        const cfgPath = path.join(
            os.tmpdir(),
            `orbit-mcp-${crypto.randomBytes(6).toString('hex')}.json`
        );
        fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers }), { mode: 0o600 });

        const args = [
            '-p', prompt,
            '-s',
            '--allow-all-tools',
            '--no-remote',
            '--no-color',
            '--additional-mcp-config', '@' + cfgPath
        ];
        if (model) {
            args.push('--model', model);
        }

        return new Promise((resolve, reject) => {
            const env = Object.assign({}, process.env, {
                ORBIT_MCP_CONFIG: cfgPath,
                ORBIT_SUBAGENT_DEPTH: process.env.ORBIT_SUBAGENT_DEPTH || '0',
                ORBIT_SUBAGENT_MAX_DEPTH: process.env.ORBIT_SUBAGENT_MAX_DEPTH || '3'
            });

            let child;
            try {
                child = spawn('copilot', args, {
                    cwd: cwd || os.homedir(),
                    env: env
                });
            } catch (e) {
                try { fs.unlinkSync(cfgPath); } catch (_) {}
                return reject(e);
            }

            let stdout = '';
            let stderr = '';
            const cancelSub = token && token.onCancellationRequested(() => {
                try { child.kill('SIGTERM'); } catch (_) {}
            });

            child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
            child.stderr.on('data', (d) => {
                const s = d.toString('utf8');
                stderr += s;
                if (onStderr) onStderr(s);
            });
            child.on('error', (e) => {
                if (cancelSub) cancelSub.dispose();
                try { fs.unlinkSync(cfgPath); } catch (_) {}
                reject(e);
            });
            child.on('close', (code) => {
                if (cancelSub) cancelSub.dispose();
                try { fs.unlinkSync(cfgPath); } catch (_) {}
                resolve({ code, stdout, stderr, hadBearer: !!bearer });
            });
        });
    }

    // Start the Orbit web server. If `openBrowser` is true, also reveal
    // the integrated browser at the orbit.html URL. Returns a promise that
    // resolves once the server is listening (or immediately if already up).
    function startServer(context, openBrowser) {
        return new Promise((resolve) => {
            if (server) {
                if (openBrowser) {
                    const addr = server.address();
                    vscode.commands.executeCommand('simpleBrowser.show', orbitUrl(addr.port));
                }
                resolve();
                return;
            }

            const app = require(path.join(context.extensionPath, 'app'));
            server = http.createServer(app);

            server.listen(8089, () => {
                const addr = server.address();
                vscode.window.showInformationMessage(`Orbit running on port ${addr.port}`);
                if (openBrowser) {
                    vscode.commands.executeCommand('simpleBrowser.show', orbitUrl(addr.port));
                }
                resolve();
            });

            server.on('error', (err) => {
                vscode.window.showErrorMessage(`Orbit server error: ${err.message}`);
                server = null;
                resolve();
            });
        });
    }

    function activate(context) {
        const startCmd = vscode.commands.registerCommand('orbit.start', async () => {
            try {
                await vscode.commands.executeCommand('orbit.stop');
            } catch (e) {
                console.error('[orbit.start] orbit.stop failed:', e && e.message);
            }
            await startServer(context, true);
            if (webdavMountEnabled()) await mountWebdav();
            // Best-effort: also start the Orbit MCP backend server so
            // the user doesn't have to start it separately. The server
            // id is `<extKey>/<label>`, where extKey is the lowercased
            // extension identifier and label is the McpHttpServerDefinition
            // label ('2300-backend').
            try {
                await vscode.commands.executeCommand(
                    'workbench.mcp.startServer',
                    'blackpagedigital.orbit-agentic-pair-programming-for-smalltalk/2300-backend',
                    { autoTrustChanges: true }
                );
            } catch (e) {
                console.error('[orbit] MCP startServer failed:', e && e.message);
            }
        });

        const stopCmd = vscode.commands.registerCommand('orbit.stop', async () => {
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
            // Close any browser tabs showing the Orbit page (Simple
            // Browser viewType `mainThreadWebview-simpleBrowser.view`,
            // or the new Integrated Browser editor with typeId
            // `workbench.editor.browser`).
            try {
                const tabsToClose = [];
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        const input = tab.input;
                        const viewType = input && input.viewType;
                        const editorId = input && (input.id || input.editorId);
                        const ctorName = input && input.constructor && input.constructor.name;
                        const label = (tab.label || '').toLowerCase();
                        const matches =
                            (viewType && /simpleBrowser|browser/i.test(viewType)) ||
                            (editorId && /browser/i.test(editorId)) ||
                            (ctorName && /browser/i.test(ctorName)) ||
                            label.includes('orbit');
                        console.log('[orbit.stop] tab', JSON.stringify({
                            label: tab.label,
                            viewType,
                            editorId,
                            ctorName,
                            inputKeys: input ? Object.keys(input) : null,
                            matches
                        }));
                        if (matches) tabsToClose.push(tab);
                    }
                }
                if (tabsToClose.length) {
                    await vscode.window.tabGroups.close(tabsToClose, true);
                }
            } catch (e) {
                console.error('[orbit] closing browser tab failed:', e && e.message);
            }
            if (webdavMountEnabled()) await unmountWebdav();
        });

        context.subscriptions.push(startCmd, stopCmd);

        // Command to open steering file from extension details page
        const openSteeringCmd = vscode.commands.registerCommand('orbit.openSteering', () => {
            const steeringPath = vscode.Uri.file(path.join(context.extensionPath, 'agents', 'orbit.agent.md'));
            vscode.commands.executeCommand('vscode.open', steeringPath);
        });
        context.subscriptions.push(openSteeringCmd);

        // Ad-hoc command: prompt the user for a task and run an isolated
        // Copilot CLI subagent. Output streams to the "Orbit Subagent"
        // output channel.
        const runSubagentCmd = vscode.commands.registerCommand('orbit.runIsolatedSubagent', async () => {
            const promptText = await vscode.window.showInputBox({
                title: 'Orbit: Run Isolated Subagent',
                prompt: 'Task for the isolated Copilot CLI subagent',
                placeHolder: 'e.g. Fetch the source of Object>>yourself via the Orbit MCP backend.',
                ignoreFocusOut: true
            });
            if (!promptText) return;

            const model = await vscode.window.showInputBox({
                title: 'Orbit: Run Isolated Subagent',
                prompt: 'Model name (optional; leave blank for default)',
                placeHolder: 'gpt-5.4',
                ignoreFocusOut: true
            });

            const ch = getSubagentChannel();
            ch.show(true);
            ch.appendLine(`\n--- ${new Date().toISOString()} ---`);
            ch.appendLine(`prompt: ${promptText}`);
            if (model) ch.appendLine(`model: ${model}`);
            ch.appendLine('');

            const cwd = (vscode.workspace.workspaceFolders
                && vscode.workspace.workspaceFolders[0]
                && vscode.workspace.workspaceFolders[0].uri.fsPath) || undefined;

            try {
                const { code, stdout, stderr, hadBearer } = await spawnIsolatedSubagent({
                    prompt: promptText,
                    model: model || undefined,
                    cwd,
                    extensionPath: context.extensionPath,
                    onStderr: (s) => ch.append(s)
                });
                if (!hadBearer) {
                    ch.appendLine('[warn] No MCP bearer token found. Set ORBIT_MCP_BEARER, or write the token to <extensionPath>/secrets/mcp-bearer.txt or ~/.orbit/mcp-bearer. The Orbit MCP server will reject the subagent with 401.');
                }
                ch.appendLine('\n=== stdout ===');
                ch.append(stdout);
                if (code !== 0) {
                    ch.appendLine(`\n[exit code ${code}]`);
                    if (stderr) {
                        ch.appendLine('=== stderr ===');
                        ch.append(stderr);
                    }
                }
            } catch (e) {
                ch.appendLine(`\n[error] ${e && e.message || e}`);
            }
        });
        context.subscriptions.push(runSubagentCmd);

        // Language model tool: invokable by the @orbit chat participant
        // (and any other Copilot Chat tool-using model) to run a task in
        // an isolated Copilot CLI subprocess. The subprocess does its own
        // tool dispatch; only the final text response is returned.
        try {
            const subagentTool = vscode.lm.registerTool('orbit_runIsolatedSubagent', {
                async prepareInvocation(_options, _token) {
                    return { invocationMessage: 'Running isolated Copilot CLI subagent…' };
                },
                async invoke(options, token) {
                    const input = (options && options.input) || {};
                    const promptText = input.prompt;
                    if (!promptText || typeof promptText !== 'string') {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart('Error: `prompt` is required.')
                        ]);
                    }
                    const cwd = (vscode.workspace.workspaceFolders
                        && vscode.workspace.workspaceFolders[0]
                        && vscode.workspace.workspaceFolders[0].uri.fsPath) || undefined;
                    try {
                        const { code, stdout, stderr, hadBearer } = await spawnIsolatedSubagent({
                            prompt: promptText,
                            model: input.model || undefined,
                            cwd,
                            extensionPath: context.extensionPath,
                            token
                        });
                        const bearerNote = hadBearer
                            ? ''
                            : '[warn] No MCP bearer token configured; the Orbit MCP server likely returned 401 and was not attached. Set ORBIT_MCP_BEARER or write the token to <extensionPath>/secrets/mcp-bearer.txt.\n\n';
                        if (code !== 0) {
                            return new vscode.LanguageModelToolResult([
                                new vscode.LanguageModelTextPart(
                                    bearerNote +
                                    `[copilot CLI exited with code ${code}]\n` +
                                    (stderr ? `stderr:\n${stderr}\n\n` : '') +
                                    `stdout:\n${stdout}`
                                )
                            ]);
                        }
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(bearerNote + stdout)
                        ]);
                    } catch (e) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(
                                `Failed to spawn copilot CLI: ${e && e.message || e}`
                            )
                        ]);
                    }
                }
            });
            context.subscriptions.push(subagentTool);
            console.log('[orbit] runIsolatedSubagent tool registered');
        } catch (e) {
            console.error('[orbit] runIsolatedSubagent tool registration failed:', e && e.message);
        }

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

        // Auto-start the web server at activation time so that browser
        // tabs left open at the Orbit URL across VS Code restarts can
        // reconnect without the user having to invoke `orbit.start`.
        // Controlled by the `orbit.autoStart` setting (default: true).
        try {
            const autoStart = vscode.workspace
                .getConfiguration('orbit')
                .get('autoStart', true);
            if (autoStart) {
                startServer(context, false).catch((e) => {
                    console.error('[orbit] auto-start failed:', e && e.message);
                });
                if (webdavMountEnabled()) {
                    mountWebdav().catch((e) => {
                        console.error('[orbit] webdav mount failed:', e && e.message);
                    });
                }
            }
        } catch (e) {
            console.error('[orbit] auto-start check failed:', e && e.message);
        }
    }

    function deactivate() {
        if (server) {
            server.close();
            server = null;
        }
        if (webdavMountEnabled()) {
            // Best-effort; deactivate cannot reliably await async work,
            // but diskutil unmount is fast enough to usually complete.
            unmountWebdav().catch(() => {});
        }
    }

    return { activate, deactivate };
};
