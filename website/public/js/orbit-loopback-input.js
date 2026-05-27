// orbit-loopback-input.js
//
// Replays mouse and keyboard frames echoed back over the loopback
// Snowglobe WebSocket as synthesized DOM events on the Caffeine
// canvas. Designed to run *inside the squeak.html iframe* (where the
// Caffeine canvas, the JSWebSocket, and the Squeak VM all live).
//
// Architecture
// ------------
//  * SnowglobeMorphicService on the Smalltalk side calls
//    `window.__orbitLoopbackInput.install(ws)` once, passing the live
//    WebSocket object whose echoed traffic we want to inject.
//  * The service keeps `window.__orbitLoopbackInput.origins` (a
//    plain object keyed by `remoteWorldID`) populated with each
//    SystemWindow's current bounds.origin, refreshed every frame
//    tick. We use that map to translate window-local (x, y) coords
//    on the wire back into Caffeine world (canvas pixel) coords.
//  * Service-emitted frames are gzipped binary Blobs starting with
//    0x1F; we skip them. RemoteWindow-emitted frames (instructions 3
//    and 4) round-trip as TEXT because Caffeine's JS bridge
//    stringifies the outbound ByteArray — the WebSocket then UTF-8-
//    encodes that string. We undo the UTF-8 inline.
//
// Wire format (matches Portal>>nextPutInteger:, nextPutString:):
//   variable-length integer = sizeByte (high bit = negative flag,
//     low 7 bits = magnitude byte count) followed by LSB-first
//     magnitude bytes;
//   string                  = integer length prefix + raw bytes.
//
// Frame layouts:
//   instruction 3 (mouse):
//     byte instruction, int remoteWorldID, str type, int timeStamp,
//     int x, int y, byte buttons, byte modifiers
//   instruction 4 (keyboard):
//     byte instruction, int remoteWorldID, int timeStamp,
//     byte keyValue, byte keyPressType, byte modifiers, byte keyValue

(function () {
  if (window.__orbitLoopbackInput) return;

  const Squeak = window.Squeak;
  const display = window.display;

  // worldID (number) → { x, y } in Caffeine world (canvas pixel) coords.
  const origins = Object.create(null);

  // Lightweight running counters/diagnostics so we can verify the
  // pipeline from a Playwright probe without disrupting the page.
  const debug = {
    msgs: 0, blobs: 0, arrayBufs: 0, strings: 0,
    instr3: 0, instr4: 0, ignored: 0,
    lastError: null, lastDispatch: null,
  };

  function readInt(bytes, pos) {
    const sizeByte = bytes[pos++];
    const negative = (sizeByte & 0x80) !== 0;
    const count = sizeByte & 0x7f;
    let val = 0;
    let shift = 0;
    for (let i = 0; i < count; i++) {
      val += bytes[pos++] << shift;
      shift += 8;
    }
    return { val: negative ? -val : val, pos };
  }

  function readString(bytes, pos) {
    const r = readInt(bytes, pos);
    const len = r.val;
    pos = r.pos;
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[pos++]);
    return { val: s, pos };
  }

  // Inverse of Caffeine's bridge: each "byte" we want shows up as 1
  // UTF-8 byte if < 0x80, else as a 2-byte 0xC2/0xC3 prefix + low6.
  function utf8Recover(raw, len) {
    const out = new Uint8Array(len);
    let i = 0, j = 0;
    while (i < len) {
      const b = raw[i];
      if (b < 0x80) { out[j++] = b; i += 1; }
      else { out[j++] = ((b & 0x1f) << 6) | (raw[i + 1] & 0x3f); i += 2; }
    }
    return out.subarray(0, j);
  }

  // Translate Caffeine's mouse `buttons` byte (Squeak.Mouse_Red=4,
  // Yellow=2, Blue=1) into DOM MouseEvent `button` + `buttons` ints.
  function squeakButtonsToDom(squeakButtons) {
    let button = 0, buttons = 0;
    if (squeakButtons === 4)      { button = 0; buttons = 1; }
    else if (squeakButtons === 2) { button = 1; buttons = 4; }
    else if (squeakButtons === 1) { button = 2; buttons = 2; }
    return { button, buttons };
  }

  const caffeineToDomType = {
    mouseDown:   'mousedown',
    mouseUp:     'mouseup',
    mouseMove:   'mousemove',
    mouseEnter:  'mouseenter',
    mouseLeave:  'mouseleave',
    doubleclick: 'dblclick',
  };

  function getCanvas() {
    return document.getElementById('squeak');
  }

  function dispatchMouse(caffeineType, worldX, worldY, squeakButtons) {
    const canvas = getCanvas();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { button, buttons } = squeakButtonsToDom(squeakButtons);
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + worldX,
      clientY: rect.top + worldY,
      button,
      buttons,
    };
    const domType = caffeineToDomType[caffeineType] || 'mousemove';
    debug.lastDispatch = { kind: 'mouse', domType, caffeineType, x: init.clientX, y: init.clientY, button, buttons };
    canvas.dispatchEvent(new MouseEvent(domType, init));
  }

  function dispatchKey(keyValue) {
    // squeak.js wires document.onkeypress / onkeydown / onkeyup, NOT
    // canvas-level keyboard listeners (see public/js/squeakjs/squeak.js).
    // Dispatch a `keypress` event on document with charCode set, which
    // is what squeak.js reads in its onkeypress handler.
    const key = String.fromCharCode(keyValue);
    debug.lastDispatch = { kind: 'key', key, keyValue };
    document.dispatchEvent(new KeyboardEvent('keypress', {
      bubbles: true, cancelable: true,
      key, charCode: keyValue, keyCode: keyValue, which: keyValue,
    }));
  }

  function handleMouseFrame(bytes) {
    let pos = 1; // skip instruction byte
    let r;
    r = readInt(bytes, pos);    const remoteWorldID = r.val; pos = r.pos;
    r = readString(bytes, pos); const type          = r.val; pos = r.pos;
    r = readInt(bytes, pos);    /* timeStamp */                pos = r.pos;
    r = readInt(bytes, pos);    const x             = r.val; pos = r.pos;
    r = readInt(bytes, pos);    const y             = r.val; pos = r.pos;
    const squeakButtons = bytes[pos++];
    /* const modifiers = bytes[pos++]; */
    const origin = origins[remoteWorldID];
    if (!origin) return;
    dispatchMouse(type, origin.x + x, origin.y + y, squeakButtons);
  }

  function handleKeyboardFrame(bytes) {
    let pos = 1;
    let r;
    r = readInt(bytes, pos); /* remoteWorldID */ pos = r.pos;
    r = readInt(bytes, pos); /* timeStamp     */ pos = r.pos;
    const keyValue = bytes[pos++];
    /* const keyPressType = bytes[pos++]; */
    /* const modifiers    = bytes[pos++]; */
    /* const keyValue2    = bytes[pos++]; */
    dispatchKey(keyValue);
  }

  function processArrayBuffer(arrayBuffer) {
    const raw = new Uint8Array(arrayBuffer);
    if (raw.length === 0) return;
    const firstRaw = raw[0];
    // 0x1F → gzipped service-emitted frame; ignore.
    if (firstRaw !== 3 && firstRaw !== 4) { debug.ignored++; return; }
    const bytes = utf8Recover(raw, raw.length);
    if (bytes.length === 0) return;
    const inst = bytes[0];
    if (inst === 3) { debug.instr3++; try { handleMouseFrame(bytes); } catch (e) { debug.lastError = String(e); } }
    else if (inst === 4) { debug.instr4++; try { handleKeyboardFrame(bytes); } catch (e) { debug.lastError = String(e); } }
  }

  function processBlob(blob) {
    blob.arrayBuffer().then(processArrayBuffer).catch(() => {});
  }

  function onMessage(event) {
    debug.msgs++;
    const data = event.data;
    if (typeof data === 'string') {
      debug.strings++;
      // (Not currently observed, but handle it defensively: in this
      // path the wire bytes have NOT been UTF-8-mangled — each char
      // code IS the original byte.)
      const raw = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) raw[i] = data.charCodeAt(i) & 0xff;
      if (raw.length === 0) return;
      const inst = raw[0];
      if (inst === 3) handleMouseFrame(raw);
      else if (inst === 4) handleKeyboardFrame(raw);
      return;
    }
    if (data && typeof data.arrayBuffer === 'function') {
      debug.blobs++;
      processBlob(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      debug.arrayBufs++;
      processArrayBuffer(data);
    }
  }

  window.__orbitLoopbackInput = {
    origins,
    debug,

    install(ws) {
      if (!ws || ws.__orbitLoopbackInputInstalled) return;
      ws.__orbitLoopbackInputInstalled = true;
      ws.addEventListener('message', onMessage);
    },

    uninstall(ws) {
      if (!ws || !ws.__orbitLoopbackInputInstalled) return;
      ws.removeEventListener('message', onMessage);
      delete ws.__orbitLoopbackInputInstalled;
    },

    // Smalltalk calls this to refresh the origin map from
    // SnowglobeMorphicService>>reverseWindows each tick.
    setOrigins(flatPairs) {
      // flatPairs is [id1, x1, y1, id2, x2, y2, ...]. We accept either
      // a plain Array or an Array-like (JS-side typed array).
      for (const k in origins) delete origins[k];
      const n = flatPairs.length;
      for (let i = 0; i + 2 < n; i += 3) {
        origins[flatPairs[i]] = { x: flatPairs[i + 1], y: flatPairs[i + 2] };
      }
    },

    // For convenience from Smalltalk.
    setOrigin(id, x, y) { origins[id] = { x, y }; },
    clearOrigin(id) { delete origins[id]; },
    clearOrigins() { for (const k in origins) delete origins[k]; },
  };
})();
