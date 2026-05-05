// orbit-clipboard.js
//
// Make copy/paste work in SqueakJS canvas-only UIs hosted in the VS Code
// Integrated Browser.
//
// Why this is needed:
//
// 1. squeak.js installs `document.oncopy`/`document.onpaste` that bridge
//    the SqueakJS image's clipboard primitives to the system clipboard
//    via `evt.clipboardData`. Those handlers only run when the browser
//    fires native `copy`/`paste` events.
//
// 2. Browsers fire those events only when there's a focused editable
//    element. SqueakJS draws everything to a single <canvas>.
//
// 3. The VS Code Integrated Browser swallows native Cmd+C/X/V keyboard
//    shortcuts and never dispatches the corresponding clipboard events,
//    even with a focused textarea.
//
// 4. squeak.js's `executeClipboardCopy` does a 500ms synchronous busy-wait
//    inside the copy event. When invoked via execCommand('copy'), this
//    long pause breaks the browser's OS-level clipboard write, so the
//    text never reaches the system clipboard.
//
// What we do:
//
// - Maintain a hidden, always-focused <textarea> in the iframe document.
//
// - On Cmd/Ctrl+C/X (capture phase):
//     a. Call `display.executeClipboardCopy('c'|'x', timestamp)` directly
//        to drive Squeak's image-level copy and retrieve the text.
//     b. Put the text in the textarea, select all.
//     c. Temporarily null out `document.oncopy` (so Squeak's slow handler
//        doesn't run again).
//     d. Call `execCommand('copy')` to write the textarea content to the
//        system clipboard via the browser's standard pipeline.
//     e. Restore `document.oncopy`.
//
// - On Cmd/Ctrl+V: the VS Code Integrated Browser swallows native Cmd+V
//     entirely (no paste event fires) and refuses
//     navigator.clipboard.readText permission. We GET /clipboard from
//     the extension's express server, which calls
//     vscode.env.clipboard.readText() on the host side, and feed the
//     result to display.executeClipboardPaste(text, timestamp).
//
// Keyboard input still reaches SqueakJS because squeak.js's document-level
// keydown handlers preventDefault() character keys; the focused textarea
// never accumulates user-typed text.

(function () {
  'use strict';

  function installInIframe(iwin) {
    if (!iwin) return;
    var idoc = iwin.document;
    if (!idoc || !iwin.display || !idoc.body) return;
    if (idoc.__orbitClipboardSetup) return;
    idoc.__orbitClipboardSetup = true;

    var ta = idoc.createElement('textarea');
    ta.id = '__orbit_clipboard_target';
    ta.value = ' ';
    ta.setAttribute('aria-hidden', 'true');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.tabIndex = -1;
    // Note: we do NOT set pointer-events:none or opacity:0 on the textarea
    // because some clipboard pipelines refuse to act on offscreen/invisible
    // editables. Position it offscreen but keep it "real".
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:10px;height:10px;z-index:-1;';
    idoc.body.appendChild(ta);

    function refocus() {
      // Don't grab focus if it currently belongs to outer-page UI (e.g. a
      // <morphic-window> hosting a remote Smalltalk image). The hidden
      // textarea is only useful when the user is interacting with the
      // SqueakJS canvas inside this iframe.
      try {
        var topDoc = iwin.top && iwin.top.document;
        if (topDoc && topDoc.activeElement && topDoc.activeElement.tagName !== 'IFRAME') return;
      } catch (_) { /* cross-origin: skip */ }
      try {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(0, ta.value.length);
      } catch (_) {}
    }

    function reset() {
      ta.value = ' ';
      refocus();
    }

    refocus();

    var canvas = idoc.getElementById('squeak');
    if (canvas) {
      var grab = function () { setTimeout(refocus, 0); };
      canvas.addEventListener('mousedown', grab, true);
      canvas.addEventListener('mouseup', grab, true);
      canvas.addEventListener('click', grab, true);
    }

    // Defensive dedup: if multiple keydown listeners ever pile up (e.g. from
    // hot-reloads during development), several will race to call
    // executeClipboardPaste and executeClipboardCopy with the same event
    // timestamp. Wrap each primitive once to ignore back-to-back duplicate
    // calls for the same timestamp.
    if (!iwin.display.__orbitClipboardDedupApplied) {
      iwin.display.__orbitClipboardDedupApplied = true;
      var origPaste = iwin.display.executeClipboardPaste.bind(iwin.display);
      var lastPasteTs = -1;
      iwin.display.executeClipboardPaste = function (text, ts) {
        if (ts === lastPasteTs) return;
        lastPasteTs = ts;
        return origPaste(text, ts);
      };
      var origCopy = iwin.display.executeClipboardCopy.bind(iwin.display);
      var lastCopyTs = -1;
      var lastCopyResult;
      iwin.display.executeClipboardCopy = function (key, ts) {
        if (ts === lastCopyTs) return lastCopyResult;
        lastCopyTs = ts;
        lastCopyResult = origCopy(key, ts);
        return lastCopyResult;
      };
      // Same hazard for synthesized Ctrl+letter keypresses: dedup by timestamp.
      var origOnKeypress = idoc.onkeypress;
      var lastKpTs = -1;
      idoc.onkeypress = function (evt) {
        if (evt && evt.timeStamp === lastKpTs) return;
        if (evt) lastKpTs = evt.timeStamp;
        return origOnKeypress.call(this, evt);
      };
    }

    function doCopy(key, timestamp) {
      // Step 1: drive Squeak's internal copy primitive directly
      var text;
      try {
        text = iwin.display.executeClipboardCopy(key, timestamp);
      } catch (err) {
        console.warn('orbit-clipboard: executeClipboardCopy threw', err);
        return;
      }
      if (typeof text !== 'string' || text.length === 0) return;

      // Step 2: stage text in textarea
      ta.value = text;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(0, ta.value.length);

      // Step 3: bypass squeak's slow oncopy and run plain execCommand
      var saved = idoc.oncopy;
      idoc.oncopy = null;
      var ok;
      try {
        ok = idoc.execCommand('copy');
      } catch (err) {
        ok = false;
        console.warn('orbit-clipboard: execCommand copy threw', err);
      } finally {
        idoc.oncopy = saved;
      }
      if (!ok) console.warn('orbit-clipboard: execCommand copy returned false');

      // Restore textarea state
      setTimeout(reset, 0);
    }

    // Cmd+V handling: the VS Code Integrated Browser swallows native
    // Cmd+V entirely (no paste event fires) and refuses
    // navigator.clipboard.readText permission. Instead we ask the
    // extension's webserver, which uses vscode.env.clipboard.
    function doPaste(timestamp) {
      fetch('/clipboard', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j || typeof j.text !== 'string') return;
          try { iwin.display.executeClipboardPaste(j.text, timestamp); }
          catch (err) { console.warn('orbit-clipboard: executeClipboardPaste threw', err); }
        })
        .catch(function (err) {
          console.warn('orbit-clipboard: /clipboard fetch failed', err);
        });
    }

    function dispatch(e) {
      var meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // Guard against duplicate listeners (e.g. from hot-reloads): each
      // event must be processed at most once across all stacked dispatchers.
      if (e.__orbitClipboardHandled) return;
      e.__orbitClipboardHandled = true;
      var k = (e.key || '').toLowerCase();
      if (k === 'c') {
        e.preventDefault();
        doCopy('c', e.timeStamp);
      } else if (k === 'x') {
        e.preventDefault();
        doCopy('x', e.timeStamp);
      } else if (k === 'v') {
        e.preventDefault();
        doPaste(e.timeStamp);
      } else if (e.ctrlKey && !e.metaKey && k.length === 1 && k >= 'a' && k <= 'z') {
        // Chromium does not fire a `keypress` event for Ctrl+letter, so
        // squeak.js's `document.onkeypress` handler (the only path that
        // delivers Ctrl+letter to the Smalltalk image) never runs. Synthesize
        // a call to it directly with the Unix-style control charCode (a=1..z=26).
        e.preventDefault();
        e.stopPropagation();
        try {
          idoc.onkeypress({
            charCode: k.charCodeAt(0) - 96,
            ctrlKey: true,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: false,
            timeStamp: e.timeStamp,
            preventDefault: function () {},
            stopPropagation: function () {},
          });
        } catch (err) {
          console.warn('orbit-clipboard: synthetic Ctrl+letter dispatch failed', err);
        }
      }
    }

    // Route through a single live dispatcher stored on the document, so that
    // any stale listeners left over from earlier installs still funnel into
    // the current implementation rather than running their own copies.
    idoc.__orbitClipboardDispatch = dispatch;
    if (!idoc.__orbitClipboardListenerInstalled) {
      idoc.__orbitClipboardListenerInstalled = true;
      idoc.addEventListener('keydown', function (e) {
        var fn = idoc.__orbitClipboardDispatch;
        if (fn) fn(e);
      }, true);
    }

    // Periodic safety net (only one across reinstalls).
    // Only steal focus back when the iframe still owns focus — otherwise we'd
    // pull focus away from outer-page elements (e.g. <morphic-window>s showing
    // a remote Smalltalk image), preventing them from receiving keystrokes.
    if (idoc.__orbitClipboardSafetyInterval) {
      iwin.clearInterval(idoc.__orbitClipboardSafetyInterval);
    }
    idoc.__orbitClipboardSafetyInterval = iwin.setInterval(function () {
      // window.top.document.activeElement is the outermost focused element;
      // when focus is on something outside the iframe, it won't be the iframe.
      try {
        var topDoc = iwin.top && iwin.top.document;
        if (topDoc && topDoc.activeElement && topDoc.activeElement.tagName !== 'IFRAME') return;
      } catch (_) { /* cross-origin: skip */ }
      if (idoc.activeElement !== ta) refocus();
    }, 500);
  }

  function scanIframes() {
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      var f = iframes[i];
      try { installInIframe(f.contentWindow); } catch (_) {}
      if (!f.__orbitClipboardLoadHooked) {
        f.__orbitClipboardLoadHooked = true;
        f.addEventListener('load', function () {
          try { installInIframe(this.contentWindow); } catch (_) {}
        });
      }
    }
  }

  scanIframes();
  setInterval(scanIframes, 1000);
  try {
    new MutationObserver(scanIframes)
      .observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
