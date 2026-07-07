// MCP proxying bridge for the Orbit webserver.
//
// Adapted from ../../bridge/bridge.js. Whereas the original Deno
// bridge proxies for an MCP server in a Squeak Web Worker, this module
// proxies for an MCP server hosted in the Orbit webapp page (the
// SqueakJS image running in the browser).
//
// Flow:
//   1. The page connects a WebSocket to the bridge endpoint
//      (default path: /orbit-tether). One Tether per socket.
//   2. The page announces itself by sending a Tether stringTag frame
//      containing JSON {mcp: {providing: true, endpoint: "/<path>"}}.
//      This registers the page as the MCP provider for that endpoint.
//   3. JSON-RPC POSTs to <endpoint> (with the correct Bearer token)
//      are forwarded to the page via `serviceExternalMessage:` on its
//      Tether; the byte-encoded JSON answer is decoded and returned to
//      the HTTP client.
//   4. GETs with `Accept: text/event-stream` on <endpoint> open a SSE
//      stream for server-initiated notifications. Any non-MCP,
//      non-heartbeat JSON frames from the page are broadcast on all
//      open streams.
//
// This module exports a single attach() function. Wire it in
// app-impl.js (for the express routes) and bin/www (to receive WS
// `upgrade` events from the underlying http.Server).

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

const caffeine = require('./tether');
const { readBearer, isLoopback, bearerHeaderMatches } = require('./bearer');

// --- helpers -----------------------------------------------------------------

const FAILURE = -1337;

// Keep tools that mutate the store. Calls to these are mirrored to the
// filesystem op-log + Markdown projection via the onKeepMutation hook
// (see designs/keep-fs-persistence.md). Read tools (keepGet, keepQuery,
// keepFindDeep, keepOrient) are not mirrored.
const KEEP_MUTATION_TOOLS = new Set([
    'keepPut', 'keepTag', 'keepRemove',
    'keepNow', 'keepArchive', 'keepDeclareEdgeTag'
]);

// Does this tools/call mutate the Keep store? keepNow is a read unless
// it carries `content` to write into the shared `now` blackboard.
function isKeepMutationCall(params) {
    if (!params || !KEEP_MUTATION_TOOLS.has(params.name)) return false;
    if (params.name === 'keepNow') {
        const a = params.arguments || {};
        return a.content != null;
    }
    return true;
}

function response(id, content) {
    return { ...{ jsonrpc: '2.0', id }, ...content };
}
function result(id, content) {
    return response(id, { result: content });
}
function output(id, content) {
    let payload = content;
    if (typeof payload === 'object') payload = JSON.stringify(payload);
    return response(id, {
        result: {
            content: [{ type: 'text', text: payload }],
            isError: false
        }
    });
}

function objectFromTetherEncodedJSON(bytes) {
    // The Smalltalk side answers with a tether-encoded string: a
    // 4-byte tag, a 4-byte length, then UTF-16 code points. Strip the
    // 8-byte prefix and decode. We build the string in a loop rather
    // than spreading into String.fromCharCode, which would RangeError
    // on payloads larger than ~125K bytes (the JS arg-count limit).
    const tail = bytes.slice(8);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < tail.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, tail.slice(i, i + CHUNK));
    }
    return JSON.parse(s);
}

function objectRefFromTetherAnswer(bytes) {
    // An object-reference answer is a single tether-encoded word:
    // (exposureHash + otherMarkerBase), big-endian. Wrap the bare
    // hash in an OtherMarker so it can be used as a message-send
    // receiver. Returns null if the answer isn't an object reference.
    if (!bytes || bytes.length < 4) return null;
    const word = ((bytes[0] << 24) | (bytes[1] << 16)
                  | (bytes[2] << 8) | bytes[3]) >>> 0;
    if (word < caffeine.otherMarkerBase) return null;
    return new caffeine.OtherMarker(word - caffeine.otherMarkerBase);
}

// --- the bridge --------------------------------------------------------------

class CaffeineBridge {
    constructor(opts) {
        opts = opts || {};
        this.wsPath        = opts.wsPath || '/orbit-tether';
        this.bearer        = opts.bearer || readBearer(opts.extensionPath);
        this.log           = opts.log   || ((...a) => console.log('[caffeine-bridge]', ...a));
        this.error         = opts.error || ((...a) => console.error('[caffeine-bridge]', ...a));

        // endpoint -> tether
        this.mcpServers = new Map();

        // Called whenever the set of providing tethers changes.
        // Hook used by extension-impl to refire VS Code's MCP
        // definition provider.
        this.onProvidersChanged = opts.onProvidersChanged || (() => {});

        // Called for every `evaluate` tools/call that flows through
        // the bridge, with the call's params ({ name, arguments }).
        // Hook used by extension-impl to record an evaluate-ledger
        // marker so Caffeine evaluations show up in the Evaluate
        // ledger window just like the VisualWorks backends' do.
        this.onEvaluateCall = opts.onEvaluateCall || (() => {});

        // Called for every Keep *mutation* tools/call that flows
        // through the bridge, with (params, decodedResult). Hook used
        // by extension-impl to mirror the mutation to the on-disk Keep
        // op-log + Markdown projection under .orbit/keep/ (see
        // designs/keep-fs-persistence.md).
        this.onKeepMutation = opts.onKeepMutation || (() => {});

        // sessionId -> { stream: res, lastEventId }
        this.postSessions = new Map();
        this.getSessions  = new Map();

        // Tether registry shared with caffeine.Tether instances we
        // create. Key: WebSocket instance.
        this.tethers = new Map();

        // endpoint -> timestamp (ms) of last successful initialize
        // POST from VS Code's MCP client. Used by the extension to
        // verify that VS Code is actually connected to the bridge
        // (and not just showing stale lm.tools entries from a
        // previous session).
        this.lastInitializeAt = new Map();

        // Route low-level portal byte traces through our log so we
        // can see exactly what gets sent on the WebSocket. Use a
        // late-binding wrapper so caller-replaced this.log is honored.
        caffeine.debugPortal = (...a) => this.log(...a);
    }

    // ---- WebSocket plumbing -------------------------------------------------

    // Attach a WebSocket server to an http.Server, listening for
    // `upgrade` events whose request path matches wsPath. Uses the `ws`
    // package in noServer mode so we coexist cleanly with other
    // upgrade handlers (e.g. VSCode-extension-provided ones).
    attachToHttpServer(server) {
        const { WebSocketServer } = require('ws');
        const wss = new WebSocketServer({ noServer: true });
        this.wss = wss;

        server.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname !== this.wsPath) return;
            wss.handleUpgrade(req, socket, head, (ws) => {
                this._onConnection(ws);
            });
        });

        wss.on('connection', () => this.log('tether websocket connected'));
    }

    _onConnection(ws) {
        const tether = new caffeine.Tether(ws, this.tethers);

        // Assign an exposure hash so the peer can address us, register
        // ourselves under it, and announce ourselves to the initiating
        // tether by writing `exposureHash + otherMarkerBase` over the
        // wire. (Mirrors the workerTether announce in bridge.js's
        // websocket.onopen.) The exposureHash itself must be stored
        // WITHOUT otherMarkerBase: storeOnTether(self) writes it bare,
        // and the peer's receiver-lookup compares against that bare
        // value when dispatching subsequent message-sends.
        tether.exposureHash = Math.floor(Math.random() * 0x10000000);
        tether.expose(tether);
        this.tethers.set(ws, tether);

        ws.on('message', (data, isBinary) => this._onMessage(ws, tether, data, isBinary));
        ws.on('close',   () => this._onClose(ws, tether));
        ws.on('error',   (e) => this.error('ws error:', e.message));

        // Announce ourselves by writing our hash in OtherMarker form.
        // The peer reads `tag >= otherMarkerBase` and records
        // `tag - otherMarkerBase` as our exposureHash on its side.
        try {
            tether.send(() => tether.nextWordPut(
                tether.exposureHash + caffeine.otherMarkerBase));
        } catch (e) {
            this.error('initial announce failed:', e && e.message);
        }
    }

    _onClose(ws, tether) {
        this.tethers.delete(ws);
        let removed = false;
        for (const [endpoint, t] of this.mcpServers) {
            if (t === tether) {
                this.mcpServers.delete(endpoint);
                this.lastInitializeAt.delete(endpoint);
                removed = true;
            }
        }
        // Reject any in-flight forwarded RPCs so their HTTP clients
        // don't hang forever.
        try {
            const pending = tether && tether.outgoingMessages;
            if (pending && typeof pending.forEach === 'function') {
                const closeErr = new Error('tether websocket closed');
                for (const [uuid, resolver] of pending) {
                    try {
                        if (resolver && typeof resolver.__reject === 'function') {
                            resolver.__reject(closeErr);
                        }
                    } catch (_) {}
                    pending.delete(uuid);
                }
            }
        } catch (e) {
            this.error('error rejecting pending tether RPCs:', e && e.message);
        }
        this.log('tether websocket closed');
        if (removed) {
            try { this.onProvidersChanged(); } catch (e) { this.error(e); }
        }
    }

    _onMessage(ws, tether, data, isBinary) {
        // Wire format: every frame is a stringified JSON object. If
        // the object has a `payload` field, the value is an array of
        // tether-encoded bytes that we feed into the tether parser.
        // Other JSON shapes (pixels, heartbeat, ...) are handled
        // directly.
        const text = isBinary
            ? Buffer.from(data).toString('utf8')
            : (typeof data === 'string'
               ? data
               : Buffer.from(data).toString('utf8'));

        let frame;
        try { frame = JSON.parse(text); }
        catch (e) { this.error('non-JSON frame:', text); return; }

        if (!frame || !frame.payload) {
            // Direct JSON control message (no tether wrapping).
            return this._handleControlMessage(ws, tether, frame || {});
        }

        tether.setIncomingMessage(frame.payload);
        const tag = tether.peekWord();
        this.log('ws-in payload bytes:', frame.payload.length,
            'firstWord:', '0x' + tag.toString(16),
            'full:', Buffer.from(frame.payload).toString('hex'));

        if (tag === caffeine.tags.get('stringTag')) {
            // Tether-encoded stringTag frame whose string is a
            // stringified JSON control message.
            const s = tether.next().string;
            this.log('control:', s);
            let msg;
            try { msg = JSON.parse(s); }
            catch (e) { this.error('bad control JSON:', s); return; }
            this._handleControlMessage(ws, tether, msg);
        } else if (tag >= caffeine.otherMarkerBase) {
            // The remote is announcing its OWN exposure hash. The two
            // sides maintain DISTINCT tether identities; we must not
            // overwrite our own exposureHash. Store the peer's hash
            // separately so we can address messages to it.
            const peerHash = tag - caffeine.otherMarkerBase;
            tether.peerExposureHash = peerHash;
            this.log('peer announced exposureHash:', peerHash);
        } else {
            // message-send or answer
            tether.handleEventFrom(tether);
        }
    }

    _handleControlMessage(ws, tether, msg) {
        if (msg.mcp && msg.mcp.providing) {
            const existing = this.mcpServers.get(msg.mcp.endpoint);
            const isNew = existing !== tether;
            this.mcpServers.set(msg.mcp.endpoint, tether);
            this.log('tether providing MCP at ' + msg.mcp.endpoint
                + (isNew ? '' : ' (re-announce, ignoring)'));
            // Only fire when this endpoint isn't already bound to
            // this tether. Repeated identical announces would
            // otherwise re-trigger VS Code's "new tools" trust
            // prompt every time the page re-announces.
            if (isNew) {
                try { this.onProvidersChanged(); } catch (e) { this.error(e); }
            }
        } else if (msg.heartbeat) {
            try { ws.send('ack!'); } catch (_) {}
        } else {
            // Server-initiated notification → broadcast on all open
            // SSE GET streams.
            this._notifyAll(msg);
        }
    }

    // Return the singleton page-side Tether (the SqueakJS webapp
    // opens exactly one /orbit-tether connection).
    pageTether() {
        for (const t of this.tethers.values()) return t;
        return null;
    }

    // Fire-and-forget message-send to the page-side Tether (selector
    // with a JSON-string arg). Resolves with the raw answer bytes (we
    // ignore them on most call sites). Rejects synchronously if the
    // peer's exposureHash hasn't been announced yet.
    //
    // The page's tether is a PEER (not in our local registry), so we
    // address it with an OtherMarker wrapping its announced exposure
    // hash. Tether.sendMessage encodes the receiver as the bare hash
    // the protocol expects and supplies the timeout + rejectability
    // (__reject) that _onClose relies on.
    forwardCall(tether, selector, args) {
        if (typeof tether.peerExposureHash !== 'number') {
            return Promise.reject(new Error(
                'peer exposureHash unknown; page has not announced yet'));
        }
        return tether.sendMessage(
            new caffeine.OtherMarker(tether.peerExposureHash),
            selector, args, { timeoutMs: 30000 });
    }

    // Tell the page's SqueakJS image to roll back the effect recorded
    // for an evaluate call. VisualWorks and MCP are NOT involved: we
    // send classNamed: 'Lam2300' to the page-side Tether to obtain a
    // reference to the (SqueakJS) class, then send undo: <json> to
    // that class, where <json> is the stringified record that was
    // written to the evaluate marker file. Fire-and-forget: any error
    // handling is Squeak's responsibility.
    async signalUndo(payload) {
        const tether = this.pageTether();
        if (!tether) throw new Error('no page tether; cannot signal undo');
        const classAnswer = await this.forwardCall(
            tether, 'classNamed:', ['Lam2300']);
        const lam2300 = objectRefFromTetherAnswer(classAnswer);
        if (!lam2300) {
            throw new Error("classNamed: 'Lam2300' did not answer an object reference");
        }
        return tether.sendMessage(lam2300, 'undo:', [payload], { timeoutMs: 30000 });
    }

    // Ask the page-side SqueakJS image to snapshot its object memory
    // by sending the unary message `snapshot` to the page tether
    // itself (the peer addressed by `forwardCall`). Returns a promise
    // that resolves once the snapshot send completes. This is the one
    // sanctioned way for the agent to snapshot Caffeine, used just
    // before exporting caffeine.image/caffeine.changes during an
    // extension rebuild (see the steering file). Throws if no page
    // tether is connected.
    snapshot() {
        const tether = this.pageTether();
        if (!tether) throw new Error('no page tether; cannot snapshot');
        return this.forwardCall(tether, 'snapshot', []);
    }

    // ---- SSE plumbing -------------------------------------------------------

    _startEventStream(registry, sessionId, res) {
        res.status(200);
        res.setHeader('Content-Type',  'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection',    'keep-alive');
        res.flushHeaders && res.flushHeaders();

        const entry = { stream: res, lastEventId: 0 };
        registry.set(sessionId, entry);

        const hb = setInterval(() => {
            try { res.write(': \n\n'); }
            catch (_) { clearInterval(hb); registry.delete(sessionId); }
        }, 20_000);

        res.on('close', () => {
            clearInterval(hb);
            registry.delete(sessionId);
        });
    }

    _sendOnStream(registry, sessionId, payload) {
        const entry = registry.get(sessionId);
        if (!entry) return;
        entry.lastEventId += 1;
        const data =
            `id: ${entry.lastEventId}\n` +
            `data: ${JSON.stringify(payload)}\n\n`;
        try { entry.stream.write(data); }
        catch (_) { registry.delete(sessionId); }
    }

    _notifyAll(obj) {
        for (const sid of this.getSessions.keys()) {
            this._sendOnStream(this.getSessions, sid, obj);
        }
    }

    // ---- MCP RPC dispatch ---------------------------------------------------

    _forwardRequest(tether, request) {
        // The bridge's tether and the page's tether are DISTINCT
        // identities with distinct exposureHashes. We address the
        // page's tether with an OtherMarker wrapping its announced
        // (bare) exposure hash; Tether.sendMessage encodes the
        // receiver correctly and supplies the timeout + rejectability
        // (__reject) that _onClose relies on.
        if (typeof tether.peerExposureHash !== 'number') {
            return Promise.reject(new Error(
                'peer exposureHash unknown; page has not announced yet'));
        }
        return tether.sendMessage(
            new caffeine.OtherMarker(tether.peerExposureHash),
            'serviceExternalMessage:', [JSON.stringify(request)],
            { timeoutMs: 30000 });
    }

    async _handleHttpRpc(endpoint, msg) {
        const { id, method, params } = msg;
        const tether = this.mcpServers.get(endpoint);
        this.log('MCP method:', method, 'id:', id);

        switch (method) {
        case 'initialize':
            this.lastInitializeAt.set(endpoint, Date.now());
            return result(id, {
                protocolVersion: '2025-03-26',
                capabilities: {
                    tools:     { listChanged: true },
                    resources: { subscribe: true, listChanged: true },
                    logging:   {},
                    stream:    true,
                    sampling:  {}
                },
                serverInfo: { name: 'Caffeine', version: '0.1.0' },
                instructions: 'This MCP server has notifications to send. ' +
                              'Please request an SSE stream with HTTP GET.'
            });

        case 'resources/list': {
            const r = await this._forwardRequest(tether,
                { endpoint, action: 'resources/list' });
            return result(id, objectFromTetherEncodedJSON(r));
        }
        case 'resources/read': {
            const r = await this._forwardRequest(tether,
                { endpoint, action: 'resources/read', data: params });
            return result(id, objectFromTetherEncodedJSON(r));
        }
        case 'resources/subscribe': {
            const r = await this._forwardRequest(tether,
                { endpoint, action: 'resources/subscribe', data: params });
            return output(id, objectFromTetherEncodedJSON(r));
        }
        case 'tools/list': {
            const r = await this._forwardRequest(tether,
                { endpoint, action: 'tools/list' });
            this.log('tools/list response from tether:',
                typeof r, r && r.length);
            return result(id, objectFromTetherEncodedJSON(r));
        }
        case 'tools/call': {
            // Record an evaluate-ledger marker for evaluate calls so
            // they appear in the Evaluate ledger window (the
            // VisualWorks backends are recorded by the agent; Caffeine
            // flows through this bridge, so we record it here).
            if (params && params.name === 'evaluate') {
                try { this.onEvaluateCall(params); }
                catch (e) { this.error('onEvaluateCall failed:', e && e.message); }
            }
            const r = await this._forwardRequest(tether,
                { endpoint, action: 'tools/call', data: params });
            const decoded = objectFromTetherEncodedJSON(r);
            // Mirror Keep mutations to the on-disk op-log + Markdown
            // projection (see designs/keep-fs-persistence.md). Reads
            // and keepNow-without-content are skipped.
            if (isKeepMutationCall(params)) {
                try { this.onKeepMutation(params, decoded); }
                catch (e) { this.error('onKeepMutation failed:', e && e.message); }
            }
            return output(id, decoded);
        }
        default:
            // JSON-RPC notifications have no `id` and require no
            // response. notifications/initialized and friends fall
            // here; ack with 202 so VS Code doesn't treat it as an
            // error.
            if (id === undefined || id === null) {
                return FAILURE;
            }
            this.log('unknown MCP method:', method);
            return response(id, {
                error: { code: -32601, message: 'Method not found: ' + method }
            });
        }
    }

    // ---- Express middleware -------------------------------------------------

    // Returns a connect/express middleware that handles HTTP requests
    // for any path currently registered as an MCP endpoint. Mount it
    // before the 404 catchall.
    middleware() {
        return async (req, res, next) => {
            const endpoint = req.path;
            // Loopback-only discovery: let standalone tools (e.g. the
            // Keep export script, scripts/js/keep-export.js) find the
            // MCP endpoint(s) the page announced, without knowing the
            // image-chosen path in advance. Returns the registered
            // endpoint paths as JSON. Refused off-loopback.
            if (req.method === 'GET' && endpoint === '/caffeine-mcp-endpoints') {
                if (!isLoopback(req)) return res.status(403).end();
                res.setHeader('Content-Type', 'application/json');
                return res.status(200).send(JSON.stringify({
                    endpoints: Array.from(this.mcpServers.keys())
                }));
            }
            // Log every request that reaches the bridge middleware,
            // including ones whose path doesn't match a registered
            // MCP endpoint, so we can see whether VS Code's MCP
            // client is hitting our webserver at all.
            this.log('req', req.method, endpoint,
                'accept=' + (req.headers['accept'] || ''));
            if (!this.mcpServers.has(endpoint)) return next();

            this.log('incoming', req.method, endpoint,
                'auth=' + ((req.headers['authorization'] || '').slice(0, 16) + '…'),
                'accept=' + (req.headers['accept'] || ''));

            // GET text/event-stream → open SSE stream
            if (req.method === 'GET' &&
                (req.headers['accept'] || '').includes('text/event-stream')) {
                const sid = req.headers['mcp-session-id'] || crypto.randomUUID();
                return this._startEventStream(this.getSessions, sid, res);
            }

            if (req.method !== 'POST') return next();

            // Loopback POSTs are accepted without a bearer (the Orbit
            // webserver is loopback-only and the VS Code MCP client
            // doesn't reliably honour a static Authorization header
            // attached to the McpHttpServerDefinition). Remote POSTs
            // still require the shared bearer.
            if (!isLoopback(req)) {
                const auth = req.headers['authorization'] || '';
                if (!bearerHeaderMatches(auth, this.bearer)) {
                    return res.status(401).end();
                }
            }

            // express.json() in app-impl already parsed the body for
            // application/json.
            let msg = req.body;
            if (!msg || typeof msg !== 'object') {
                try { msg = JSON.parse(await this._readRawBody(req)); }
                catch (_) { return res.status(400).end(); }
            }

            let rpcResult;
            try {
                rpcResult = await this._handleHttpRpc(endpoint, msg);
            } catch (e) {
                this.error('RPC failed:', msg && msg.method,
                    'err:', e && (e.message || e));
                return res.status(502).end();
            }
            if (rpcResult === FAILURE) return res.status(202).end();

            res.setHeader('Content-Type', 'application/json');
            return res.status(200).send(JSON.stringify(rpcResult));
        };
    }

    _readRawBody(req) {
        return new Promise((resolve, reject) => {
            let buf = '';
            req.setEncoding('utf8');
            req.on('data', (c) => { buf += c; });
            req.on('end',  () => resolve(buf));
            req.on('error', reject);
        });
    }
}

module.exports = { CaffeineBridge, objectFromTetherEncodedJSON };
