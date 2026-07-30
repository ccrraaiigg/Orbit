// <icon-manager> Web Component
//
// Shows a persistent, alphabetized list of Morphic windows and toggles
// visibility with a 500ms opacity transition.

class IconManager extends HTMLElement {

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._observer = null;
    this._refreshTimer = null;
    this._iconified = false;
    this._suppressed = new WeakSet();
    this._hovering = false;
    this._altDown = false;
    this._lastPointerX = 0;
    this._lastPointerY = 0;
    this._hoveredWindow = null;
    this._windowHoveredByEnter = null;
    this._windowEnterLeaveListeners = null;
    this._onMutation = this._onMutation.bind(this);
    this._onCursorMove = this._onCursorMove.bind(this);
    this._onCursorLeave = this._onCursorLeave.bind(this);
    this._onDocPointerMove = this._onDocPointerMove.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  connectedCallback() {
    this._render();
    this._startObserving();
    this.addEventListener('pointermove', this._onCursorMove, true);
    this.addEventListener('pointerleave', this._onCursorLeave, true);
    document.addEventListener('pointermove', this._onDocPointerMove, true);
    document.addEventListener('keydown', this._onKeyDown, true);
    document.addEventListener('keyup', this._onKeyUp, true);
    var self = this;
    document.addEventListener('pointerdown', function(e) {
      if (e.button !== 0) return;
      var path = e.composedPath();
      var inSelf = path.some(function(el) { return el === self || el === self.shadowRoot; });
      if (!inSelf) return;
      if (self._iconified) {
        e.preventDefault();
        e.stopImmediatePropagation();
        self._iconified = false;
        self._suppressed = new WeakSet();
        self.refresh();
        return;
      }
      if (e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        self._iconified = true;
        self._altDown = false;
        self._hideIconifyCursor();
        self.refresh();
      }
    }, true);
    var listEl = this.shadowRoot.querySelector('.list');
    listEl.addEventListener('pointerdown', function(e) {
      if (e.button !== 0) return;
      var cell = e.target.closest('.cell');
      if (!cell) return;
      var idx = parseInt(cell.dataset.windowIndex, 10);
      var wins = self._visibleWindows();
      if (wins[idx]) self._toggleWindow(wins[idx]);
    });
    listEl.addEventListener('pointerover', function(e) {
      var cell = e.target.closest('.cell');
      var win = cell ? self._windowForCell(cell) : null;
      if (win === self._hoveredWindow) return;
      if (self._hoveredWindow) self._hoveredWindow.style.removeProperty('background-color');
      self._hoveredWindow = win;
      if (win) win.style.backgroundColor = '#a8c8c8';
    });
    listEl.addEventListener('pointerleave', function() {
      if (self._hoveredWindow) self._hoveredWindow.style.removeProperty('background-color');
      self._hoveredWindow = null;
    });
    this.refresh();
    this._bindWindowHoverTracking();

    document.addEventListener('morphic-collapse', function(e) {
      var win = e.target;
      if (win && win.id === 'embeddedSqueak') {
        self._suppressed.add(win);
        self.refresh();
      }
    }, true);

    this._installIframePointerForwarders();
    this._connectTether();
    this._installClipboardBridge();
  }

  disconnectedCallback() {
    this.removeEventListener('pointermove', this._onCursorMove, true);
    this.removeEventListener('pointerleave', this._onCursorLeave, true);
    document.removeEventListener('pointermove', this._onDocPointerMove, true);
    document.removeEventListener('keydown', this._onKeyDown, true);
    document.removeEventListener('keyup', this._onKeyUp, true);
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    this._unbindWindowHoverTracking();
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: fixed;
          bottom: 12px;
          right: 12px;
          width: 260px;
          max-height: calc(100vh - 24px);
          box-sizing: border-box;
          overflow: auto;
          display: block;
          z-index: 9999;
          isolation: isolate;
          background-color: #c0c0c0;
          border-radius: 7px;
          padding: 5px;
          transition: background-color 200ms;
        }
        :host(:hover) {
          background-color: #a8c8c8;
        }
        .list {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .cell {
          display: flex;
          align-items: center;
          gap: 6px;
          border: 1px solid #8f8f8f;
          border-radius: 4px;
          background: #e3e3e3;
          color: black;
          font-family: sans-serif;
          font-size: 12px;
          line-height: 1.2;
          padding: 5px 7px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: pointer;
          user-select: none;
          text-align: left;
        }
        .cell-icon {
          width: 0.72em;
          height: 0.72em;
          min-width: 0.72em;
          border-radius: 50%;
          background: black;
          flex-shrink: 0;
        }
        .cell-icon.visible {
          visibility: hidden;
        }
        .cell-label {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          text-align: left;
        }
        .cell:hover {
          background: #f0f0f0;
        }
        .hidden {
        }
        .empty {
          font-family: sans-serif;
          font-size: 12px;
          color: #444;
          padding: 5px 7px;
        }
        .iconify-cursor {
          position: fixed;
          pointer-events: none;
          z-index: 99999;
          display: none;
          width: 20px;
          height: 20px;
        }
      </style>
      <style id="cursor-hide"></style>
      <div class="list"></div>
      <div class="iconify-cursor">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <circle cx="8.5" cy="8.5" r="6" stroke="black" stroke-width="1.5" fill="white" fill-opacity="0.85"/>
          <line x1="5.5" y1="8.5" x2="11.5" y2="8.5" stroke="black" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="13" y1="13" x2="18" y2="18" stroke="black" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
    `;
  }

  _morphicRoot() {
    return document.getElementById('Morphic') || document.body;
  }

  _visibleWindows() {
    var self = this;
    var wins = Array.from(document.querySelectorAll('morphic-window'));
    wins = wins.filter(function(w) { return !self._suppressed.has(w); });
    wins.sort(function(a, b) { return self._compareWindows(a, b); });
    return wins;
  }

  _windowForCell(cell) {
    var idx = parseInt(cell.dataset.windowIndex, 10);
    return this._visibleWindows()[idx] || null;
  }

  _windowTitle(windowEl) {
    return windowEl.getAttribute('caption') || windowEl.getAttribute('title') || '';
  }

  _titleStartsWithArticle(title) {
    var lower = title.toLowerCase();
    return lower.startsWith('a ') || lower.startsWith('an ');
  }

  _compareWindows(a, b) {
    var ta = this._windowTitle(a);
    var tb = this._windowTitle(b);
    var aa = this._titleStartsWithArticle(ta);
    var ab = this._titleStartsWithArticle(tb);
    if (aa !== ab) return aa ? -1 : 1;
    return ta.localeCompare(tb, undefined, { sensitivity: 'base' });
  }

  _windowHidden(windowEl) {
    var cs = getComputedStyle(windowEl);
    if (windowEl.dataset.iconManagerPendingHidden === 'true') return true;
    return cs.visibility === 'hidden';
  }

  _ensureOpacityTransition(windowEl) {
    var existing = windowEl.style.transition || '';
    if (existing.indexOf('opacity') !== -1) return;
    windowEl.style.transition = existing ? (existing + ', opacity 500ms') : 'opacity 500ms';
  }

  _toggleWindow(windowEl) {
    this._ensureOpacityTransition(windowEl);

    if (this._windowHidden(windowEl)) {
      delete windowEl.dataset.iconManagerPendingHidden;
      if (typeof windowEl._bringToFront === 'function') windowEl._bringToFront();
      windowEl.style.visibility = 'visible';
      windowEl.style.opacity = '0';
      this.refresh();
      requestAnimationFrame(function() {
        windowEl.style.opacity = '1';
      });
      this._scheduleRefresh(520);
      return;
    }

    windowEl.dataset.iconManagerPendingHidden = 'true';
    windowEl.style.visibility = 'visible';
    windowEl.style.opacity = '1';
    if (this._windowHoveredByEnter === windowEl) {
      this._clearWindowCellHighlight();
    }
    this.refresh();
    requestAnimationFrame(function() {
      windowEl.style.opacity = '0';
    });

    var self = this;
    setTimeout(function() {
      if (parseFloat(getComputedStyle(windowEl).opacity || '1') <= 0.01) {
        windowEl.style.visibility = 'hidden';
      }
      delete windowEl.dataset.iconManagerPendingHidden;
      self.refresh();
    }, 500);
  }

  _startObserving() {
    if (this._observer) this._observer.disconnect();

    var root = this._morphicRoot();
    this._observer = new MutationObserver(this._onMutation);
    this._observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['caption', 'title', 'style', 'data-icon-manager-pending-hidden']
    });
  }

  _onMutation() {
    this._scheduleRefresh(0);
    this._installIframePointerForwarders();
  }

  _installIframePointerForwarders() {
    var self = this;
    var iframes = document.querySelectorAll('iframe');
    iframes.forEach(function(iframe) {
      var attach = function() {
        var doc;
        try { doc = iframe.contentDocument; } catch (_) { return; }
        if (!doc) return;
        if (doc._iconManagerPointerForwardInstalled) return;
        var onMove = function(ev) {
          var r;
          try { r = iframe.getBoundingClientRect(); } catch (_) { return; }
          var x = (ev.clientX || 0) + r.left;
          var y = (ev.clientY || 0) + r.top;
          self._lastPointerX = x;
          self._lastPointerY = y;
          if (self._iconified) return;
          if (!(self._altDown || ev.altKey)) return;
          if (self._hovering || self._pointerOverMorphicWindow(x, y)) {
            self._showIconifyCursor();
          } else {
            self._hideIconifyCursor();
          }
        };
        doc.addEventListener('pointermove', onMove, true);
        doc.addEventListener('mousemove', onMove, true);
        var onKey = function(ev) {
          if (ev.key !== 'Alt') return;
          if (ev.type === 'keydown') {
            self._altDown = true;
            if (self._iconified) return;
            if (self._hovering || self._pointerOverMorphicWindow(self._lastPointerX, self._lastPointerY)) {
              self._showIconifyCursor();
            }
          } else {
            self._altDown = false;
            self._hideIconifyCursor();
          }
        };
        doc.addEventListener('keydown', onKey, true);
        doc.addEventListener('keyup', onKey, true);
        doc._iconManagerPointerForwardInstalled = true;
      };
      attach();
      iframe.addEventListener('load', attach);
    });
  }



  _setCellCursors(cursor) {
    var cells = this.shadowRoot.querySelectorAll('.cell');
    cells.forEach(function(cell) {
      cell.style.cursor = cursor || 'pointer';
    });
  }

  _showIconifyCursor() {
    var cursor = this.shadowRoot.querySelector('.iconify-cursor');
    var style = this.shadowRoot.getElementById('cursor-hide');
    cursor.style.left = (this._lastPointerX + 2) + 'px';
    cursor.style.top = (this._lastPointerY + 2) + 'px';
    cursor.style.display = 'block';
    this.style.setProperty('cursor', 'none', 'important');
    style.textContent = '* { cursor: none !important; }';
    document.documentElement.style.setProperty('cursor', 'none', 'important');
    this._setHostCursorHidden(true);
    this._setIframeCursorHidden(true);
  }

  _hideIconifyCursor() {
    var cursor = this.shadowRoot.querySelector('.iconify-cursor');
    var style = this.shadowRoot.getElementById('cursor-hide');
    cursor.style.display = 'none';
    this.style.removeProperty('cursor');
    style.textContent = '';
    this._setCellCursors('');
    document.documentElement.style.removeProperty('cursor');
    this._setHostCursorHidden(false);
    this._setIframeCursorHidden(false);
  }

  _setHostCursorHidden(hidden) {
    var styleId = '__iconManagerHostCursorHide';
    var styleEl = document.getElementById(styleId);
    if (hidden) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        (document.head || document.documentElement).appendChild(styleEl);
      }
      styleEl.textContent = '*, *::before, *::after { cursor: none !important; }';
    } else if (styleEl) {
      styleEl.textContent = '';
    }
    this._setShadowCursorHidden(hidden);
  }

  _setShadowCursorHidden(hidden) {
    var wins = document.querySelectorAll('morphic-window, transient-window, workbook-window, keep-viewer');
    var styleId = '__iconManagerShadowCursorHide';
    wins.forEach(function(win) {
      var root = win.shadowRoot;
      if (!root) return;
      var styleEl = root.getElementById(styleId);
      if (hidden) {
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = styleId;
          root.appendChild(styleEl);
        }
        styleEl.textContent = '*, *::before, *::after { cursor: none !important; }';
      } else if (styleEl) {
        styleEl.textContent = '';
      }
    });
  }

  _setIframeCursorHidden(hidden) {
    var iframes = document.querySelectorAll('iframe');
    iframes.forEach(function(iframe) {
      var doc;
      try { doc = iframe.contentDocument; } catch (_) { return; }
      if (!doc) return;
      var styleId = '__iconManagerCursorHide';
      var styleEl = doc.getElementById(styleId);
      if (hidden) {
        if (!styleEl) {
          styleEl = doc.createElement('style');
          styleEl.id = styleId;
          (doc.head || doc.documentElement).appendChild(styleEl);
        }
        styleEl.textContent = '*, *::before, *::after { cursor: none !important; }';
        if (doc.documentElement) doc.documentElement.style.setProperty('cursor', 'none', 'important');
        if (doc.body) doc.body.style.setProperty('cursor', 'none', 'important');
        var cc = doc.getElementById('cursorCanvas');
        if (cc) cc.style.setProperty('display', 'none', 'important');
      } else {
        if (styleEl) styleEl.textContent = '';
        if (doc.documentElement) doc.documentElement.style.removeProperty('cursor');
        if (doc.body) doc.body.style.removeProperty('cursor');
        var cc2 = doc.getElementById('cursorCanvas');
        if (cc2) cc2.style.removeProperty('display');
      }
    });
  }

  _onCursorMove(e) {
    this._hovering = true;
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;
    if (this._iconified) return;
    if (this._altDown || e.altKey) {
      this._showIconifyCursor();
      return;
    }
  }

  _onCursorLeave() {
    this._hovering = false;
    this.style.cursor = '';
    this._setCellCursors('');
    if (!this._pointerOverMorphicWindow(this._lastPointerX, this._lastPointerY)) {
      this._hideIconifyCursor();
    }
  }

  _onDocPointerMove(e) {
    this._lastPointerX = e.clientX;
    this._lastPointerY = e.clientY;
    if (this._iconified) return;
    if (!(this._altDown || e.altKey)) return;
    var overSelf = e.composedPath && e.composedPath().indexOf(this) !== -1;
    if (overSelf || this._hovering || this._pointerOverMorphicWindow(e.clientX, e.clientY)) {
      this._showIconifyCursor();
    } else {
      this._hideIconifyCursor();
    }
  }

  _pointerOverMorphicWindow(x, y) {
    if (x == null || y == null) return false;
    var els = document.elementsFromPoint(x, y);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el === this || (this.shadowRoot && this.shadowRoot.contains(el))) continue;
      var node = el;
      while (node) {
        if (node.tagName && /^(morphic-window|transient-window|workbook-window)$/i.test(node.tagName)) {
          return true;
        }
        node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      }
    }
    return false;
  }

  _onKeyDown(e) {
    if (e.key === 'Alt') {
      this._altDown = true;
      if (this._iconified) return;
      if (this._hovering || this._pointerOverMorphicWindow(this._lastPointerX, this._lastPointerY)) {
        this._showIconifyCursor();
      }
    }
  }

  _onKeyUp(e) {
    if (e.key === 'Alt') {
      this._altDown = false;
      this._hideIconifyCursor();
      if (this._hovering) {
        this.style.cursor = '';
        this._setCellCursors('');
      }
    }
  }

  _scheduleRefresh(delayMs) {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    var self = this;
    this._refreshTimer = setTimeout(function() {
      self._refreshTimer = null;
      self.refresh();
    }, delayMs);
  }

  refresh() {
    var list = this.shadowRoot.querySelector('.list');
    if (!list) return;

    var windows = this._visibleWindows();

    list.innerHTML = '';

    if (this._iconified) {
      this.style.width = 'auto';
      var cell = document.createElement('div');
      cell.className = 'cell';
      cell.style.padding = '5px';
      var icon = document.createElement('span');
      icon.className = 'cell-icon';
      cell.appendChild(icon);
      list.appendChild(cell);
      return;
    }

    this.style.width = '';

    if (!windows.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'no windows';
      list.appendChild(empty);
      return;
    }

    var self = this;
    windows.forEach(function(windowEl, idx) {
      var hidden = self._windowHidden(windowEl);
      var cell = document.createElement('div');
      cell.className = 'cell' + (hidden ? ' hidden' : '');
      cell.dataset.windowIndex = idx;

      var icon = document.createElement('span');
      icon.className = 'cell-icon' + (hidden ? '' : ' visible');

      var label = document.createElement('span');
      label.className = 'cell-label';
      var title = self._windowTitle(windowEl) || '(untitled window)';
      label.textContent = title;

      cell.appendChild(icon);
      cell.appendChild(label);
      list.appendChild(cell);
    });

    this._bindWindowHoverTracking();

    // Reapply cell highlight if a window is currently hovered
    if (this._windowHoveredByEnter) {
      var activeCell = this._cellForWindow(this._windowHoveredByEnter);
      if (activeCell) activeCell.style.background = '#f0f0f0';
    }
  }

  _cellForWindow(windowEl) {
    var windows = this._visibleWindows();
    var idx = windows.indexOf(windowEl);
    if (idx < 0) return null;
    return this.shadowRoot.querySelector('.cell[data-window-index="' + idx + '"]');
  }

  _highlightCellForWindow(win) {
    if (win === this._windowHoveredByEnter) return;
    this._clearWindowCellHighlight();
    this._windowHoveredByEnter = win;
    var cell = this._cellForWindow(win);
    if (cell) cell.style.background = '#f0f0f0';
  }

  _clearWindowCellHighlight() {
    if (this._windowHoveredByEnter) {
      var cell = this._cellForWindow(this._windowHoveredByEnter);
      if (cell) cell.style.removeProperty('background');
      this._windowHoveredByEnter = null;
    }
  }

  _onDocumentPointerMove(e) {
    if (!this._windowHoveredByEnter) return;
    var rect = this._windowHoveredByEnter.getBoundingClientRect();
    var inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                 e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) {
      this._clearWindowCellHighlight();
      document.removeEventListener('pointermove', this._boundDocPointerMove);
      this._boundDocPointerMove = null;
    }
  }

  _bindWindowHoverTracking() {
    var self = this;
    var windows = Array.from(document.querySelectorAll('morphic-window'));

    // Remove listeners from windows no longer present
    if (this._windowEnterLeaveListeners) {
      this._windowEnterLeaveListeners.forEach(function(rec) {
        if (windows.indexOf(rec.win) === -1) {
          rec.win.removeEventListener('pointerenter', rec.enter);
          rec.win.removeEventListener('pointerleave', rec.leave);
        }
      });
    }

    var existing = new Set((this._windowEnterLeaveListeners || []).map(function(r) { return r.win; }));
    var kept = (this._windowEnterLeaveListeners || []).filter(function(r) { return windows.indexOf(r.win) !== -1; });

    windows.forEach(function(win) {
      if (existing.has(win)) return;
      var rec = {
        win: win,
        enter: function() {
          self._highlightCellForWindow(win);
          // Start listening for pointer moves on the document to detect true exit
          if (!self._boundDocPointerMove) {
            self._boundDocPointerMove = self._onDocumentPointerMove.bind(self);
            document.addEventListener('pointermove', self._boundDocPointerMove);
          }
        },
        leave: function(e) {
          // Check if pointer is still inside the window (e.g. moved into a child iframe)
          var rect = win.getBoundingClientRect();
          var inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                       e.clientY >= rect.top && e.clientY <= rect.bottom;
          if (inside) return;
          if (self._windowHoveredByEnter === win) {
            self._clearWindowCellHighlight();
          }
        }
      };
      win.addEventListener('pointerenter', rec.enter);
      win.addEventListener('pointerleave', rec.leave);
      kept.push(rec);
    });

    this._windowEnterLeaveListeners = kept;
  }

  _unbindWindowHoverTracking() {
    if (this._windowEnterLeaveListeners) {
      this._windowEnterLeaveListeners.forEach(function(rec) {
        rec.win.removeEventListener('pointerenter', rec.enter);
        rec.win.removeEventListener('pointerleave', rec.leave);
      });
      this._windowEnterLeaveListeners = null;
    }
    if (this._boundDocPointerMove) {
      document.removeEventListener('pointermove', this._boundDocPointerMove);
      this._boundDocPointerMove = null;
    }
    this._clearWindowCellHighlight();
  }

  // ---- Tether (shared connection to VW) ----

  get tether() { return this._tether || null; }

  async _loadTetherClass() {
    if (window.VWBrowserTether) return;
    await new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = '/js/components/system-browser/vw-browser-tether.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async _connectTether() {
    if (this._tether) return;
    try {
      await this._loadTetherClass();
      this._tether = new VWBrowserTether();
      await this._tether.connectRaw();
      console.log('[icon-manager] tether connected');
    } catch (e) {
      console.warn('[icon-manager] tether connection failed:', e.message);
      this._tether = null;
    }
  }

  // Window keys collide between images, so the owning connection is identified by
  // the data-tether-url Snowglobe stamps on each window element.
  _tetherForUrl(url) {
    if (!this._tethers) this._tethers = new Map();
    var existing = this._tethers.get(url);
    if (existing) return existing;
    var self = this;
    var promise = this._loadTetherClass()
      .then(function() {
        var t = new VWBrowserTether({ url: url });
        return t.connectRaw().then(function() {
          console.log('[icon-manager] tether connected:', url);
          return t;
        });
      })
      .catch(function(e) {
        self._tethers.delete(url);
        console.warn('[icon-manager] tether connection failed for', url, e.message);
        return null;
      });
    this._tethers.set(url, promise);
    return promise;
  }

  _tetherForCanvas(canvas) {
    var host = canvas.closest('morphic-window, transient-window');
    var url = host && host.getAttribute('data-tether-url');
    if (!url) return Promise.resolve(this._tether);
    return this._tetherForUrl(url);
  }

  // ---- Clipboard bridge (Ctrl+C/V ↔ VW paste buffer) ----
  //
  // Wraps canvas.onkeydown on each Snowglobe canvas so that on Ctrl+V
  // we fetch the macOS clipboard via /clipboard, push it into VW's paste
  // buffer via the tether, then call the original Squeak handler.
  // On Ctrl+C/X we let Squeak handle it first, then pull VW's paste
  // buffer out and POST it to /clipboard.
  //
  // The page mirrors windows from several VW images at once, each with its own
  // tether and its own paste buffer, so every transfer is routed to the tether
  // belonging to the window that has focus.

  _installClipboardBridge() {
    this._clipboardBridgeBypass = true; // disable any stale listeners from prior versions
    var self = this;

    // Observe the DOM for new Snowglobe canvases and wrap them.
    this._clipboardObserver = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.tagName === 'CANVAS') self._wrapCanvasClipboard(node);
          if (node.querySelectorAll) {
            node.querySelectorAll('canvas').forEach(function(c) { self._wrapCanvasClipboard(c); });
          }
        }
      }
    });
    this._clipboardObserver.observe(document.body, { childList: true, subtree: true });

    // Wrap all existing Snowglobe canvases.
    document.querySelectorAll('morphic-window:not(#embeddedSqueak) canvas, transient-window canvas').forEach(function(c) {
      self._wrapCanvasClipboard(c);
    });
  }

  _wrapCanvasClipboard(canvas) {
    if (canvas._clipboardWrapped) return;
    var originalHandler = canvas._clipboardOriginalHandler || canvas.onkeydown;
    if (!originalHandler) return;
    canvas._clipboardWrapped = true;
    canvas._clipboardOriginalHandler = originalHandler;
    var self = this;

    canvas.onkeydown = function(e) {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'v' && e.key !== 'c' && e.key !== 'x')) {
        return originalHandler.call(this, e);
      }
      if (e._clipboardSynced) {
        return originalHandler.call(this, e);
      }
      var canvasEl = this;
      var forward = function() {
        e._clipboardSynced = true;
        originalHandler.call(canvasEl, e);
      };

      if (e.key === 'v') {
        // Paste: macOS clipboard → the owning image's paste buffer → Squeak handler
        Promise.all([
          fetch('/clipboard').then(function(r) { return r.json(); }),
          self._tetherForCanvas(canvasEl)
        ])
          .then(function(results) {
            var text = results[0] && results[0].text;
            var tether = results[1];
            if (!text || !tether) { forward(); return; }
            return tether.sendToTether('setClipboard:', [text]).then(forward);
          })
          .catch(forward);
      } else {
        // Copy/Cut: let Squeak handle first, then pull the paste buffer → macOS
        originalHandler.call(this, e);
        setTimeout(function() {
          self._tetherForCanvas(canvasEl)
            .then(function(tether) {
              if (!tether) return null;
              return tether.sendToTether('getClipboard', []);
            })
            .then(function(result) {
              var text = result && result.text;
              if (!text) return;
              fetch('/clipboard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text })
              });
            })
            .catch(function() {});
        }, 100);
      }
    };
  }
}

if (!customElements.get('icon-manager')) {
  customElements.define('icon-manager', IconManager);
}
