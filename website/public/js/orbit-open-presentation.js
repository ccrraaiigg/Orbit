// orbit-open-presentation.js
//
// Defines window.__orbitOpenPresentation(), the page-side entry point
// the Orbit panel's "presentation slides → start" button drives (via
// the SmalltalkMCPServer>>openPresentation tool, which calls this
// function over the Squeak↔JS bridge on the OUTER orbit.html window).
//
// It mounts a <morphic-window id="orbitTalk"> containing an <iframe>
// of the presentation deck (presentation/deck.html) into the outer
// document, mirroring how the digital twin is mounted on demand. If a
// presentation window already exists, it is brought to the front
// instead of duplicated. Previously this window was hardwired into
// orbit.html and opened on every page load; it is now opened only when
// requested.

(function () {
  'use strict';

  if (window.__orbitOpenPresentation) return;

  var WINDOW_ID = 'orbitTalk';

  function findPresentation() {
    return document.getElementById(WINDOW_ID);
  }

  // Raise the presentation window and, if it was collapsed/iconified
  // (the icon-manager hides windows via visibility:hidden rather than
  // removing them), restore it — so re-pressing "start" on an existing
  // presentation surfaces the one window instead of doing nothing.
  function bringToFront(mw) {
    if (!mw) return;
    try {
      if (mw.dataset) delete mw.dataset.iconManagerPendingHidden;
      if (mw.style && mw.style.visibility === 'hidden') {
        mw.style.visibility = 'visible';
        mw.style.opacity = '1';
      }
      if (typeof mw._bringToFront === 'function') mw._bringToFront();
      var im = document.querySelector('icon-manager');
      if (im && typeof im.refresh === 'function') im.refresh();
    } catch (_) {}
  }

  // Build the presentation window (morphic-window + deck iframe +
  // reload button + keyboard-navigation bridge) and append it to the
  // outer document. Returns the <morphic-window> element.
  function build() {
    var mw = document.createElement('morphic-window');
    mw.id = WINDOW_ID;
    mw.setAttribute('caption', 'Orbit \u2014 a presentation');
    mw.style.cssText = 'pointer-events: all; top: 60px; left: 900px; width: 910px; height: 590px; opacity: 1;';

    var frame = document.createElement('iframe');
    frame.id = 'orbitTalkFrame';
    frame.src = 'presentation/deck.html';
    frame.frameBorder = '0';
    frame.scrolling = 'no';
    frame.allowFullscreen = true;
    // Fill the window's content area so the deck resizes with the window.
    frame.style.cssText = 'display: block; width: 100%; height: 100%; border: 0; overflow: hidden;';

    mw.appendChild(frame);
    document.body.appendChild(mw);

    // Reload button, slotted into the titlebar just to the left of the
    // send-to-back control. Reloads only the deck iframe so editing the
    // presentation doesn't require a full page reload.
    var reload = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    reload.setAttribute('slot', 'titlebar-extras');
    reload.setAttribute('id', 'orbitTalkReload');
    reload.setAttribute('width', '15');
    reload.setAttribute('height', '15');
    reload.setAttribute('viewBox', '0 0 15 15');
    reload.setAttribute('role', 'button');
    reload.setAttribute('aria-label', 'Reload presentation');
    reload.style.cssText = 'cursor: pointer; flex-shrink: 0; margin: 0 3px 0 0; transition: filter 150ms;';
    reload.innerHTML =
      '<circle cx="7.5" cy="7.5" r="6.5" fill="#3bb0c9" stroke="#2b8ba0" stroke-width="0.5"/>' +
      '<g transform="translate(2.7,2.7) scale(0.4)" fill="white">' +
      '<path d="M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>' +
      '</g>';
    var reloadTip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    reloadTip.textContent = 'Reload presentation';
    reload.appendChild(reloadTip);
    reload.addEventListener('mouseenter', function () { reload.style.filter = 'brightness(1.3)'; });
    reload.addEventListener('mouseleave', function () { reload.style.filter = ''; });
    reload.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    reload.addEventListener('click', function (e) {
      e.stopPropagation();
      // Restart the deck at the FIRST slide. If the deck exposed its
      // pristine (pre-impress) markup, first persist any in-place text
      // edits by merging the live editable content into that CLEAN markup
      // and PUTting it back. We must never save impress's mutated runtime
      // DOM (baked-in transforms/classes), which would break the deck.
      function restart() {
        try {
          var w = frame.contentWindow;
          w.location.replace(w.location.pathname + w.location.search);
        } catch (_) {
          frame.src = String(frame.src).split('#')[0];
        }
      }
      var cleanHTML = null;
      try {
        var w = frame.contentWindow;
        var doc = frame.contentDocument;
        var pristine = w && w.__deckPristineHTML;
        if (pristine && doc) {
          var base = new DOMParser().parseFromString(pristine, 'text/html');
          var live = doc.querySelectorAll('[contenteditable]');
          var slots = base.querySelectorAll('[contenteditable]');
          var n = Math.min(live.length, slots.length);
          for (var i = 0; i < n; i++) { slots[i].innerHTML = live[i].innerHTML; }
          cleanHTML = '<!DOCTYPE html>\n' + base.documentElement.outerHTML;
        }
      } catch (_) { cleanHTML = null; }
      if (!cleanHTML) { restart(); return; }
      var headers = { 'Content-Type': 'text/html; charset=utf-8' };
      try {
        if (window.__ORBIT_BRIDGE_BEARER__) {
          headers['Authorization'] = 'Bearer ' + window.__ORBIT_BRIDGE_BEARER__;
        }
      } catch (_) {}
      fetch('presentation/deck.html', {
        method: 'PUT',
        headers: headers,
        body: cleanHTML
      }).then(restart, restart);
    });
    mw.appendChild(reload);

    // Keyboard navigation bridge. The deck's impress.js binds arrow-key
    // handlers inside the iframe, so give the frame focus whenever the
    // presentation window is activated. As a fallback for when the top
    // document (not the frame) holds focus — where this page would
    // otherwise swallow arrow keys — forward navigation keys to impress
    // inside the frame. When the frame itself is focused, impress handles
    // the keys directly and this listener never sees them.
    function focusDeck() { try { frame.contentWindow.focus(); } catch (e) {} }
    mw.addEventListener('pointerdown', focusDeck);

    // Close button: just close (remove) the window. The morphic-window
    // only dispatches 'morphic-close' and dims itself; nothing removes
    // it unless a host listens. Remove the window on close.
    mw.addEventListener('morphic-close', function (e) {
      e.stopPropagation();
      mw.remove();
    });

    var NAV = { ArrowLeft: 'prev', ArrowUp: 'prev', PageUp: 'prev',
                ArrowRight: 'next', ArrowDown: 'next', PageDown: 'next', ' ': 'next' };
    var talkActive = false;
    document.addEventListener('pointerdown', function (e) {
      var path = e.composedPath ? e.composedPath() : [];
      talkActive = path.indexOf(mw) !== -1 || mw.contains(e.target);
    }, true);
    document.addEventListener('keydown', function (e) {
      if (!talkActive || e.metaKey || e.ctrlKey || e.altKey) { return; }
      var api;
      try { api = frame.contentWindow.impress(); } catch (_) { return; }
      if (!api) { return; }
      if (e.key === 'Escape' || e.key === 'Esc') {
        var steps = frame.contentDocument.querySelectorAll('.step');
        api.goto(steps.length ? steps[0].id : 0);
        e.preventDefault();
        return;
      }
      // While a slide is being edited, arrows and space move the caret /
      // type; don't hijack them for navigation. Page keys still navigate.
      var ae;
      try { ae = frame.contentDocument.activeElement; } catch (_) {}
      if (ae && ae.isContentEditable &&
          (e.key.indexOf('Arrow') === 0 || e.key === ' ' || e.key === 'Spacebar')) {
        return;
      }
      var action = NAV[e.key];
      if (!action || typeof api[action] !== 'function') { return; }
      api[action]();
      e.preventDefault();
    }, true);

    return mw;
  }

  // Open the Orbit presentation window, or focus it if already open.
  // Returns the <morphic-window> element (or a promise of it if the
  // custom element isn't upgraded yet).
  window.__orbitOpenPresentation = function () {
    var existing = findPresentation();
    if (existing) {
      bringToFront(existing);
      return existing;
    }
    // The window is created dynamically (after <morphic-window> is
    // defined) so it never races the custom-element upgrade of sibling
    // windows in _updateOcclusionShields().
    if (window.customElements && customElements.get('morphic-window')) {
      return build();
    }
    return customElements.whenDefined('morphic-window').then(function () {
      var again = findPresentation();
      if (again) { bringToFront(again); return again; }
      return build();
    });
  };
})();
