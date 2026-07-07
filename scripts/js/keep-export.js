#!/usr/bin/env node
//
// keep-export.js — export the live Keep store to a directory of
// Markdown files.
//
// Reads every note from the Keep store (which lives in the Caffeine
// SqueakJS image) over the Orbit webserver's MCP bridge, and writes a
// fresh directory containing:
//
//   <outDir>/
//     notes/<safeId>.md   one Markdown file per note: JSON-scalar YAML
//                         front-matter (id, agent, createdAt, summary,
//                         tags) + the note content as the body. This is
//                         the same projection format the live extension
//                         mirror writes to .orbit/keep/notes/ (see
//                         designs/keep-fs-persistence.md).
//     edge-tags.json      declared edge-tag forward/inverse pairs
//     manifest.json       export metadata (when, endpoint, note count)
//
// Unlike the extension's incremental mirror (which only captures
// mutations since it was installed), this script snapshots the FULL
// current store by querying it directly — so it works for notes that
// predate the mirror.
//
// Standalone: no dependencies beyond Node's stdlib. It talks to the
// Orbit webserver on loopback (default localhost:8089), where loopback
// POSTs to the MCP bridge need no bearer token.
//
// Usage:
//   node scripts/js/keep-export.js [outDir] [options]
//
// Options:
//   --host <host>       Orbit webserver host (default: localhost)
//   --port <port>       Orbit webserver port (default: 8089)
//   --endpoint <path>   MCP endpoint path (default: auto-discovered via
//                       GET /caffeine-mcp-endpoints)
//   --limit <n>         max notes to fetch (default: 1000000)
//   -h, --help          show this help
//
// If outDir is omitted, a timestamped directory
// `keep-export-<YYYYMMDD-HHMMSS>` is created in the current directory.

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

// ---- argument parsing -------------------------------------------------------

function parseArgs(argv) {
    const opts = {
        host: 'localhost',
        port: 8089,
        endpoint: null,
        limit: 1000000,
        outDir: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
        case '-h': case '--help': opts.help = true; break;
        case '--host':     opts.host = argv[++i]; break;
        case '--port':     opts.port = parseInt(argv[++i], 10); break;
        case '--endpoint': opts.endpoint = argv[++i]; break;
        case '--limit':    opts.limit = parseInt(argv[++i], 10); break;
        default:
            if (a && a[0] === '-') {
                throw new Error('unknown option: ' + a);
            }
            if (opts.outDir == null) opts.outDir = a;
            else throw new Error('unexpected extra argument: ' + a);
        }
    }
    return opts;
}

function usage() {
    // Print only the contiguous leading comment block (the file
    // header), stopping at the first non-comment line so internal
    // section dividers aren't included.
    const out = [];
    for (const raw of fs.readFileSync(__filename, 'utf8').split('\n')) {
        if (raw.startsWith('#!')) continue;      // shebang
        if (!raw.startsWith('//')) break;        // end of header block
        out.push(raw.replace(/^\/\/ ?/, ''));
    }
    console.log(out.join('\n'));
}

// ---- HTTP helpers -----------------------------------------------------------

function httpGetJson(host, port, reqPath) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host, port, path: reqPath, method: 'GET' },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        return reject(new Error(
                            `GET ${reqPath} -> HTTP ${res.statusCode}`));
                    }
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error(
                        `GET ${reqPath}: bad JSON: ${e.message}`)); }
                });
            });
        req.on('error', reject);
        req.end();
    });
}

let rpcId = 0;
function mcpRpc(host, port, endpoint, method, params) {
    const payload = JSON.stringify({
        jsonrpc: '2.0', id: ++rpcId, method, params,
    });
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host, port, path: endpoint, method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    if (res.statusCode === 202) return resolve(null);
                    if (res.statusCode !== 200) {
                        return reject(new Error(
                            `${method} -> HTTP ${res.statusCode}: ${body}`));
                    }
                    let msg;
                    try { msg = JSON.parse(body); }
                    catch (e) { return reject(new Error(
                        `${method}: bad JSON response: ${e.message}`)); }
                    if (msg.error) {
                        return reject(new Error(
                            `${method}: ${JSON.stringify(msg.error)}`));
                    }
                    resolve(msg.result);
                });
            });
        req.on('error', reject);
        req.end(payload);
    });
}

// Call an MCP tool and return its decoded result object. The bridge
// wraps tool results as { content: [{ type:'text', text: <json> }] }.
async function callTool(host, port, endpoint, name, args) {
    const result = await mcpRpc(host, port, endpoint, 'tools/call',
        { name, arguments: args || {} });
    const text = result && result.content && result.content[0]
        && result.content[0].text;
    if (typeof text !== 'string') {
        throw new Error(`tool ${name}: unexpected result shape`);
    }
    try { return JSON.parse(text); }
    catch (e) { throw new Error(`tool ${name}: result not JSON: ${e.message}`); }
}

// ---- Markdown projection ----------------------------------------------------

// Sanitize a note id for use as a filename. The true id is always
// preserved inside the note's front-matter, so the mapping is
// recoverable even when sanitization collapses distinct ids. Matches
// keepSafeId in website/src/extension-impl.js.
function safeId(id) {
    return String(id == null ? 'unnamed' : id)
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 200) || 'unnamed';
}

// Render a note's Markdown projection. JSON-encoded scalars in the
// front-matter are valid YAML flow scalars (no YAML dep, no injection).
// Matches keepNoteMarkdown in website/src/extension-impl.js.
function noteMarkdown(note) {
    const j = (v) => JSON.stringify(v == null ? '' : v);
    const tags = note && typeof note.tags === 'object' && note.tags
        ? note.tags : {};
    const lines = [
        '---',
        'id: ' + j(note && note.id),
        'agent: ' + j(note && note.agent),
        'createdAt: ' + j(note && note.createdAt),
        'summary: ' + j(note && note.summary),
        'tags: ' + JSON.stringify(tags),
        '---',
        '',
        (note && typeof note.content === 'string') ? note.content : '',
    ];
    return lines.join('\n') + '\n';
}

// ---- main -------------------------------------------------------------------

function timestampSlug(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
        '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function resolveEndpoint(opts) {
    if (opts.endpoint) return opts.endpoint;
    const disc = await httpGetJson(
        opts.host, opts.port, '/caffeine-mcp-endpoints');
    const endpoints = (disc && disc.endpoints) || [];
    if (endpoints.length === 0) {
        throw new Error(
            'no MCP endpoint registered — is the Orbit page open and ' +
            'its SqueakJS image connected? (pass --endpoint to override)');
    }
    return endpoints[0];
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { usage(); return; }
    if (!Number.isFinite(opts.port)) throw new Error('invalid --port');
    if (!Number.isFinite(opts.limit)) throw new Error('invalid --limit');

    const outDir = path.resolve(
        opts.outDir || ('keep-export-' + timestampSlug(new Date())));
    const notesDir = path.join(outDir, 'notes');

    const endpoint = await resolveEndpoint(opts);
    console.log(`Keep export: ${opts.host}:${opts.port}${endpoint} -> ${outDir}`);

    // Politeness: MCP handshake first (records lastInitializeAt on the
    // bridge; harmless if the page tolerates tool calls without it).
    try {
        await mcpRpc(opts.host, opts.port, endpoint, 'initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'keep-export', version: '1.0.0' },
        });
    } catch (e) {
        console.warn('  (initialize failed, continuing): ' + e.message);
    }

    // Enumerate the whole store: empty text + empty tag filter, newest
    // first, up to the limit.
    const query = await callTool(opts.host, opts.port, endpoint, 'keepQuery', {
        query: '', tags: '{}', limit: opts.limit,
    });
    const notes = (query && query.notes) || [];
    const total = query && typeof query.total === 'number'
        ? query.total : notes.length;
    if (notes.length < total) {
        console.warn(`  WARNING: fetched ${notes.length} of ${total} notes; ` +
            `raise --limit to capture all.`);
    }

    // Edge-tag declarations, from the orientation snapshot.
    let edgeTags = {};
    try {
        const orient = await callTool(
            opts.host, opts.port, endpoint, 'keepOrient', {});
        if (orient && orient.edgeTags && typeof orient.edgeTags === 'object') {
            edgeTags = orient.edgeTags;
        }
    } catch (e) {
        console.warn('  (keepOrient failed, edge-tags omitted): ' + e.message);
    }

    // Write everything into a fresh directory.
    fs.mkdirSync(notesDir, { recursive: true });

    const seen = new Map(); // safeId -> count, to disambiguate collisions
    let written = 0;
    for (const note of notes) {
        let name = safeId(note && note.id);
        if (seen.has(name)) {
            const n = seen.get(name) + 1;
            seen.set(name, n);
            name = `${name}~${n}`;
        } else {
            seen.set(name, 0);
        }
        fs.writeFileSync(
            path.join(notesDir, name + '.md'), noteMarkdown(note), 'utf8');
        written++;
    }

    fs.writeFileSync(
        path.join(outDir, 'edge-tags.json'),
        JSON.stringify(edgeTags, null, 2) + '\n', 'utf8');

    fs.writeFileSync(
        path.join(outDir, 'manifest.json'),
        JSON.stringify({
            exportedAt: new Date().toISOString(),
            source: `${opts.host}:${opts.port}${endpoint}`,
            noteCount: written,
            reportedTotal: total,
            edgeTagCount: Object.keys(edgeTags).length,
        }, null, 2) + '\n', 'utf8');

    console.log(`Wrote ${written} note${written === 1 ? '' : 's'} + ` +
        `${Object.keys(edgeTags).length} edge-tag` +
        `${Object.keys(edgeTags).length === 1 ? '' : 's'} to ${outDir}`);
}

main().catch((e) => {
    console.error('keep-export failed: ' + (e && e.message ? e.message : e));
    process.exit(1);
});
