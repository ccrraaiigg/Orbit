// Snowglobe BROKER for the Orbit webserver.
//
// Snowglobe mirrors a system's GUI windows into the Orbit page as
// pixel-backed <morphic-window> web components, with live input. The
// wire protocol (also implemented by VW Snowglobe servers, e.g. the
// image at 192.168.1.140:19070) carries binary frames over a
// WebSocket:
//
//   <envelope> ( instructionByte || int id || point extent || ... )
//
// where an int is the Smalltalk LargeInteger-on-the-wire encoding
// (sizeByte: high bit = negative; low 7 bits = magnitude byte count;
// followed by little-endian magnitude bytes), a point is two ints, a
// byte-run is `int length || bytes`, and a bitmap is `typeByte(2) ||
// byte-run`. The display envelope is the first raw byte: 0x1F = gzip,
// 0x52 ('R') = raw (rest uncompressed); input frames are sent raw with
// no envelope (first byte is the instruction). See `JSReadStream` /
// `JSSnowglobe` and `RemoteWindow>>handleMouseEvent:` in Caffeine for
// the canonical codec, and designs/server-specs/snowglobe.md.
//
// ROLES. Two kinds of client connect to /snowglobe:
//
//   consumer — the usual in-page Caffeine `Snowglobe` client. It opens
//              the socket, sends StartSession, renders display frames
//              as <morphic-window>s, and ships input back. This is any
//              client that connects WITHOUT a ?role=producer query.
//
//   producer — a frame source that owns some windows, sends display
//              frames (MapWindow, HandleDisplayEvent, ...), and applies
//              inbound input frames. In Orbit the producer is the
//              page-side script website/public/js/orbit-snowglobe-producer.js,
//              which captures real page web components (the demo widget,
//              or the Caffeine window) and streams them. It connects
//              with ?role=producer.
//
// This server is a pure BROKER: it relays every producer frame to all
// consumers and every consumer frame to all producers. The "remote
// system" it presents is therefore the Orbit extension / page itself.
// It owns no window model and never transforms frames.

'use strict';

const zlib = require('zlib');

// Snowglobe instruction opcodes. Source: SnowglobeInstructions class
// pool in the connected Smalltalk image.
const INSTR = {
    StartSession:       1,
    HandleDisplayEvent: 2,
    HandleMouseEvent:   3,
    HandleKeyboardEvent:4,
    StopSession:        5,
    RestoreDisplay:     6,
    FullscreenOff:      7,
    ShowCursor:         8,
    HideCursor:         9,
    DrawRubberBand:    10,
    CloseWindow:       11,
    MapWindow:         12,
    UnmapWindow:       13,
    ResizeWindow:      14,
    SetWindowTitle:    15,
};
const INSTR_NAME = Object.fromEntries(
    Object.entries(INSTR).map(([k, v]) => [v, k]));

// ----- varint codec (matches JSReadStream nextInteger / nextPoint) -----------

function readVarint(buf, posRef) {
    const sizeByte = buf[posRef.pos++];
    const negative = (sizeByte & 0x80) !== 0;
    const n = sizeByte & 0x7f;
    let value = 0;
    let shift = 0;
    for (let i = 0; i < n; i++) {
        value += buf[posRef.pos++] << shift;
        shift += 8;
    }
    return negative ? -value : value;
}

function readPoint(buf, posRef) {
    const x = readVarint(buf, posRef);
    const y = readVarint(buf, posRef);
    return { x, y };
}

function writeVarint(out, value) {
    const negative = value < 0;
    let v = negative ? -value : value;
    const magnitude = [];
    while (v > 0) {
        magnitude.push(v & 0xff);
        v = Math.floor(v / 256);
    }
    out.push((negative ? 0x80 : 0x00) | magnitude.length);
    for (const b of magnitude) out.push(b);
}

function writePoint(out, p) {
    writeVarint(out, p.x | 0);
    writeVarint(out, p.y | 0);
}

// ----- frame helpers ---------------------------------------------------------

// Strip the display envelope (0x1F gzip / 0x52 raw). Input frames have
// no envelope; their first byte is a small instruction opcode, so we
// pass them through unchanged.
function unwrapFrame(rawBinary) {
    const buf = Buffer.isBuffer(rawBinary) ? rawBinary : Buffer.from(rawBinary);
    if (buf.length === 0) return buf;
    if (buf[0] === 0x1f) return zlib.gunzipSync(buf);
    if (buf[0] === 0x52) return buf.subarray(1);
    return buf; // raw input frame (no envelope)
}

// Decode just the header (instruction, id, and the point that always
// follows id) for logging/inspection. Tolerates any envelope and never
// throws on a short/odd frame.
function decodeFrame(rawBinary) {
    let inflated;
    try { inflated = unwrapFrame(rawBinary); }
    catch (_) { inflated = Buffer.isBuffer(rawBinary) ? rawBinary : Buffer.from(rawBinary); }
    const posRef = { pos: 0 };
    const instruction = inflated[posRef.pos++];
    let id = 0, extent = { x: 0, y: 0 };
    try { id = readVarint(inflated, posRef); } catch (_) {}
    try { extent = readPoint(inflated, posRef); } catch (_) {}
    return {
        instruction,
        instructionName: INSTR_NAME[instruction] || ('#' + instruction),
        id,
        extent,
        payload: inflated.slice(posRef.pos),
        raw: inflated,
    };
}

// Build a frame body (uncompressed bytes) with the standard header.
// Extra payload bytes (Buffer or array) are appended verbatim.
function buildFrameBody(instruction, id, extent, extraPayload) {
    const out = [instruction & 0xff];
    writeVarint(out, id | 0);
    writePoint(out, extent || { x: 0, y: 0 });
    let body = Buffer.from(out);
    if (extraPayload && extraPayload.length) {
        body = Buffer.concat([body, Buffer.from(extraPayload)]);
    }
    return body;
}

function encodeFrame(instruction, id, extent, extraPayload) {
    return zlib.gzipSync(buildFrameBody(instruction, id, extent, extraPayload));
}

// ----- broker ----------------------------------------------------------------

class SnowglobeServer {
    constructor(opts) {
        opts = opts || {};
        this.wsPath = opts.wsPath || '/snowglobe';
        this.log    = opts.log    || ((...a) => console.log('[snowglobe]', ...a));
        this.error  = opts.error  || ((...a) => console.error('[snowglobe]', ...a));
        // Every connection, plus role-partitioned views for relaying.
        this.clients   = new Set();
        this.producers = new Set();
        this.consumers = new Set();
    }

    attachToHttpServer(server) {
        const { WebSocketServer } = require('ws');
        const wss = new WebSocketServer({ noServer: true });
        this.wss = wss;

        server.on('upgrade', (req, socket, head) => {
            let url;
            try { url = new URL(req.url, 'http://localhost'); }
            catch (_) { return; }
            if (url.pathname !== this.wsPath) return;
            const role = url.searchParams.get('role') === 'producer'
                ? 'producer' : 'consumer';
            wss.handleUpgrade(req, socket, head,
                (ws) => this._onConnection(ws, role));
        });
    }

    _onConnection(ws, role) {
        ws._snowglobeRole = role;
        this.clients.add(ws);
        (role === 'producer' ? this.producers : this.consumers).add(ws);
        this.log(`${role} connected `
            + `(${this.producers.size} producer(s), ${this.consumers.size} consumer(s))`);

        ws.on('message', (data) => this._relay(ws, data));
        ws.on('close', () => {
            this.clients.delete(ws);
            this.producers.delete(ws);
            this.consumers.delete(ws);
            this.log(`${role} closed`);
        });
        ws.on('error', (e) => this.error('ws error:', e && e.message));
    }

    // Relay a frame to the opposite role. Display frames (producer ->
    // consumers) and input frames (consumer -> producers) are forwarded
    // verbatim; the broker owns no window state and never rewrites them.
    // A consumer's StartSession simply reaches the producer, which
    // remaps and repaints so late-joining consumers catch up.
    _relay(fromWs, data) {
        const targets = fromWs._snowglobeRole === 'producer'
            ? this.consumers : this.producers;
        this._logRelay(fromWs._snowglobeRole, targets.size, data);
        for (const ws of targets) {
            if (ws.readyState !== ws.OPEN) continue;
            try { ws.send(data, { binary: true }); }
            catch (e) { this.error('relay send failed:', e && e.message); }
        }
    }

    // Cheap relay logging: never decompress on the hot path, and skip
    // the high-rate HandleDisplayEvent paint frames so the log stays
    // readable. Logs window lifecycle and input frames only.
    _logRelay(role, targetCount, data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length === 0) return;
        const b0 = buf[0];
        if (b0 === 0x1f) return; // gzipped display frame; don't inflate just to log
        const body = b0 === 0x52 ? buf.subarray(1) : buf;
        const instr = body[0];
        if (instr === INSTR.HandleDisplayEvent) return; // per-paint flood
        const name = INSTR_NAME[instr] || ('#' + instr);
        this.log(`relay ${role}->${targetCount} ${name} (${buf.length}b)`);
    }
}

module.exports = {
    SnowglobeServer,
    INSTR,
    INSTR_NAME,
    encodeFrame,
    decodeFrame,
    unwrapFrame,
    readVarint,
    writeVarint,
    readPoint,
    writePoint,
};
