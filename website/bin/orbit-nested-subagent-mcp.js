#!/usr/bin/env node
// Minimal stdio MCP server exposing one tool, `spawnNestedSubagent`,
// which spawns another `copilot -p` subprocess with the same MCP config
// the current process is using. Depth is tracked through the env var
// ORBIT_SUBAGENT_DEPTH and capped by ORBIT_SUBAGENT_MAX_DEPTH (default 3).
//
// Wire protocol: line-delimited JSON-RPC 2.0 on stdin/stdout, per MCP
// stdio transport. Logs go to stderr only.

'use strict';

const { spawn } = require('child_process');
const readline = require('readline');

const MCP_CONFIG_PATH = process.env.ORBIT_MCP_CONFIG || '';
const CURRENT_DEPTH = parseInt(process.env.ORBIT_SUBAGENT_DEPTH || '0', 10);
const MAX_DEPTH = parseInt(process.env.ORBIT_SUBAGENT_MAX_DEPTH || '3', 10);

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function logErr(...args) {
    try {
        process.stderr.write('[orbit-nested-subagent] ' + args.map(String).join(' ') + '\n');
    } catch (_) {}
}

const TOOL = {
    name: 'spawnNestedSubagent',
    description:
        'Spawn another isolated GitHub Copilot CLI subagent. The grandchild has its own tool-dispatch harness, ' +
        'so its intermediate tool calls are not visible in the calling agent\'s output \u2014 only the final response ' +
        'returned by this tool is. Inherits the same MCP server set as the calling agent (Orbit backend, this nested-spawn tool, etc.). ' +
        `Current depth: ${CURRENT_DEPTH}; max: ${MAX_DEPTH}.`,
    inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: {
                type: 'string',
                description: 'Detailed task description for the nested subagent. It does not share the calling agent\'s context.'
            },
            model: {
                type: 'string',
                description: 'Optional Copilot CLI model name. Omit for default.'
            }
        }
    }
};

function spawnGrandchild(prompt, model) {
    const nextDepth = CURRENT_DEPTH + 1;
    if (nextDepth > MAX_DEPTH) {
        return Promise.resolve({
            isError: true,
            text:
                `Refusing to spawn nested subagent: depth ${nextDepth} exceeds ` +
                `ORBIT_SUBAGENT_MAX_DEPTH=${MAX_DEPTH}. Increase the limit or perform the work directly.`
        });
    }

    const args = [
        '-p', prompt,
        '-s',
        '--allow-all-tools',
        '--no-remote',
        '--no-color'
    ];
    if (MCP_CONFIG_PATH) {
        args.push('--additional-mcp-config', '@' + MCP_CONFIG_PATH);
    }
    if (model) {
        args.push('--model', model);
    }

    return new Promise((resolve) => {
        const env = Object.assign({}, process.env, {
            ORBIT_SUBAGENT_DEPTH: String(nextDepth)
        });

        let child;
        try {
            child = spawn('copilot', args, { env });
        } catch (e) {
            return resolve({ isError: true, text: `Failed to spawn copilot: ${e && e.message || e}` });
        }

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        child.on('error', (e) => resolve({ isError: true, text: `copilot spawn error: ${e && e.message || e}` }));
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ isError: false, text: stdout });
            } else {
                resolve({
                    isError: true,
                    text:
                        `copilot CLI exited with code ${code}\n` +
                        (stderr ? `stderr:\n${stderr}\n\n` : '') +
                        `stdout:\n${stdout}`
                });
            }
        });
    });
}

async function handleRequest(msg) {
    const { id, method, params } = msg;

    if (method === 'initialize') {
        const protocolVersion = (params && params.protocolVersion) || '2024-11-05';
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'orbit-nested-subagent', version: '0.1.0' }
            }
        };
    }

    if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: [TOOL] } };
    }

    if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (name !== TOOL.name) {
            return {
                jsonrpc: '2.0', id,
                error: { code: -32601, message: `Unknown tool: ${name}` }
            };
        }
        const prompt = args.prompt;
        if (!prompt || typeof prompt !== 'string') {
            return {
                jsonrpc: '2.0', id,
                result: {
                    isError: true,
                    content: [{ type: 'text', text: '`prompt` is required.' }]
                }
            };
        }
        const { isError, text } = await spawnGrandchild(prompt, args.model);
        return {
            jsonrpc: '2.0', id,
            result: {
                isError,
                content: [{ type: 'text', text }]
            }
        };
    }

    if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
    }

    return {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Method not found: ${method}` }
    };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch (e) {
        logErr('non-JSON input:', trimmed.slice(0, 200));
        return;
    }
    // Notifications have no id; do not reply.
    if (msg.id === undefined || msg.id === null) {
        return;
    }
    try {
        const response = await handleRequest(msg);
        send(response);
    } catch (e) {
        send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: `Internal error: ${e && e.message || e}` }
        });
    }
});

rl.on('close', () => {
    process.exit(0);
});

logErr(`started; depth=${CURRENT_DEPTH} max=${MAX_DEPTH} mcpConfig=${MCP_CONFIG_PATH || '(none)'}`);
