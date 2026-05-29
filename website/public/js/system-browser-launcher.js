// system-browser-launcher.js
//
// Opens a <system-browser> web component inside a <morphic-window>,
// backed by live Squeak SystemOrganization queries (no Browser model).
//
// Usage:
//   From JS:       SystemBrowserLauncher.open()
//   From SqueakJS:  JS top SystemBrowserLauncher open
//
// The launcher creates the window + event gate. Smalltalk callbacks
// are installed by calling SystemBrowserLauncher.wireSmalltalk() from
// SqueakJS after open() returns. A convenience one-liner:
//
//   (JS top at: #SystemBrowserLauncher) open.
//   (JS top at: #SystemBrowserLauncher) wireSmalltalk.
//
// Or the combined helper:
//
//   (JS top at: #SystemBrowserLauncher) openAndWire.

window.SystemBrowserLauncher = (function () {

  const WINDOW_ID = 'system-browser-window';
  const CONTENT_ID = 'sb-content';

  let _lastMouseX = 100;
  let _lastMouseY = 100;
  document.addEventListener('mousemove', (e) => {
    _lastMouseX = e.pageX;
    _lastMouseY = e.pageY;
  });

  function _currentMousePos() {
    // If the mouse is over the Squeak iframe, get position from its display
    const embedded = document.getElementById('embeddedSqueak');
    if (embedded) {
      const iframe = embedded.querySelector('iframe');
      if (iframe && iframe.contentWindow && iframe.contentWindow.display) {
        try {
          const d = iframe.contentWindow.display;
          if (d.mouseX !== undefined) {
            const rect = iframe.getBoundingClientRect();
            return { x: rect.left + d.mouseX + window.scrollX, y: rect.top + d.mouseY + window.scrollY };
          }
        } catch(e) {}
      }
    }
    return { x: _lastMouseX, y: _lastMouseY };
  }

  // ---- public entry point ----

  async function open(opts) {
    opts = opts || {};

    // 1. Ensure the web component class is registered.
    if (!customElements.get('system-browser')) {
      await loadScript('/js/components/system-browser.js');
      await new Promise(r => requestAnimationFrame(r));
    }

    // 2. Create (or reuse) the morphic-window + system-browser pair.
    let mw = document.getElementById(WINDOW_ID);
    let sb;
    if (!mw) {
      mw = document.createElement('morphic-window');
      mw.id = WINDOW_ID;
      mw.setAttribute('caption', 'System Browser');
      const pos = _currentMousePos();
      const x = pos.x;
      const y = pos.y;
      mw.style.cssText =
        `position:absolute;left:${x}px;top:${y}px;width:650px;height:500px;z-index:4;`;

      sb = document.createElement('system-browser');
      sb.id = CONTENT_ID;
      mw.appendChild(sb);
      document.body.appendChild(mw);
    } else {
      sb = document.getElementById(CONTENT_ID);
    }

    // 3. Install event gate (fire-and-forget — callbacks set DOM
    //    properties directly from forked Smalltalk processes).
    installEventGate(sb);

    // 4. Close on morphic-close.
    if (!mw._closeWired) {
      mw._closeWired = true;
      mw.addEventListener('morphic-close', () => mw.remove());
    }

    // 5. Bring the window to front.
    if (typeof mw._bringToFront === 'function') mw._bringToFront();

    return sb;
  }

  // ---- Squeak wiring ----
  // Called from SqueakJS to install Smalltalk callback blocks that
  // query SystemOrganization and class objects directly (no Browser
  // model, no MVC side-effects). Each callback converts its JS proxy
  // argument to a Smalltalk string before forking, so the forked
  // block never holds a stale JS proxy.

  function wireSmalltalk() {
    // This is a JS function that, when called from SqueakJS via
    //   (JS top at: #SystemBrowserLauncher) wireSmalltalk
    // does nothing on the JS side — the actual wiring is done by the
    // Smalltalk caller using the source returned by wireSmalltalkSource().
    // We provide this as a convenience; see openAndWire() below.
  }

  // Combined open + wire, callable from SqueakJS as:
  //   (JS top at: #SystemBrowserLauncher) openAndWire
  // After calling this, evaluate the Smalltalk wiring expression
  // (see openAndWireFromSmalltalk class-side method pattern).
  function openAndWire() {
    return open();
  }

  // ---- event gate ----
  // Callbacks are fire-and-forget: they fork a Smalltalk process that
  // sets properties directly on the <system-browser> DOM element.
  // The JS event handler just invokes the callback and ignores the
  // return value.

  function installEventGate(sb) {
    // Always reinstall to pick up latest handler code.
    const origDispatch = HTMLElement.prototype.dispatchEvent.bind(sb);
    sb.dispatchEvent = function (evt) {
      if (evt.type === 'browser-select' || evt.type === 'browser-side' || evt.type === 'browser-comment') {
        handleBrowserEvent(sb, evt);
        return true;
      }
      return origDispatch(evt);
    };
    sb._eventGateInstalled = true;
  }

  function handleBrowserEvent(sb, evt) {
    if (evt.type === 'browser-side') {
      try { sb.sbToggleSide(evt.detail.side); }
      catch (e) { console.warn('browser-side:', e.message); }
      return;
    }

    if (evt.type === 'browser-comment') {
      try { if (sb.sbShowComment) sb.sbShowComment(); }
      catch (e) { console.warn('browser-comment:', e.message); }
      return;
    }

    const { pane, value } = evt.detail;

    // Deselect: value is null when toggling off
    if (pane === 'methods' && value == null) {
      try { if (sb.sbDeselectMethod) sb.sbDeselectMethod(); }
      catch (e) { console.warn('browser-deselect:', e.message); }
      return;
    }
    if (pane === 'protocols' && value == null) {
      try {
        sb.methods = [];
        if (sb.sbShowComment) sb.sbShowComment();
      }
      catch (e) { console.warn('browser-deselect-protocol:', e.message); }
      return;
    }

    const val = typeof value === 'string' ? value : (value && value.label || '');

    try {
      if (pane === 'packages' || pane === 'categories')  sb.sbSelectCategory(val);
      else if (pane === 'namespaces') { /* namespace selection just filters categories; no Smalltalk call */ }
      else if (pane === 'classes')   sb.sbSelectClass(val);
      else if (pane === 'protocols') sb.sbSelectProtocol(val);
      else if (pane === 'methods')   sb.sbSelectMethod(val);
    } catch (e) {
      console.warn('browser-select:', pane, val, e.message);
    }
  }

  // ---- helpers ----

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  return { open, openAndWire, wireSmalltalk };
})();
