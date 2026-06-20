// orbit-open-digital-twin.js
//
// Defines window.__orbitOpenDigitalTwin(), the page-side entry point
// the Orbit panel's "digital twin → open" button drives (via the
// SmalltalkMCPServer>>openDigitalTwin tool, which calls this function
// over the Squeak↔JS bridge on the OUTER orbit.html window).
//
// It mounts a <lam2300-vr> window (the A-Frame/WebXR digital twin of
// the Lam 2300 cluster tool) into the outer document, mirroring how
// the Keep viewer is mounted on demand. If a twin window already
// exists, it is brought to the front instead of duplicated.

(function () {
  'use strict';

  if (window.__orbitOpenDigitalTwin) return;

  function findTwin() {
    return document.querySelector('lam2300-vr');
  }

  // Raise the twin's window and, if it was collapsed/iconified (the
  // icon-manager hides windows via visibility:hidden rather than
  // removing them), restore it — so re-pressing "open" on an existing
  // twin surfaces the one window instead of silently doing nothing.
  function bringToFront(vr) {
    var mw = vr && vr.window;
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

  // Open the Lam 2300 digital twin window, or focus it if already open.
  // Returns the <lam2300-vr> host element.
  window.__orbitOpenDigitalTwin = function () {
    var existing = findTwin();
    if (existing) {
      bringToFront(existing);
      return existing;
    }

    var vr = document.createElement('lam2300-vr');
    vr.setAttribute('caption', 'Lam 2300 \u2014 Digital Twin');
    vr.style.position = 'absolute';
    vr.style.top = '120px';
    vr.style.left = '160px';
    vr.style.width = '900px';
    vr.style.height = '560px';
    document.body.appendChild(vr);

    // The inner morphic-window is built synchronously in
    // connectedCallback, but raise it on the next tick to be safe.
    setTimeout(function () { bringToFront(vr); }, 0);
    return vr;
  };
})();
