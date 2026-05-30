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
//  1. Gets the shared VWBrowserTether from the icon manager
//  2. Asks VW to create a BrowserWebComponentAdapter (exposed on the tether)
//  3. Intercepts <system-browser> events, sends them to VW, applies responses

'use strict';

window.VWSystemBrowserLauncher = (function () {

  const WINDOW_ID = 'vw-system-browser-window';
  const CONTENT_ID = 'vw-sb-content';

  let _tether = null;
  let _adapterHash = null;
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
      await _loadScript('/js/components/system-browser/system-browser.js');
      await new Promise(r => requestAnimationFrame(r));
    }

    // 2. Create (or reuse) the morphic-window + system-browser pair.
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

    // 3. Close on morphic-close.
    if (!mw._closeWired) {
      mw._closeWired = true;
      mw.addEventListener('morphic-close', () => {
        mw.remove();
        _tether = null;
        _adapterHash = null;
      });
    }

    // 4. Get the shared tether from the icon manager.
    try {
      const im = document.querySelector('icon-manager');
      if (!im || !im.tether) throw new Error('No shared tether available');
      _tether = im.tether;

      const initResult = await _tether.sendToTether('createBrowserAdapter', []);
      _adapterHash = initResult.exposureHash;

      // Populate the initial categories list
      sb.packages = initResult.categories || [];

      // 5. Wire events from the component to tether calls
      _wireEvents(sb);

      // 6. Register push notification handler
      _tether.onPush((selector, args) => {
        _handlePush(sb, selector, args);
      });

      // 7. Bring to front
      if (typeof mw._bringToFront === 'function') mw._bringToFront();

    } catch (e) {
      console.error('[vw-browser] Failed to connect:', e);
      sb.statusText = 'Connection failed: ' + e.message;
    }

    return sb;
  }

  // ---- Send to the browser adapter via the shared tether ----

  function _send(selector, args) {
    return _tether.sendTo(_adapterHash, selector, args || []);
  }

  // ---- Event wiring ----

  function _wireEvents(sb) {
    // Override dispatchEvent to intercept browser events
    const origDispatch = HTMLElement.prototype.dispatchEvent.bind(sb);
    sb.dispatchEvent = function (evt) {
      if (evt.type === 'browser-select') {
        _handleSelect(sb, evt.detail);
        return true;
      }
      if (evt.type === 'browser-side') {
        _handleSideToggle(sb, evt.detail);
        return true;
      }
      if (evt.type === 'browser-comment') {
        _handleComment(sb);
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
        _acceptSource(sb);
      }
    });
  }

  async function _handleSelect(sb, detail) {
    const { pane, value } = detail;

    if (value == null) {
      // Deselection
      if (pane === 'methods') {
        const result = await _send('deselectMethod', []);
        if (result.source !== undefined) _setSource(sb, result);
      } else if (pane === 'protocols') {
        const result = await _send('deselectProtocol', []);
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
          result = await _send('selectCategory:', [val]);
          if (result.classes) sb.classes = result.classes;
          sb.protocols = [];
          sb.methods = [];
          sb.source = '';
          break;

        case 'classes':
          result = await _send('selectClass:', [val]);
          if (result.protocols) sb.protocols = result.protocols;
          if (result.side) sb.side = result.side;
          sb.commentText = result.comment || 'This class has no comment.';
          sb.methods = [];
          break;

        case 'protocols':
          result = await _send('selectProtocol:', [val]);
          if (result.methods) sb.methods = result.methods;
          break;

        case 'methods':
          result = await _send('selectMethod:', [val]);
          if (result.source !== undefined) _setSource(sb, result);
          break;
      }

      sb.statusText = '';
    } catch (e) {
      sb.statusText = 'Error: ' + e.message;
      console.error('[vw-browser] select error:', pane, val, e);
    }
  }

  async function _handleSideToggle(sb, detail) {
    try {
      const result = await _send('toggleSide', []);
      if (result.protocols) sb.protocols = result.protocols;
      if (result.methods) sb.methods = result.methods;
      if (result.source !== undefined) sb.source = result.source;
      if (result.side) sb.side = result.side;
    } catch (e) {
      sb.statusText = 'Error: ' + e.message;
    }
  }

  async function _handleComment(sb) {
    try {
      const result = await _send('showComment', []);
      if (result.comment !== undefined) sb.commentText = result.comment;
    } catch (e) {
      sb.statusText = 'Error: ' + e.message;
    }
  }

  async function _acceptSource(sb) {
    const source = sb.source;
    if (!source) return;
    sb.statusText = 'Compiling...';
    try {
      const result = await _send('acceptSource:', [source]);
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

  // VW CodeHighlightingParser token type → CSS style map
  const _tokenStyles = {
    code_unaryMethodName:       'font-weight:bold',
    code_keywordMethodName:     'font-weight:bold',
    code_binaryMethodName:      'font-weight:bold',
    code_comment:               'color:#555;font-style:italic',
    code_string:                'color:darkgreen',
    code_symbol:                'color:darkgreen',
    code_number:                'color:darkgreen',
    code_character:             'color:darkgreen',
    code_array:                 'color:darkgreen',
    code_byteArray:             'color:darkgreen',
    code_true:                  'color:darkgreen',
    code_false:                 'color:darkgreen',
    code_nil:                   'color:darkgreen',
    code_qualifiedReference:    'color:darkgreen',
    code_self:                  'color:blue',
    code_super:                 'color:blue',
    code_thisContext:           'color:blue',
    code_classReference:        'color:brown',
    code_sharedVariableReference: 'color:darkcyan',
    code_nameSpaceReference:    'color:blue',
    code_instanceVariable:      'color:navy',
    code_temporaryVariable:     'color:darkmagenta',
    code_temporaryVariableDefinition: 'color:darkmagenta',
    code_methodVariableDefinition: 'font-weight:bold;color:darkmagenta',
    code_blockArgument:         'color:darkmagenta',
    code_return:                'font-weight:bold',
    code_primitive:             'color:darkred',
    code_syntaxError:           'text-decoration:underline wavy red',
    code_dnu:                   'text-decoration:underline wavy red',
    code_undeclaredVariable:    'text-decoration:underline wavy red',
    code_redefinedVariableDefinition: 'text-decoration:underline wavy red',
  };

  function _highlightRunsToHTML(source, runsJSON) {
    let runs;
    try { runs = JSON.parse(runsJSON); } catch (_) { return null; }
    const parts = [];
    let pos = 0;
    for (const [len, token] of runs) {
      const chunk = source.substring(pos, pos + len);
      const escaped = chunk
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const style = token ? _tokenStyles[token] : null;
      if (style) {
        parts.push(`<span style="${style}">${escaped}</span>`);
      } else {
        parts.push(escaped);
      }
      pos += len;
    }
    // Append any trailing unhighlighted text
    if (pos < source.length) {
      parts.push(source.substring(pos)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;'));
    }
    return parts.join('');
  }

  function _setSource(sb, result) {
    const source = typeof result === 'string' ? result : result.source;
    const highlights = typeof result === 'string' ? null : result.highlights;
    if (highlights) {
      const html = _highlightRunsToHTML(source, highlights);
      if (html) { sb.sourceHTML = html; return; }
    }
    sb.source = source;
  }

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
