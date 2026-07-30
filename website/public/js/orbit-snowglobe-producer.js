// orbit-snowglobe-producer.js — a page-side Snowglobe *producer*.
//
// The Snowglobe broker in the Orbit extension (website/src/snowglobe-server.js)
// relays frames between producers and consumers. This script is the
// reference producer: it captures real page web components as Snowglobe
// windows, streams their pixels as display frames, and applies inbound
// input frames back onto them. The usual in-page Caffeine `Snowglobe`
// client is the consumer, so a captured widget appears — live and
// interactive — inside a Caffeine-drawn <morphic-window> mirror.
//
// Wire format is exactly what the Caffeine decoder expects
// (JSReadStream / JSSnowglobe) and the Caffeine input encoder produces
// (RemoteWindow>>handleMouseEvent:); see designs/server-specs/snowglobe.md.
//
// Two transports:
//   • WebSocket (default): connects to /snowglobe?role=producer and
//     talks to the extension broker. This is the shipping path.
//   • loopback: an in-page bridge to a specific consumer WebSocket,
//     used to validate the protocol without the broker (connectToConsumer).

(function () {
    'use strict';

    const INSTR = {
        StartSession: 1, HandleDisplayEvent: 2, HandleMouseEvent: 3,
        HandleKeyboardEvent: 4, CloseWindow: 11, MapWindow: 12,
        UnmapWindow: 13, ResizeWindow: 14, SetWindowTitle: 15,
    };
    const RAW_ENVELOPE = 0x52; // 'R' — uncompressed display frame

    // ---- encoders (match Portal>>nextPut* in Caffeine) ------------------
    function putVarint(arr, value) {
        const negative = value < 0;
        let v = negative ? -value : (value | 0);
        const mag = [];
        while (v > 0) { mag.push(v & 0xff); v = Math.floor(v / 256); }
        arr.push((negative ? 0x80 : 0x00) | mag.length);
        for (const b of mag) arr.push(b);
    }
    function putPoint(arr, x, y) { putVarint(arr, x | 0); putVarint(arr, y | 0); }
    function putBool(arr, b) { arr.push(b ? 1 : 0); }
    function putBytesLen(arr, len) { putVarint(arr, len); }
    function putString(arr, str) {
        const b = new TextEncoder().encode(str);
        putVarint(arr, b.length);
        for (const c of b) arr.push(c);
    }

    // ---- decoders (match JSReadStream) ----------------------------------
    function readVarint(bytes, ref) {
        const sizeByte = bytes[ref.pos++];
        const negative = (sizeByte & 0x80) !== 0;
        const n = sizeByte & 0x7f;
        let val = 0, shift = 0;
        for (let i = 0; i < n; i++) { val += bytes[ref.pos++] << shift; shift += 8; }
        return negative ? -val : val;
    }
    function readBytes(bytes, ref) {
        const len = readVarint(bytes, ref);
        const out = bytes.subarray(ref.pos, ref.pos + len);
        ref.pos += len;
        return out;
    }
    function readString(bytes, ref) { return new TextDecoder().decode(readBytes(bytes, ref)); }

    // ---- pixel packing: canvas RGBA -> wire A,B,G,R per pixel -----------
    // The client reads a,b,g,r and paints r,g,b (alpha forced to 255).
    function packPixels(ctx, w, h) {
        const img = ctx.getImageData(0, 0, w, h).data;
        const n = w * h;
        const out = new Uint8Array(n * 4);
        for (let p = 0; p < n; p++) {
            const s = p * 4;
            out[s]     = img[s + 3]; // A (ignored by client)
            out[s + 1] = img[s + 2]; // B
            out[s + 2] = img[s + 1]; // G
            out[s + 3] = img[s];     // R
        }
        return out;
    }

    function frameFromHead(head, tail) {
        const frame = new Uint8Array(1 + head.length + (tail ? tail.length : 0));
        frame[0] = RAW_ENVELOPE;
        frame.set(head, 1);
        if (tail) frame.set(tail, 1 + head.length);
        return frame;
    }

    // A single Snowglobe window backed by a source canvas.
    class ProducerWindow {
        constructor(id, sourceEl, title) {
            this.id = id;
            this.sourceEl = sourceEl; // web component exposing .canvas / applyPointer
            this.title = title;
            this._lastSig = null;
        }
        get canvas() { return this.sourceEl.canvas || this.sourceEl; }

        mapFrame() {
            const c = this.canvas;
            const head = [INSTR.MapWindow];
            putVarint(head, this.id);
            putPoint(head, c.width, c.height);  // extent (sizes the canvas)
            putBool(head, true);                // wantsTitlebar
            putPoint(head, 0, 0);               // offsetFromParent
            putVarint(head, 0);                 // parentKey
            putString(head, this.title);        // label
            return frameFromHead(head);
        }

        displayFrame() {
            const c = this.canvas;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            const pixels = packPixels(ctx, c.width, c.height);
            const head = [INSTR.HandleDisplayEvent];
            putVarint(head, this.id);
            putPoint(head, c.width, c.height);  // fullExtent
            putPoint(head, c.width, c.height);  // extent (ImageData dims)
            putBool(head, true);                // wantsTitlebar
            putPoint(head, 0, 0);               // offsetFromParent
            putVarint(head, 0);                 // parentKey
            putString(head, this.title);        // label
            head.push(32);                      // depth (ignored)
            putPoint(head, 0, 0);               // origin (blit at 0,0)
            head.push(2);                       // bitmap type: VisualWorks
            putBytesLen(head, pixels.length);   // bitmap byte-run length
            return frameFromHead(head, pixels);
        }

        unmapFrame() {
            const head = [INSTR.UnmapWindow];
            putVarint(head, this.id);
            putPoint(head, 0, 0); // dummy point (main-thread parser reads one)
            return frameFromHead(head);
        }
    }

    class SnowglobeProducer {
        constructor() {
            this.windows = new Map(); // id -> ProducerWindow
            this._send = null;
            this._ws = null;
            this._timer = null;
            this._fps = 15;
            this._nextId = 1;
        }

        addWindow(sourceEl, opts) {
            opts = opts || {};
            const id = opts.id || this._nextId++;
            const title = opts.title || (sourceEl.windowTitle) || 'Window';
            const win = new ProducerWindow(id, sourceEl, title);
            this.windows.set(id, win);
            if (this._send) { this._send(win.mapFrame()); this._send(win.displayFrame()); }
            return id;
        }

        removeWindow(id) {
            const win = this.windows.get(id);
            if (!win) return;
            // Tell consumers to remove their mirror.
            if (this._send) { try { this._send(win.unmapFrame()); } catch (_) {} }
            this.windows.delete(id);
            // Remove the source window element (the <morphic-window> host, or
            // the source element itself) from the page.
            const el = win.sourceEl;
            const host = el && el.closest ? el.closest('morphic-window') : null;
            if (host && host.remove) host.remove();
            else if (el && el.remove) el.remove();
        }

        // Connect to the extension broker as a producer.
        connect(opts) {
            opts = opts || {};
            const origin = opts.url
                || (location.origin.replace(/^http/, 'ws') + '/snowglobe');
            const url = origin + (origin.includes('?') ? '&' : '?') + 'role=producer';
            const ws = new WebSocket(url);
            ws.binaryType = 'arraybuffer';
            this._ws = ws;
            ws.onopen = () => {
                this._send = (buf) => { if (ws.readyState === ws.OPEN) ws.send(buf); };
                this._remapAll();
                this._startLoop();
            };
            ws.onmessage = (e) => this._onInput(new Uint8Array(e.data));
            ws.onclose = () => this._stopLoop();
            return this;
        }

        // Bridge directly to a specific consumer WebSocket (a live Caffeine
        // Snowglobe client), bypassing the broker. Delivers our display
        // frames into the consumer's onmessage and intercepts the
        // consumer's input sends. For in-page protocol validation.
        connectToConsumer(consumerWs) {
            this._send = (buf) => {
                // Deliver as a Uint8Array (not a sliced ArrayBuffer): the
                // consumer's onmessage may run in a different realm (an
                // iframe), where `x instanceof ArrayBuffer` is false for a
                // foreign ArrayBuffer but `ArrayBuffer.isView(x)` is true
                // for any typed array. Passing the view hits the realm-safe
                // branch of the Caffeine receive handler.
                if (typeof consumerWs.onmessage === 'function') {
                    consumerWs.onmessage({ data: buf });
                }
            };
            const realSend = consumerWs.send && consumerWs.send.bind(consumerWs);
            consumerWs.send = (buf) => {
                let bytes;
                if (buf instanceof ArrayBuffer) bytes = new Uint8Array(buf);
                else if (ArrayBuffer.isView(buf)) bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
                else if (buf && buf.length != null) bytes = Uint8Array.from(buf);
                else return;
                this._onInput(bytes);
                // Do not forward to realSend: we are the consumer's peer.
            };
            consumerWs._realSend = realSend;
            this._remapAll();
            this._startLoop();
            return this;
        }

        _remapAll() {
            for (const win of this.windows.values()) {
                this._send(win.mapFrame());
                this._send(win.displayFrame());
            }
        }

        _startLoop() {
            this._stopLoop();
            const period = Math.max(20, Math.round(1000 / this._fps));
            this._timer = setInterval(() => {
                if (!this._send) return;
                for (const win of this.windows.values()) {
                    try { this._send(win.displayFrame()); }
                    catch (e) { console.error('[snowglobe-producer] frame failed', e); }
                }
            }, period);
        }

        _stopLoop() {
            if (this._timer) clearInterval(this._timer);
            this._timer = null;
        }

        stop() {
            this._stopLoop();
            if (this._ws) { try { this._ws.close(); } catch (_) {} this._ws = null; }
            this._send = null;
        }

        // Decode an inbound input frame and apply it. Input frames carry
        // no gzip/envelope; the Caffeine client sends them as binary
        // WebSocket frames, so the bytes arrive verbatim.
        _onInput(rawBytes) {
            if (!rawBytes || rawBytes.length === 0) return;
            const bytes = rawBytes;
            const ref = { pos: 0 };
            const instruction = bytes[ref.pos++];
            if (instruction === INSTR.StartSession) { this._remapAll(); return; }
            const id = readVarint(bytes, ref);
            const win = this.windows.get(id);
            if (instruction === INSTR.HandleMouseEvent) {
                const type = readString(bytes, ref);
                readVarint(bytes, ref);               // timeStamp
                const x = readVarint(bytes, ref);
                const y = readVarint(bytes, ref);
                // button, modifiers follow but are unused by the demo.
                if (win && win.sourceEl.applyPointer) win.sourceEl.applyPointer(type, x, y);
            } else if (instruction === INSTR.HandleKeyboardEvent) {
                readVarint(bytes, ref);               // timeStamp
                const key = bytes[ref.pos++];
                if (win && win.sourceEl.applyKey) win.sourceEl.applyKey(key);
            }
        }
    }

    // ---- convenience launcher ------------------------------------------
    const api = {
        SnowglobeProducer,
        current: null,

        // Mount the bespoke demo widget on the page and start producing.
        // The source is a first-class page window: a real <morphic-window>
        // (with a titlebar, draggable, participating in z-order/occlusion),
        // and the bespoke <snowglobe-demo-widget> is its slotted content.
        // The producer captures the widget's content canvas — not the
        // window chrome — so the Caffeine consumer wraps the same content
        // in its own <morphic-window> with its own titlebar.
        // opts: { url, mount (a <morphic-window>), consumerWs, showSource,
        //         title, left, top }
        startDemo(opts) {
            opts = opts || {};
            const title = opts.title || 'Demo Widget';
            const doc = (window.top || window).document;

            const widget = doc.createElement('snowglobe-demo-widget');
            widget.setAttribute('title', title);

            let win = opts.mount;
            if (!win) {
                win = doc.createElement('morphic-window');
                win.setAttribute('caption', title);
                win.style.position = 'fixed';
                win.style.left = (opts.left != null ? opts.left : 40) + 'px';
                win.style.top  = (opts.top  != null ? opts.top  : 80) + 'px';
                win.style.zIndex = 2147483000;
                if (opts.showSource === false) win.style.display = 'none';
                win.appendChild(widget);
                (doc.getElementById('Morphic') || doc.body).appendChild(win);
            } else {
                win.appendChild(widget);
            }
            this._sourceWindow = win;

            const producer = new SnowglobeProducer();
            this.current = producer;
            producer.addWindow(widget, { title, id: 1 });

            if (opts.consumerWs) producer.connectToConsumer(opts.consumerWs);
            else producer.connect({ url: opts.url });

            // Close wiring. Clicking the close button on EITHER the source
            // window or its Caffeine mirror removes the window everywhere
            // (unmap to consumers + remove the source element). It is a
            // delegated, capture-phase listener so it also catches the
            // mirror's <morphic-window>, which Caffeine creates and whose
            // own close handler would otherwise just revert (no tether here).
            if (this._closeHandler) doc.removeEventListener('morphic-close', this._closeHandler, true);
            this._closeHandler = (e) => {
                const el = (e.target && e.target.closest) ? e.target.closest('morphic-window') : e.target;
                if (!el) return;
                for (const [id, wdw] of producer.windows) {
                    const host = wdw.sourceEl && wdw.sourceEl.closest
                        ? wdw.sourceEl.closest('morphic-window') : null;
                    if (host === el) { e.stopPropagation(); producer.removeWindow(id); return; }
                }
                // A mirror is a bare-canvas <morphic-window> (no slotted
                // widget) whose canvas matches one of our windows.
                if (el.querySelector('snowglobe-demo-widget')) return;
                const canvas = el.querySelector('canvas');
                if (!canvas) return;
                for (const [id, wdw] of producer.windows) {
                    if (wdw.canvas.width === canvas.width && wdw.canvas.height === canvas.height) {
                        e.stopPropagation(); producer.removeWindow(id); return;
                    }
                }
            };
            doc.addEventListener('morphic-close', this._closeHandler, true);

            return producer;
        },

        stopDemo() {
            if (this._closeHandler) {
                (window.top || window).document.removeEventListener('morphic-close', this._closeHandler, true);
                this._closeHandler = null;
            }
            if (this.current) { this.current.stop(); this.current = null; }
            if (this._sourceWindow) { this._sourceWindow.remove(); this._sourceWindow = null; }
            // Back-compat: remove the old bespoke-div host if present.
            const legacy = (window.top || window).document.getElementById('snowglobe-demo-source');
            if (legacy) legacy.remove();
        },
    };

    window.OrbitSnowglobeProducer = api;
})();
