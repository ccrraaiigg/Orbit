#!/usr/bin/env node
// Send an MCP elicitation/create request to VS Code through the Orbit
// Caffeine bridge. The bridge broadcasts any unrecognized JSON control
// frame arriving on /orbit-tether to every open MCP SSE stream, which
// is how a server-initiated JSON-RPC request reaches the MCP client.
//
//   node scripts/js/elicit.js "<message>"

const WebSocket = require('/Users/craig/me/behavior/forks/orbit/website/node_modules/ws');

const message = process.argv[2]
    || 'Please share the Integrated Browser tab with GitHub Copilot.';

const request = {
    jsonrpc: '2.0',
    id: Date.now() % 1000000,
    method: 'elicitation/create',
    params: {
        message,
        requestedSchema: {
            type: 'object',
            properties: {
                shared: {
                    type: 'boolean',
                    title: 'Integrated Browser tab shared',
                    description: 'Confirm you have shared the Orbit tab.'
                }
            },
            required: ['shared']
        }
    }
};

const ws = new WebSocket('ws://127.0.0.1:8089/orbit-tether');
ws.on('open', () => {
    ws.send(JSON.stringify(request));
    console.log('sent:', JSON.stringify(request));
    setTimeout(() => { ws.close(); process.exit(0); }, 1500);
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
