// vw-browser-tether.js
//
// Direct tether connection from the page to VisualWorks over WebSocket.
// Speaks the binary tether protocol natively — no bridge, no MCP, no
// SqueakJS relay.
//
// Usage:
//   const conn = new VWBrowserTether();
//   await conn.connect();                    // connects & creates adapter
//   const result = await conn.send('selectCategory:', ['Tether']);
//   // result is a parsed JSON object: {classes: [...]}

'use strict';

class VWBrowserTether {

  // ---- Tether protocol constants ----
  static OtherMarkerTagBase  = 1610612737;  // 0x60000001
  static SmallIntegerTagBase = 1073741824;  // 0x40000000
  static ClassTagsBase       = 536870912;   // 0x20000000
  static MessageSendTag      = 536870919;   // 0x20000007
  static UUIDTag             = 536870929;   // 0x20000011
  static MessageTag          = 536870945;   // 0x20000021
  static SymbolTag           = 536870916;   // 0x20000004
  static ArrayTag            = 536870920;   // 0x20000008
  static StringTag           = 536870917;   // 0x20000005
  static AnswerTag           = 536870941;   // 0x2000001D
  static NilTag              = 536870915;
  static TrueTag             = 536870913;
  static FalseTag            = 536870914;

  constructor(opts) {
    opts = opts || {};
    this._wsUrl = opts.url || null; // set from page ?backend= param
    this._ws = null;
    this._exposureHash = null;       // our hash (announced to VW)
    this._peerHash = null;           // VW tether's hash (announced to us)
    this._adapterHash = null;        // BrowserWebComponentAdapter's hash
    this._pendingMessages = new Map(); // uuid bytes (Uint8Array) → {resolve, reject, timer}
    this._connected = false;
    this._connectResolve = null;
    this._onPush = null;
  }

  // ---- public API ----

  /**
   * Connect to VW, exchange hashes, create the adapter.
   * Returns a promise resolving to {exposureHash, categories}.
   */
  async connect() {
    // Determine VW backend URL from page ?backend= param
    if (!this._wsUrl) {
      const params = new URLSearchParams(location.search);
      const backend = params.get('backend') || '192.168.1.140';
      this._wsUrl = `ws://${backend}:19070/tether`;
    }

    await this._openWebSocket();
    // After handshake, send createBrowserAdapter to VW's tether
    const result = await this._sendToVW(this._peerHash, 'createBrowserAdapter', []);
    this._adapterHash = result.exposureHash;
    return result;
  }

  get adapterHash() { return this._adapterHash; }

  /**
   * Connect without creating an adapter. Just exchange hashes.
   * Use sendToTether() afterward to talk to the VW Tether object directly.
   */
  async connectRaw() {
    if (!this._wsUrl) {
      const params = new URLSearchParams(location.search);
      const backend = params.get('backend') || '192.168.1.140';
      this._wsUrl = `ws://${backend}:19070/tether`;
    }
    await this._openWebSocket();
  }

  /**
   * Send a message directly to the VW Tether object (peer hash).
   * Use after connectRaw() for tether-level operations like clipboard.
   */
  async sendToTether(selector, args) {
    if (!this._connected) throw new Error('Not connected');
    return this._sendToVW(this._peerHash, selector, args || []);
  }

  /**
   * Send a message to an arbitrary exposed object by its hash.
   */
  async sendTo(receiverHash, selector, args) {
    if (!this._connected) throw new Error('Not connected');
    return this._sendToVW(receiverHash, selector, args || []);
  }

  /**
   * Send a message to the VW BrowserWebComponentAdapter.
   * Returns a promise resolving to the parsed JSON response.
   */
  async send(selector, args) {
    if (!this._connected) throw new Error('Not connected');
    if (this._adapterHash == null) throw new Error('No adapter created');
    return this._sendToVW(this._adapterHash, selector, args || []);
  }

  /**
   * Register a callback for push notifications from VW.
   */
  onPush(callback) {
    this._onPush = callback;
  }

  disconnect() {
    this._connected = false;
    if (this._ws) { this._ws.close(); this._ws = null; }
  }

  // ---- WebSocket lifecycle ----

  _openWebSocket() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this._wsUrl);
      this._ws.binaryType = 'arraybuffer';

      this._ws.onopen = () => {
        // Client speaks first: announce our exposure hash
        this._exposureHash = Math.floor(Math.random() * 0x10000000);
        const T = VWBrowserTether;
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, this._exposureHash + T.OtherMarkerTagBase);
        this._ws.send(buf);
      };

      this._ws.onmessage = async (event) => {
        const raw = new Uint8Array(event.data);
        if (raw.length < 4) return;

        // VW sends either gzip-compressed (first byte 0x1F) or
        // raw-prefixed (first byte 0x52 'R') frames.
        let bytes;
        if (raw[0] === 0x1F) {
          // gzip compressed
          bytes = await this._decompress(raw);
        } else if (raw[0] === 0x52) {
          // raw with 0x52 prefix
          bytes = raw.slice(1);
        } else {
          // assume raw
          bytes = raw;
        }

        if (bytes.length < 4) return;
        const firstWord = this._readWord(bytes, 0);
        const T = VWBrowserTether;

        if (!this._peerHash && firstWord >= T.OtherMarkerTagBase) {
          // VW announcing its exposure hash (response to our announcement)
          this._peerHash = firstWord - T.OtherMarkerTagBase;
          this._connected = true;
          resolve();
          return;
        }

        // Dispatch: answer or incoming message-send
        this._handleFrame(bytes);
      };

      this._ws.onerror = (e) => {
        console.error('[vw-tether] ws error:', e);
        reject(e);
      };

      this._ws.onclose = () => {
        this._connected = false;
        console.log('[vw-tether] ws closed');
      };
    });
  }

  // ---- Sending messages to VW ----

  _sendToVW(receiverHash, selector, args) {
    const T = VWBrowserTether;
    const TIMEOUT_MS = 30000;
    const uuid = crypto.getRandomValues(new Uint8Array(16));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingMessages.delete(uuid);
        reject(new Error(`Tether call ${selector} timed out`));
      }, TIMEOUT_MS);

      this._pendingMessages.set(uuid, { resolve, reject, timer });

      // Build frame
      const buf = [];
      // MessageSendTag
      this._putWord(buf, T.MessageSendTag);
      // UUID
      this._putWord(buf, T.UUIDTag);
      this._putWord(buf, 16);
      for (let i = 0; i < 16; i++) buf.push(uuid[i]);
      // Receiver (bare hash — VW resolves via exposedObjects keyAtValue:)
      this._putWord(buf, receiverHash);
      // MessageTag
      this._putWord(buf, T.MessageTag);
      // Selector as symbol
      this._putWord(buf, T.SymbolTag);
      const selBytes = new TextEncoder().encode(selector);
      this._putWord(buf, selBytes.length);
      for (const b of selBytes) buf.push(b);
      // Arguments as array
      this._putWord(buf, T.ArrayTag);
      this._putWord(buf, args.length);
      for (const arg of args) {
        this._encodeValue(buf, arg);
      }

      this._ws.send(new Uint8Array(buf).buffer);
    });
  }

  // ---- Receiving frames from VW ----

  _handleFrame(bytes) {
    const T = VWBrowserTether;
    const firstWord = this._readWord(bytes, 0);

    if (firstWord === T.AnswerTag) {
      // Answer frame: [AnswerTag][UUID][result...]
      this._handleAnswer(bytes);
    } else if (firstWord === T.MessageSendTag) {
      // Incoming message-send from VW (push notification)
      this._handleIncomingMessage(bytes);
    }
  }

  _handleAnswer(bytes) {
    const T = VWBrowserTether;
    let pos = 4; // skip AnswerTag

    // Read UUID
    const uuidTag = this._readWord(bytes, pos); pos += 4;
    if (uuidTag !== T.UUIDTag) return;
    const uuidSize = this._readWord(bytes, pos); pos += 4;
    const uuidBytes = bytes.slice(pos, pos + 16); pos += 16;

    // Find matching pending message
    for (const [key, entry] of this._pendingMessages) {
      if (this._uuidEquals(key, uuidBytes)) {
        this._pendingMessages.delete(key);
        clearTimeout(entry.timer);
        // Decode the result (remaining bytes)
        const resultStr = this._decodeString(bytes, pos);
        try {
          entry.resolve(JSON.parse(resultStr));
        } catch (_) {
          entry.resolve(resultStr);
        }
        return;
      }
    }
  }

  _handleIncomingMessage(bytes) {
    const T = VWBrowserTether;
    let pos = 4; // skip MessageSendTag

    // Skip UUID
    const uuidTag = this._readWord(bytes, pos); pos += 4;
    if (uuidTag === T.UUIDTag) {
      pos += 4; // size
      pos += 16; // uuid bytes
    }
    // Skip receiver hash
    pos += 4;
    // Skip MessageTag
    pos += 4;
    // Read selector (symbol)
    const symTag = this._readWord(bytes, pos); pos += 4;
    if (symTag !== T.SymbolTag) return;
    const symSize = this._readWord(bytes, pos); pos += 4;
    let selector = '';
    for (let i = 0; i < symSize; i++) {
      selector += String.fromCharCode(bytes[pos++]);
    }
    // Read args (array)
    const arrTag = this._readWord(bytes, pos); pos += 4;
    const arrSize = this._readWord(bytes, pos); pos += 4;
    const args = [];
    for (let i = 0; i < arrSize; i++) {
      const { value, newPos } = this._decodeNext(bytes, pos);
      args.push(value);
      pos = newPos;
    }

    if (this._onPush) {
      this._onPush(selector, args);
    }
  }

  // ---- Encoding ----

  _encodeValue(buf, value) {
    const T = VWBrowserTether;
    if (typeof value === 'string') {
      this._putWord(buf, T.StringTag);
      const encoded = new TextEncoder().encode(value);
      this._putWord(buf, encoded.length);
      for (const b of encoded) buf.push(b);
    } else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      this._putWord(buf, value + T.SmallIntegerTagBase);
    } else if (Array.isArray(value)) {
      this._putWord(buf, T.ArrayTag);
      this._putWord(buf, value.length);
      for (const item of value) this._encodeValue(buf, item);
    } else if (value === true) {
      this._putWord(buf, T.TrueTag);
    } else if (value === false) {
      this._putWord(buf, T.FalseTag);
    } else if (value == null) {
      this._putWord(buf, T.NilTag);
    } else {
      // Default: encode as string
      const s = String(value);
      this._putWord(buf, T.StringTag);
      const encoded = new TextEncoder().encode(s);
      this._putWord(buf, encoded.length);
      for (const b of encoded) buf.push(b);
    }
  }

  // ---- Decoding ----

  _decodeString(bytes, pos) {
    const T = VWBrowserTether;
    if (pos + 8 > bytes.length) return '';
    const tag = this._readWord(bytes, pos);
    if (tag !== T.StringTag) return '';
    const size = this._readWord(bytes, pos + 4);
    let s = '';
    for (let i = 0; i < size && (pos + 8 + i) < bytes.length; i++) {
      s += String.fromCharCode(bytes[pos + 8 + i]);
    }
    return s;
  }

  _decodeNext(bytes, pos) {
    const T = VWBrowserTether;
    if (pos + 4 > bytes.length) return { value: null, newPos: pos };
    const tag = this._readWord(bytes, pos); pos += 4;

    if (tag === T.StringTag) {
      const size = this._readWord(bytes, pos); pos += 4;
      let s = '';
      for (let i = 0; i < size && pos < bytes.length; i++) {
        s += String.fromCharCode(bytes[pos++]);
      }
      return { value: s, newPos: pos };
    }
    if (tag >= T.SmallIntegerTagBase && tag < T.OtherMarkerTagBase) {
      return { value: tag - T.SmallIntegerTagBase, newPos: pos };
    }
    if (tag === T.ArrayTag) {
      const size = this._readWord(bytes, pos); pos += 4;
      const arr = [];
      for (let i = 0; i < size; i++) {
        const r = this._decodeNext(bytes, pos);
        arr.push(r.value);
        pos = r.newPos;
      }
      return { value: arr, newPos: pos };
    }
    if (tag === T.TrueTag) return { value: true, newPos: pos };
    if (tag === T.FalseTag) return { value: false, newPos: pos };
    if (tag === T.NilTag) return { value: null, newPos: pos };
    // Unknown — skip
    return { value: null, newPos: pos };
  }

  // ---- Helpers ----

  _putWord(buf, word) {
    buf.push((word >>> 24) & 0xFF);
    buf.push((word >>> 16) & 0xFF);
    buf.push((word >>> 8) & 0xFF);
    buf.push(word & 0xFF);
  }

  _readWord(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset+1] << 16) |
            (bytes[offset+2] << 8) | bytes[offset+3]) >>> 0;
  }

  _uuidEquals(a, b) {
    for (let i = 0; i < 16; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  async _decompress(compressed) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(compressed);
    writer.close();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

window.VWBrowserTether = VWBrowserTether;
