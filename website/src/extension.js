const vscode = require('vscode');
const http = require('http');
const path = require('path');
const fs = require('fs');

let server = null;

function activate(context) {
    const startCmd = vscode.commands.registerCommand('orbit.start', async () => {
        if (server) {
            const addr = server.address();
            const url = `http://localhost:${addr.port}/lam.html`;
            await vscode.commands.executeCommand('simpleBrowser.show', url);
            return;
        }

        const app = require(path.join(context.extensionPath, 'app'));
        server = http.createServer(app);

        server.listen(8089, () => {
            const addr = server.address();
            const url = `http://localhost:${addr.port}/lam.html`;
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

    const participant = vscode.chat.createChatParticipant('orbit.orbit', async (request, context, response, token) => {
        const messages = [
            vscode.LanguageModelChatMessage.User(agentInstructions),
            vscode.LanguageModelChatMessage.User(request.prompt)
        ];

        const chatResponse = await request.model.sendRequest(messages, {}, token);
        for await (const fragment of chatResponse.text) {
            response.markdown(fragment);
        }
    });
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'public', 'pictures', 'icons', 'participant', 'orbit.jpg');
    context.subscriptions.push(participant);

    const mcpProvider = vscode.lm.registerMcpServerDefinitionProvider('orbit.2300-backend', {
        provideMcpServerDefinitions() {
            return [
                new vscode.McpHttpServerDefinition(
                    '2300-backend',
                    vscode.Uri.parse('http://192.168.1.140:15072/mcpservice/v1/mcp')
                )
            ];
        }
    });
    context.subscriptions.push(mcpProvider);
}

function deactivate() {
    if (server) {
        server.close();
        server = null;
    }
}

module.exports = { activate, deactivate };
