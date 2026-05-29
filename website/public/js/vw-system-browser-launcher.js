// vw-system-browser-launcher.js
//
// Opens a <system-browser> web component inside a <morphic-window>,
// backed by the VW BrowserWebComponentAdapter via tether. Replaces
// the SqueakJS-callback approach in system-browser-launcher.js with
// bidirectional tether messages to VisualWorks.
//
// Usage:
//   VWSystemBrowserLauncher.open()
//
// The launcher:
//  1. Connects a VWBrowserTether to the bridge
//  2. Asks VW to create a BrowserWebComponentAdapter (exposed on the tether)
//  3. Intercepts <system-browser> events, sends them to VW, applies responses

'use strict';

window.VWSystemBrowserLauncher = (function () {

  const WINDOW_ID = 'vw-system-browser-window';
  const CONTENT_ID = 'vw-sb-content';

  let _tether = null;
  let _lastMouseX = 200, _lastMouseY = 200;

  document.addEventListener('mousemove', (e) => {
    _lastMouseX = e.pageX;
    _lastMouseY = e.pageY;
  });

  // ---- public entry point ----

  async function open(opts) {
    opts = opts || {};

    // 1. Ensure the web component class is registered.
    if (!customElements.get('system-browser')) {
      await _loadScript('/js/components/system-browser.js');
      await new Promise(r => requestAnimationFrame(r));
    }

    // 2. Ensure the tether client is loaded.
    if (!window.VWBrowserTether) {
      await _loadScript('/js/vw-browser-tether.js');
    }

    // 3. Create (or reuse) the morphic-window + system-browser pair.
    let mw = document.getElementById(WINDOW_ID);
    let sb;
    if (!mw) {
      mw = document.createElement('morphic-window');
      mw.id = WINDOW_ID;
      mw.setAttribute('caption', 'VW System Browser');
      const x = opts.x || _lastMouseX;
      const y = opts.y || _lastMouseY;
      mw.style.cssText =
        `position:absolute;left:${x}px;top:${y}px;width:750px;height:550px;z-index:4;`;

      sb = document.createElement('system-browser');
      sb.id = CONTENT_ID;
      mw.appendChild(sb);
      document.body.appendChild(mw);
    } else {
      sb = document.getElementById(CONTENT_ID);
    }

    // 4. Close on morphic-close.
    if (!mw._closeWired) {
      mw._closeWired = true;
      mw.addEventListener('morphic-close', () => {
        mw.remove();
        if (_tether) { _tether.disconnect(); _tether = null; }
      });
    }

    // 5. Connect tether and create the VW adapter.
    try {
      _tether = new VWBrowserTether();
      const initResult = await _tether.connect();

      // Populate the initial categories list
      sb.packages = initResult.categories || [];

      // 6. Wire events from the component to tether calls
      _wireEvents(sb, _tether);

      // 7. Register push notification handler
      _tether.onPush((selector, args) => {
        _handlePush(sb, selector, args);
      });

      // 8. Bring to front
      if (typeof mw._bringToFront === 'function') mw._bringToFront();

    } catch (e) {
      console.error('[vw-browser] Failed to connect:', e);
      sb.statusText = 'Connection failed: ' + e.message;
    }

    return sb;
  }

  // ---- VW adapter initialization ----

  async function _initAdapter(tether) {
    // Create the VW-side BrowserWebComponentAdapter
    const result = await tether.connect();
    return result;
  }

  // ---- Event wiring ----

  function _wireEvents(sb, tether) {
    // Override dispatchEvent to intercept browser events
    const origDispatch = HTMLElement.prototype.dispatchEvent.bind(sb);
    sb.dispatchEvent = function (evt) {
      if (evt.type === 'browser-select') {
        _handleSelect(sb, tether, evt.detail);
        return true;
      }
      if (evt.type === 'browser-side') {
        _handleSideToggle(sb, tether, evt.detail);
        return true;
      }
      if (evt.type === 'browser-comment') {
        _handleComment(sb, tether);
        return true;
      }
      if (evt.type === 'browser-source-change') {
        // Don't send on every keystroke; source is submitted explicitly
        return true;
      }
      return origDispatch(evt);
    };

    // Cmd+S to accept source
    sb.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        _acceptSource(sb, tether);
      }
    });
  }

  async function _handleSelect(sb, tether, detail) {
    const { pane, value } = detail;

    if (value == null) {
      // Deselection
      if (pane === 'methods') {
        const result = await tether.send('deselectMethod', []);
        if (result.source !== undefined) sb.source = result.source;
      } else if (pane === 'protocols') {
        const result = await tether.send('deselectProtocol', []);
        if (result.methods) sb.methods = result.methods;
        if (result.comment !== undefined) sb.commentText = result.comment;
      }
      return;
    }

    const val = typeof value === 'string' ? value : (value && value.label || '');
    sb.statusText = `Selecting ${pane}: ${val}...`;

    try {
      let result;
      switch (pane) {
        case 'namespaces':
          // Namespace selection just filters categories locally
          return;

        case 'packages':
        case 'categories':
          result = await tether.send('selectCategory:', [val]);
          if (result.classes) sb.classes = result.classes;
          sb.protocols = [];
          sb.methods = [];
          sb.source = '';
          break;

        case 'classes':
          result = await tether.send('selectClass:', [val]);
          if (result.protocols) sb.protocols = result.protocols;
          if (result.source !== undefined) sb.source = result.source;
          if (result.side) sb.side = result.side;
          sb.methods = [];
          break;

        case 'protocols':
          result = await tether.send('selectProtocol:', [val]);
          if (result.methods) sb.methods = result.methods;
          break;

        case 'methods':
          result = await tether.send('selectMethod:', [val]);
          if (result.source !== undefined) sb.source = result.source;
          break;
      }

      sb.statusText = '';
    } catch (e) {
      sb.statusText = 'Error: ' + e.message;
      console.error('[vw-browser] select error:', pane, val, e);
    }
  }

  async function _handleSideToggle(sb, tether, detail) {
    try {
      const result = await tether.send('toggleSide', []);
      if (result.protocols) sb.protocols = result.protocols;
      if (result.methods) sb.methods = result.methods;
      if (result.source !== undefined) sb.source = result.source;
      if (result.side) sb.side = result.side;
    } catch (e) {
      sb.statusText = 'Error: ' + e.message;
    }
  }

  async function _handleComment(sb, tether) {
    try {
      const result = await tether.send('showComment', []);
      if (result.comment !== undefined) sb.commentText = result.comment;
    } catch (e) {
      sb.statusText = 'Error: ' + e.message;
    }
  }

  async function _acceptSource(sb, tether) {
    const source = sb.source;
    if (!source) return;
    sb.statusText = 'Compiling...';
    try {
      const result = await tether.send('acceptSource:', [source]);
      if (result.success) {
        sb.statusText = 'Compiled.';
      } else {
        sb.statusText = 'Error: ' + (result.error || 'compilation failed');
      }
    } catch (e) {
      sb.statusText = 'Error: ' + e.message;
    }
  }

  // ---- Push notification handling (VW → JS) ----

  function _handlePush(sb, selector, args) {
    switch (selector) {
      case 'categoriesChanged:':
        if (args[0]) sb.packages = JSON.parse(args[0]);
        break;
      case 'classesChanged:':
        if (args[0]) sb.classes = JSON.parse(args[0]);
        break;
      case 'protocolsChanged:':
        if (args[0]) sb.protocols = JSON.parse(args[0]);
        break;
      case 'methodsChanged:':
        if (args[0]) sb.methods = JSON.parse(args[0]);
        break;
      case 'sourceChanged:':
        if (args[0]) sb.source = args[0];
        break;
      case 'commentChanged:':
        if (args[0]) sb.commentText = args[0];
        break;
    }
  }

  // ---- helpers ----

  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  return { open };
})();
