// Snowglobe server for the Orbit webserver.
//
// The Snowglobe wire protocol (today implemented by VW Snowglobe
// servers like the lamCTC image at 192.168.1.140:19070) carries
// gzipped binary frames over a WebSocket:
//
//   gzip( instructionByte || varintInt id || point(x, y) extent || ... )
//
// where varintInt is the Smalltalk-side LargeInteger-on-the-wire
// encoding (sizeByte: high bit = negative; low 7 bits = magnitude byte
// count; followed by little-endian magnitude bytes), and a point is
// two varintInts. See `JSReadStream` in Caffeine for the canonical
// decoder.
//
// Squeak/Caffeine's in-page `Snowglobe` is the CLIENT: it opens an
// outbound WebSocket, decodes frames, manages canvases, and ships
// input events back. This server lets Orbit (Node) take the place of
// VW for that same protocol, owning its own canvases and pushing
// frames to Squeak. The first milestone is just StartSession echo.

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

function decodeFrame(rawBinary) {
    const inflated = zlib.gunzipSync(rawBinary);
    const posRef = { pos: 0 };
    const instruction = inflated[posRef.pos++];
    const id          = readVarint(inflated, posRef);
    const extent      = readPoint(inflated, posRef);
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

// ----- server ----------------------------------------------------------------

class SnowglobeServer {
    constructor(opts) {
        opts = opts || {};
        this.wsPath = opts.wsPath || '/snowglobe';
        this.log    = opts.log    || ((...a) => console.log('[snowglobe]', ...a));
        this.error  = opts.error  || ((...a) => console.error('[snowglobe]', ...a));
        this.clients = new Set();
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
            wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(ws));
        });
    }

    _onConnection(ws) {
        this.log('client connected');
        this.clients.add(ws);
        ws.on('message', (data) => this._onMessage(ws, data));
        ws.on('close', () => { this.clients.delete(ws); this.log('client closed'); });
        ws.on('error', (e) => this.error('ws error:', e && e.message));
    }

    _onMessage(ws, data) {
        // Squeak is both the publisher (Morphic damage emitter) and
        // the consumer (Snowglobe client worker) of every frame; Orbit
        // is a pure echo server. We bounce the raw inbound bytes back
        // verbatim. We also decode just enough of the header to log
        // what was seen, ignoring decode errors.
        try {
            const frame = decodeFrame(data);
            this.log('echo', frame.instructionName,
                'id=' + frame.id,
                'extent=' + frame.extent.x + 'x' + frame.extent.y,
                'payload=' + frame.payload.length + 'b');
        } catch (_) {
            this.log('echo (undecoded)', (data && data.length) + 'b');
        }
        try {
            ws.send(data, { binary: true });
        } catch (e) {
            this.error('echo send failed:', e && e.message);
        }
    }
}

module.exports = {
    SnowglobeServer,
    INSTR,
    encodeFrame,
    decodeFrame,
    readVarint,
    writeVarint,
    readPoint,
    writePoint,
};
