// orbit-paste.js
//
// Exposes window.orbitPaste(text [, opts]) which sends the characters in `text`
// to the focused Morphic canvas as synthetic keyboard events
// (keydown + keypress + keyup per character). Used to simulate paste from
// Playwright: a single page.evaluate() can deliver a long block of text
// without per-key round-trips from the agent.
//
// The remote Smalltalk side derives the character from `event.keyCode` and
// `event.shiftKey` (the *physical* US-keyboard key, not the Unicode `key`
// string). Synthetic events therefore must use US-keyboard physical keyCodes.
// This module ships a US-keyboard reverse map for printable ASCII so that
// shifted symbols (+, *, |, :, etc.) render correctly.
//
// Options:
//   target   — explicit Element to target (defaults to document.activeElement
//              if it is a Morphic canvas)
//   delayMs  — per-character yield, default 0. Events are queued correctly
//              without yielding; visible rendering delay comes from the
//              remote Smalltalk's damage renderer (≈15 fps), not from us.
//
// Returns a Promise resolving with { typed, target }.

(function () {
  'use strict';

  // US-keyboard physical-key map: ch -> [keyCode, shift]
  // Keys not in this map fall through with keyCode = ch.charCodeAt(0).
  var US = {};
  function add(ch, kc, shift) { US[ch] = [kc, !!shift]; }

  // Letters
  for (var i = 0; i < 26; i++) {
    var lower = String.fromCharCode(97 + i);
    var upper = String.fromCharCode(65 + i);
    add(lower, 65 + i, false);
    add(upper, 65 + i, true);
  }
  // Digits and their shifted symbols
  var digits  = '0123456789';
  var shifted = ')!@#$%^&*(';
  for (var d = 0; d < 10; d++) {
    add(digits[d],  48 + d, false);
    add(shifted[d], 48 + d, true);
  }
  // Punctuation
  var puncts = [
    [';', ':', 186],
    ['=', '+', 187],
    [',', '<', 188],
    ['-', '_', 189],
    ['.', '>', 190],
    ['/', '?', 191],
    ['`', '~', 192],
    ['[', '{', 219],
    ['\\', '|', 220],
    [']', '}', 221],
    ["'", '"', 222],
  ];
  puncts.forEach(function (p) { add(p[0], p[2], false); add(p[1], p[2], true); });
  // Whitespace and a few control keys
  add(' ',  32, false);
  add('\n', 13, false);
  add('\r', 13, false);
  add('\t',  9, false);

  function isMorphicCanvas(el) {
    return !!el && el.tagName === 'CANVAS'
      && typeof el.id === 'string'
      && el.id.indexOf('Morphic-canvas-') === 0;
  }

  function pickTarget(explicit) {
    if (explicit) return explicit;
    var ae = document.activeElement;
    if (isMorphicCanvas(ae)) return ae;
    return document.querySelector('canvas[id^="Morphic-canvas-"]');
  }

  function initFor(ch) {
    var entry = US[ch];
    var charCode = ch.charCodeAt(0);
    var keyCode = entry ? entry[0] : charCode;
    var shift = entry ? entry[1] : false;
    var keyName = ch;
    if (ch === '\n' || ch === '\r') keyName = 'Enter';
    else if (ch === '\t') keyName = 'Tab';
    return {
      key: keyName,
      keyCode: keyCode,
      which: keyCode,
      charCode: charCode,
      shiftKey: shift,
    };
  }

  async function orbitPaste(text, opts) {
    if (typeof text !== 'string') throw new TypeError('orbitPaste: text must be a string');
    opts = opts || {};
    var delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 0;
    var target = pickTarget(opts.target);
    if (!target) throw new Error('orbitPaste: no target canvas found');

    for (var i = 0; i < text.length; i++) {
      var init = initFor(text[i]);
      init.bubbles = true;
      init.cancelable = true;
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keypress', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      if (delayMs > 0) await new Promise(function (r) { setTimeout(r, delayMs); });
    }
    return { typed: text.length, target: target.id };
  }

  window.orbitPaste = orbitPaste;
})();
