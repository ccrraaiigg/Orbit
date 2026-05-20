// Node port of bridge/tether.js. This is Caffeine's "Tether" remote
// communication protocol, used to talk to a Smalltalk system running
// in the Orbit webapp page over a WebSocket.
//
// The protocol is intentionally identical to the browser/Deno version
// in ../../bridge/tether.js. The only changes here are:
//   - no Deno globals (Deno.run, Deno.exit removed)
//   - no embedded squeak-worker; the only "remote" is the WebSocket
//     peer (the browser page)
//   - exported via module.exports for require()
//
// The browser side connects a WebSocket to the bridge endpoint. Each
// such socket gets its own Tether. Binary frames carry the tether
// protocol; the peer announces an exposureHash, then sends/receives
// message-send and answer frames keyed by UUID.

'use strict';

const caffeine = {};

caffeine.specialVariables = new Map();
caffeine.instructionsBase    = 1879048192;
caffeine.otherMarkerBase     = 1610612737;
caffeine.smallIntegerTagBase = 1073741824;
caffeine.classTagsBase       = 536870912;
caffeine.classes = new Map();
caffeine.tags    = new Map();

caffeine.tags.set('trueTag',       536870913);
caffeine.tags.set('falseTag',      536870914);
caffeine.tags.set('nilTag',        536870915);
caffeine.tags.set('stringTag',     536870917);
caffeine.tags.set('symbolTag',     536870916);
caffeine.tags.set('arrayTag',      536870920);
caffeine.tags.set('byteArrayTag',  536870939);
caffeine.tags.set('tetherTag',     536870919);
caffeine.tags.set('uuidTag',       536870929);
caffeine.tags.set('answerTag',     536870941);

caffeine.specialVariables.set(caffeine.tags.get('trueTag'),  true);
caffeine.specialVariables.set(caffeine.tags.get('falseTag'), false);
caffeine.specialVariables.set(caffeine.tags.get('nilTag'),   null);

// One Map per bridge instance (created by mcp-bridge). We keep a
// module-level fallback for callers that don't supply one, matching
// the bridge.js shape.
caffeine.tethers = new Map();

caffeine.Portal = class { constructor(websocket) {
    this.websocket = websocket;

    this.initializeOutgoingMessage = () => {
        this.outgoingMessage  = [];
        this.outgoingPosition = 0;
    };

    this.setOutgoingMessage = (message) => {
        this.outgoingMessage  = message;
        this.outgoingPosition = message.length - 1;
    };

    this.setIncomingMessage = (message) => {
        this.incomingMessage  = message;
        this.incomingPosition = 0;
    };

    this.send = () => {
        if (this.websocket) {
            const buf = Buffer.from(this.outgoingMessage);
            if (caffeine.debugPortal) {
                caffeine.debugPortal('portal.send', buf.length,
                    'bytes:', buf.toString('hex'));
            }
            try {
                this.websocket.send(buf);
            } catch (e) {
                if (caffeine.debugPortal) {
                    caffeine.debugPortal('portal.send THREW:', e && e.message);
                }
                throw e;
            }
        }
        this.initializeOutgoingMessage();
    };

    this.startMessage = () => { this.initializeOutgoingMessage(); };

    this.nextByte      = () => this.incomingMessage[this.incomingPosition++];
    this.nextCharacter = () => String.fromCharCode(this.nextByte());

    this.peekWord = () => {
        let word = 0, shift = 24;
        for (let i = this.incomingPosition; i < this.incomingPosition + 4; i++) {
            word = word + (this.incomingMessage[i] << shift);
            shift -= 8;
        }
        return word;
    };

    this.nextWord = () => {
        const word = this.peekWord();
        this.incomingPosition += 4;
        return word;
    };

    this.nextBytePut = (byte) => {
        this.outgoingMessage[this.outgoingPosition++] = byte;
    };

    this.nextWordPut = (word) => {
        this.nextBytePut((word >> 24) & 255);
        this.nextBytePut((word >> 16) & 255);
        this.nextBytePut((word >> 8)  & 255);
        this.nextBytePut(word & 255);
    };

    this.initializeOutgoingMessage();
}};

caffeine.OtherMarker = class { constructor(object, tether, tethers) {
    this.object = object;
    const match = Array.from(tethers || caffeine.tethers).filter(
        ([, value]) => value === object);
    this.exposureHash = match[0][1].exposureHash;

    this.storeOnTether = (t) => {
        t.nextWordPut(this.exposureHash + caffeine.otherMarkerBase);
    };
}};

caffeine.Tether = class { constructor(websocket, tethers) {
    this.portal = new caffeine.Portal(websocket);
    this.exposedObjects = new Map();
    this.outgoingMessages = new Map();
    this.tethers = tethers || caffeine.tethers;

    this.handleEventFrom = async function (fromTether) {
        // Relay the next incoming message, answer, or exception marker.
        let toTether;
        const tag = fromTether.nextWord();
        const exchangeID = fromTether.next();

        if (tag === caffeine.tags.get('tetherTag')) {
            // message-send
            const receiverExposureHash = fromTether.nextWord();
            // Skip MessageTag and SymbolTag.
            fromTether.nextWord();
            fromTether.nextWord();

            let selector = '';
            const size = fromTether.nextWord();
            for (let i = 0; i < size; i++) {
                selector += String.fromCodePoint(fromTether.nextByte());
            }

            const matches = Array.from(this.tethers).filter(
                ([, value]) => value.exposureHash === receiverExposureHash);

            toTether = matches.length ? matches[0][1] : fromTether;

            fromTether.outgoingMessages.set(exchangeID, selector);
        } else {
            // answer or exception marker
            let hit = 0;
            for (const tether of this.tethers.values()) {
                for (const key of tether.outgoingMessages.keys()) {
                    if (key.equals(exchangeID)) {
                        hit = 1;
                        toTether = tether;
                        const func = tether.outgoingMessages.get(key);
                        const answer = fromTether.portal.incomingMessage.slice(28);
                        if (typeof func === 'function') func(answer);
                        tether.outgoingMessages.delete(key);
                    }
                }
            }
            if (!hit) throw new Error('received unexpected remote message answer');
        }

        if (toTether !== fromTether) {
            toTether.portal.setOutgoingMessage(fromTether.portal.incomingMessage);
            toTether.portal.send();
        }
    };

    this.setIncomingMessage = (m) => this.portal.setIncomingMessage(m);
    this.nextByte           = ()  => this.portal.nextByte();
    this.nextCharacter      = ()  => this.portal.nextCharacter();
    this.nextBytePut        = (b) => this.portal.nextBytePut(b);
    this.peekWord           = ()  => this.portal.peekWord();
    this.nextWord           = ()  => this.portal.nextWord();
    this.nextWordPut        = (w) => this.portal.nextWordPut(w);

    this.storeOnTether = (sendingTether) => {
        if (this === sendingTether) {
            sendingTether.nextWordPut(this.exposureHash);
        } else {
            (new caffeine.OtherMarker(this, sendingTether, this.tethers))
                .storeOnTether(sendingTether);
        }
    };

    this.storeArray = (array) => {
        this.nextWordPut(caffeine.tags.get('arrayTag'));
        this.nextWordPut(array.length);
        array.forEach((each) => this.store(each));
    };

    this.storeByteArray = (array) => {
        this.nextWordPut(caffeine.tags.get('byteArrayTag'));
        this.nextWordPut(array.length);
        this.nextBytesPut(array);
    };

    this.storeSymbol = (symbol) => {
        this.nextWordPut(caffeine.tags.get('symbolTag'));
        this.nextWordPut(symbol.length);
        this.nextBytesPut([...symbol].map((c) => c.codePointAt(0)));
    };

    this.store = (object) => {
        if (typeof object === 'number') {
            this.nextWordPut(object + caffeine.smallIntegerTagBase);
        } else if (typeof object === 'string') {
            this.nextWordPut(caffeine.tags.get('stringTag'));
            this.nextWordPut(object.length);
            this.nextBytesPut([...object].map((c) => c.codePointAt(0)));
        } else if (object && object.constructor === Uint8Array) {
            this.storeByteArray(object);
        } else if (object && object.constructor === caffeine.Tether) {
            object.storeOnTether(this);
        } else if (object && object.constructor === caffeine.UUID) {
            object.storeOnTether(this);
        } else {
            this.storeArray(object);
        }
    };

    this.send = (block) => {
        this.portal.startMessage();
        block();
        this.portal.send();
    };

    this.nextBytesPut = (array) => {
        array.forEach((each) => this.nextBytePut(each));
    };

    this.sendMessage = (receiver, selector, args) => {
        return new Promise((resolve) => {
            const uuid = new caffeine.UUID();
            this.outgoingMessages.set(uuid, resolve);
            this.send(() => {
                this.nextBytesPut([32, 0, 0, 7]);   // a message-send
                this.store(uuid);                   // exchange UUID
                this.store(receiver);               // receiver
                this.nextBytesPut([32, 0, 0, 33]);  // a Message
                this.storeSymbol(selector);         // selector
                this.storeArray(args);              // arguments
            });
        });
    };

    this.push   = (object) => this.send(() => this.store(object));
    this.expose = (object) => this.exposedObjects.set(object.exposureHash, object);

    this.next = () => {
        const tag = this.portal.nextWord();
        const special = caffeine.specialVariables.get(tag);
        if (special !== undefined) return special;

        if (tag >= caffeine.instructionsBase) {
            throw new Error('instruction encountered when object expected');
        }
        if (tag >= caffeine.otherMarkerBase) {
            return this.exposedObjects.get(tag - caffeine.otherMarkerBase);
        }
        if (tag >= caffeine.smallIntegerTagBase) {
            return tag - caffeine.smallIntegerTagBase;
        }
        if (tag >= caffeine.classTagsBase) {
            const theClass = caffeine.classes.get(tag);
            if (!theClass) throw new Error('class not found for tag ' + tag);
            return new theClass(this);
        }
        throw new Error('exposing JavaScript objects remotely is not supported');
    };
}};

caffeine.UUID = class { constructor(tether) {
    // Node 19+ provides globalThis.crypto.getRandomValues. For older
    // Node we fall back to node:crypto.
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
        this.bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    } else {
        this.bytes = new Uint8Array(require('crypto').randomBytes(16));
    }

    this.readFromTether = (t) => {
        // Skip size word; we know the size is 16 bytes.
        for (let i = 0; i < 4; i++) t.nextByte();
        for (let i = 0; i < 16; i++) this.bytes[i] = t.nextByte();
    };

    this.storeOnTether = (t) => {
        t.nextWordPut(caffeine.tags.get('uuidTag'));
        t.nextWordPut(16);
        for (let i = 0; i < 16; i++) t.nextBytePut(this.bytes[i]);
    };

    this.equals = (id) => {
        for (let i = 0; i < 16; i++) {
            if (this.bytes[i] !== id.bytes[i]) return false;
        }
        return true;
    };

    if (tether) this.readFromTether(tether);
}};

caffeine.String = class { constructor(tether) {
    this.readFromTether = (t) => {
        let size = 0;
        for (let i = 24; i >= 0; i -= 8) size += (t.nextByte() << i);
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i++) bytes[i] = t.nextByte();
        this.string = String.fromCharCode(...bytes);
    };

    if (tether) this.readFromTether(tether);
}};

caffeine.classes.set(caffeine.tags.get('tetherTag'),  caffeine.Tether);
caffeine.classes.set(caffeine.tags.get('uuidTag'),    caffeine.UUID);
caffeine.classes.set(caffeine.tags.get('stringTag'),  caffeine.String);

module.exports = caffeine;
