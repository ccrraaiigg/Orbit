// <morphic-window> Web Component
//
// Wraps a Morphic canvas in a decorated, draggable window with a titlebar.
//
// Usage:
//
//   var mw = document.createElement('morphic-window');
//   mw.setAttribute('caption', 'inspector');
//   mw.style.top = '100px';
//   mw.style.left = '200px';
//   mw.appendChild(canvas);
//   document.getElementById('Morphic').appendChild(mw);
//
// Titlebar buttons dispatch custom events:
//
//   mw.addEventListener('morphic-close', function() { ... });
//   mw.addEventListener('morphic-send-to-back', function() { ... });
//   mw.addEventListener('morphic-maximize', function() { ... });
//   mw.addEventListener('morphic-collapse', function() { ... });
//
// The 'title' attribute can be changed at any time to update the titlebar.
// Dragging the titlebar moves the window. Clicking the titlebar (without
// dragging) brings the window to the front. The send-to-back button moves
// the window behind all siblings. The window background tints teal on hover.

// Note: the resize-zone cursors use the platform's built-in `*-resize`
// cursors. Many alternatives were tried (SVG url() data-URI cursors,
// rotated SVG cursors, a `cursor: none` + JS-driven overlay <div>) to
// work around an Electron-on-macOS NSCursor invalidation flicker that
// shows the wrong cursor at certain border pixels. None defeated the
// underlying bug; see /memories/orbit-electron-cursor-flicker.md.

class MorphicWindow extends HTMLElement {

  static get observedAttributes() {
    return ['caption', 'title'];
  }

  // Single source of truth for instance methods that must be bound in
  // the constructor (and re-bound on hot-reload). Keep this list in sync
  // with the methods that get add/removeEventListener'd by name.
  static get _BOUND_METHODS() {
    return [
      '_onPointerMove',
      '_onPointerUp',
      '_onViewportResize',
      '_onResizePointerMove',
      '_onResizePointerUp'
    ];
  }

  // Tag names recognised as "windows" for cmd-click ancestor detection.
  // Note: _allWindows() (z-ordering) intentionally uses a smaller set.
  static get _WINDOW_TAGS() {
    return ['morphic-window', 'transient-window', 'workbook-window'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._windowState = 'normal';
    this._isTransitioning = false;
    this._transitionTimeScale = 1;
    this._normalGeometry = null;
    this._normalEmbeddedGeometry = null;
    this._dragging = false;
    this._didDrag = false;
    this._offsetX = 0;
    this._offsetY = 0;
    this._startX = 0;
    this._startY = 0;
    MorphicWindow._BOUND_METHODS.forEach(function(name) {
      this[name] = this[name].bind(this);
    }, this);
    this._resizing = false;
    this._resizeEdges = null; // { top, left, bottom, right } booleans
    this._resizeStartRect = null;
    this._resizeStartX = 0;
    this._resizeStartY = 0;
    this.onResizeComplete = null; // callback: function({x, y, width, height})
    // When true (default) the window switches to a chrome-only "cutout"
    // and fades its contents out during a resize drag, restoring them
    // when the drag ends. When false, contents stay visible and reflow
    // live as the window geometry changes (suitable for HTML content
    // such as <markdown-viewer>).
    this.useCutout = true;
  }

  static _allWindows() {
    // NB: intentionally excludes 'workbook-window' from the z-ordering pool.
    // Workbook windows manage their own stacking; only morphic + transient
    // windows participate in _bringToFront/_sendToBack.
    return Array.from(document.querySelectorAll('morphic-window, transient-window'));
  }

  // Reorder z-indices among morphic + transient windows. `position` is
  // 'top' (this window above all morphics) or 'bottom' (below all).
  // Transients always sit above morphics.
  _assignZ(position) {
    var self = this;
    var allWins = MorphicWindow._allWindows();
    var morphics = allWins.filter(function(w) {
      return w.tagName.toLowerCase() !== 'transient-window';
    });
    var transients = allWins.filter(function(w) {
      return w.tagName.toLowerCase() === 'transient-window';
    });
    if (morphics.length <= 1 && transients.length === 0) return;
    var others = morphics.filter(function(w) { return w !== self; });
    others.sort(function(a, b) {
      return (parseInt(a.style.zIndex, 10) || 0) - (parseInt(b.style.zIndex, 10) || 0);
    });
    if (position === 'top') {
      for (var i = 0; i < others.length; i++) others[i].style.zIndex = i;
      this.style.zIndex = others.length;
    } else {
      this.style.zIndex = 0;
      for (var j = 0; j < others.length; j++) others[j].style.zIndex = j + 1;
    }
    var transientBase = morphics.length;
    transients.sort(function(a, b) {
      return (parseInt(a.style.zIndex, 10) || 0) - (parseInt(b.style.zIndex, 10) || 0);
    });
    for (var k = 0; k < transients.length; k++) {
      transients[k].style.zIndex = transientBase + k;
    }
  }

  _bringToFront() { this._assignZ('top'); }
  _sendToBack()   { this._assignZ('bottom'); }

  _isMaximized() {
    return this._windowState === 'maximized';
  }

  _scaledMs(ms) {
    var scale = this._transitionTimeScale;
    if (typeof scale !== 'number' || !isFinite(scale) || scale <= 0) scale = 1;
    return Math.round(ms * scale);
  }

  _wait(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }

  _yieldToRenderer() {
    // Two rAFs to flush style + paint (start-of-frame + post-commit), then
    // a 100 ms slack timer to allow the SqueakJS VM to repaint its canvas
    // after a geometry change before we begin a fade-in transition.
    return new Promise(function(resolve) {
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          setTimeout(resolve, 100);
        });
      });
    });
  }

  _contentElements() {
    return Array.from(this.children);
  }

  _transitionOverlay() {
    return this.shadowRoot.querySelector('.transition-overlay');
  }

  _captureEmbeddedFrameDataUrl() {
    var iframe = this._embeddedIframe();
    var canvas = this._embeddedCanvas(iframe);
    if (!canvas) return null;
    try {
      return canvas.toDataURL();
    } catch (err) {
      // Cross-origin or tainted canvas: cutout-flicker fallback engages.
      console.debug('morphic-window: canvas toDataURL failed; cutout fallback in use', err);
      return null;
    }
  }

  _primeTransitionOverlay() {
    var overlay = this._transitionOverlay();
    if (!overlay) return false;

    var dataUrl = this._captureEmbeddedFrameDataUrl();
    if (!dataUrl) {
      overlay.style.opacity = '0';
      overlay.removeAttribute('src');
      return false;
    }

    overlay.style.transition = 'none';
    overlay.setAttribute('src', dataUrl);
    overlay.style.opacity = '0';
    return true;
  }

  _showTransitionOverlay() {
    var overlay = this._transitionOverlay();
    if (!overlay || !overlay.getAttribute('src')) return;
    overlay.style.transition = 'none';
    overlay.style.opacity = '1';
  }

  _setContentsOpacityImmediate(opacity) {
    var targets = this._contentElements();
    targets.forEach(function(el) {
      el.style.transition = 'none';
      el.style.opacity = String(opacity);
    });
  }

  _setCutoutMode(enabled) {
    var color = this._lockedFrameColor || 'rgb(192, 192, 192)';
    if (enabled) {
      // Contract: callers MUST clear the lingering 'transition: none' once
      // the cutout phase ends (the disable branch and _onResizePointerUp
      // both do this). Otherwise later transitions are silently suppressed.
      this.style.transition = 'none';
      this.style.background =
        'linear-gradient(' + color + ',' + color + ') top/100% 25px no-repeat,' +
        'linear-gradient(' + color + ',' + color + ') left/5px 100% no-repeat,' +
        'linear-gradient(' + color + ',' + color + ') right/5px 100% no-repeat,' +
        'linear-gradient(' + color + ',' + color + ') bottom/100% 5px no-repeat';
      this.getBoundingClientRect();
      return;
    }
    this.style.transition = 'none';
    this.style.removeProperty('background');
    this.style.backgroundColor = color;
    this.getBoundingClientRect();
    // Don't leave 'transition: none' lingering on the host — later
    // transitions (collapse fade, etc.) would be silently suppressed
    // or concatenated into invalid values like 'none, opacity 250ms'.
    this.style.removeProperty('transition');
  }

  async _fadeTransitionOverlayTo(opacity, durationMs) {
    var overlay = this._transitionOverlay();
    if (!overlay) {
      await this._wait(durationMs);
      return;
    }

    overlay.style.transition = 'opacity ' + durationMs + 'ms';
    overlay.style.opacity = String(opacity);
    await this._wait(durationMs);

    if (opacity <= 0) {
      overlay.removeAttribute('src');
    }
  }

  _setContentBackground(color) {
    var targets = this._contentElements();
    targets.forEach(function(el) {
      if (color) {
        el.style.backgroundColor = color;
      } else {
        el.style.removeProperty('background-color');
      }
    });
  }

  async _fadeContentsTo(opacity, durationMs) {
    var targets = this._contentElements();
    if (!targets.length) {
      await this._wait(durationMs);
      return;
    }

    targets.forEach(function(el) {
      el.style.transition = 'opacity ' + durationMs + 'ms linear';
      el.style.opacity = String(opacity);
    });

    await this._wait(durationMs);
  }

  _rectSnapshot() {
    var rect = this.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    };
  }

  _applyRectGeometry(rect) {
    this.style.top = rect.top + 'px';
    this.style.left = rect.left + 'px';
    this.style.width = rect.width + 'px';
    this.style.height = rect.height + 'px';
  }

  async _animateGeometryToRect(targetRect, durationMs) {
    var startRect = this._rectSnapshot();
    var previousTransition = this.style.transition || '';

    this.style.position = 'fixed';
    this.style.right = 'auto';
    this.style.bottom = 'auto';
    this.style.margin = '0';
    this._applyRectGeometry(startRect);

    // Force style flush so the next assignment transitions from the start rect.
    this.getBoundingClientRect();

    this.style.transition = 'top ' + durationMs + 'ms, left ' + durationMs + 'ms, width ' + durationMs + 'ms, height ' + durationMs + 'ms';
    this._applyRectGeometry(targetRect);
    await this._wait(durationMs);
    this.style.transition = previousTransition;
  }

  _measureRectForGeometry(geometry) {
    var currentGeometry = this._captureGeometry();
    var previousTransition = this.style.transition || '';

    this.style.transition = 'none';
    this._restoreGeometry(geometry);
    var target = this._rectSnapshot();
    this._restoreGeometry(currentGeometry);
    this.style.transition = previousTransition;

    return target;
  }

  _captureGeometry() {
    return {
      position: this.style.position,
      top: this.style.top,
      left: this.style.left,
      right: this.style.right,
      bottom: this.style.bottom,
      width: this.style.width,
      height: this.style.height,
      margin: this.style.margin
    };
  }

  _restoreGeometry(geometry) {
    var self = this;
    ['position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'margin'].forEach(function(prop) {
      var val = geometry ? geometry[prop] : '';
      if (val) {
        self.style[prop] = val;
      } else {
        self.style.removeProperty(prop);
      }
    });
  }

  _embeddedIframe() {
    return this.querySelector('iframe');
  }

  _embeddedCanvas(iframe) {
    if (!iframe || !iframe.contentDocument) return null;
    return iframe.contentDocument.querySelector('canvas');
  }

  _captureEmbeddedGeometry() {
    var iframe = this._embeddedIframe();
    if (!iframe) return null;

    var canvas = this._embeddedCanvas(iframe);
    var state = {
      iframeWidthAttr: iframe.getAttribute('width'),
      iframeHeightAttr: iframe.getAttribute('height'),
      iframeStyleWidth: iframe.style.width,
      iframeStyleHeight: iframe.style.height
    };

    if (canvas) {
      state.canvasWidth = canvas.width;
      state.canvasHeight = canvas.height;
      state.canvasStyleWidth = canvas.style.width;
      state.canvasStyleHeight = canvas.style.height;
    }

    return state;
  }

  _restoreEmbeddedGeometry(state, suppressResizeEvent) {
    var iframe = this._embeddedIframe();
    if (!iframe || !state) return;

    if (state.iframeWidthAttr) iframe.setAttribute('width', state.iframeWidthAttr);
    else iframe.removeAttribute('width');
    if (state.iframeHeightAttr) iframe.setAttribute('height', state.iframeHeightAttr);
    else iframe.removeAttribute('height');

    iframe.style.width = state.iframeStyleWidth || '';
    iframe.style.height = state.iframeStyleHeight || '';

    var canvas = this._embeddedCanvas(iframe);
    if (canvas) {
      var restoreWidth = typeof state.canvasWidth === 'number' ? state.canvasWidth : canvas.width;
      var restoreHeight = typeof state.canvasHeight === 'number' ? state.canvasHeight : canvas.height;
      canvas.width = restoreWidth;
      canvas.height = restoreHeight;
      canvas.style.width = restoreWidth + 'px';
      canvas.style.height = restoreHeight + 'px';
      canvas.style.width = state.canvasStyleWidth || '';
      canvas.style.height = state.canvasStyleHeight || '';
    }

    if (!suppressResizeEvent && iframe.contentWindow) iframe.contentWindow.dispatchEvent(new Event('resize'));
  }

  // Total width and height contributed by the window's decoration (titlebar
  // and padding around the slotted content area). Subtract these from the
  // host's clientWidth/clientHeight to get the content area's extent.
  // Returns { width, height } in CSS pixels. Works before the element is
  // connected to the DOM (when getComputedStyle returns empty values) by
  // falling back to the known defaults defined in the :host CSS rule
  // (padding: 25px 5px 5px 5px).
  get borderExtent() {
    if (this.isConnected) {
      var cs = getComputedStyle(this);
      var w = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      var h = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      if (!isNaN(w) && !isNaN(h)) return { width: w, height: h };
    }
    return { width: 10, height: 30 };
  }

  _resizeEmbeddedSurfaceToWindow() {
    var iframe = this._embeddedIframe();
    if (!iframe) return;

    var be = this.borderExtent;
    var width = Math.max(1, Math.floor(this.clientWidth - be.width));
    var height = Math.max(1, Math.floor(this.clientHeight - be.height));

    iframe.setAttribute('width', String(width));
    iframe.setAttribute('height', String(height));
    iframe.style.width = width + 'px';
    iframe.style.height = height + 'px';

    var canvas = this._embeddedCanvas(iframe);
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
    }

    if (iframe.contentWindow) iframe.contentWindow.dispatchEvent(new Event('resize'));
  }

  _restoreRectFromSavedState() {
    var target = this._measureRectForGeometry(this._normalGeometry);
    var embedded = this._normalEmbeddedGeometry || {};

    if (!this._normalGeometry.width && embedded.iframeWidthAttr) {
      var w = parseFloat(embedded.iframeWidthAttr);
      if (isFinite(w) && w > 0) target.width = w + 10;
    }
    if (!this._normalGeometry.height && embedded.iframeHeightAttr) {
      var h = parseFloat(embedded.iframeHeightAttr);
      if (isFinite(h) && h > 0) target.height = h + 30;
    }

    return target;
  }

  _onViewportResize() {
    if (!this._isMaximized()) return;
    this._resizeEmbeddedSurfaceToWindow();
  }

  async _maximize() {
    this._normalGeometry = this._captureGeometry();
    this._normalEmbeddedGeometry = this._captureEmbeddedGeometry();

    // Switch to cutout (invisible because content fills the area)
    this._setCutoutMode(true);

    // Phase 1: Fade content → dissolves to reveal cutout
    await this._fadeContentsTo(0, this._scaledMs(250));

    // Phase 2: Geometry animation with cutout visible
    await this._animateGeometryToRect({
      top: 0,
      left: 0,
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight)
    }, this._scaledMs(500));

    this._windowState = 'maximized';
    this.style.position = 'fixed';
    this.style.top = '0px';
    this.style.left = '0px';
    this.style.right = 'auto';
    this.style.bottom = 'auto';
    this.style.width = '100vw';
    this.style.height = '100vh';
    this.style.margin = '0';

    // Resize to final dimensions, then yield so the VM redraw
    // completes before the fade-in transition starts.
    this._resizeEmbeddedSurfaceToWindow();
    await this._yieldToRenderer();

    this._bringToFront();

    // Phase 3: Fade content back in (from cutout)
    await this._fadeContentsTo(1, this._scaledMs(250));

    // Restore solid host bg
    this._setCutoutMode(false);
  }

  async _restoreNormal() {
    if (!this._normalGeometry) {
      this._windowState = 'normal';
      return;
    }

    var targetRect = this._restoreRectFromSavedState();

    // Switch to cutout (invisible because content fills the area)
    this._setCutoutMode(true);

    // Phase 1: Fade content → dissolves to reveal cutout
    await this._fadeContentsTo(0, this._scaledMs(250));

    // Phase 2: Geometry animation with cutout visible
    await this._animateGeometryToRect(targetRect, this._scaledMs(500));

    this._restoreGeometry(this._normalGeometry);
    this._restoreEmbeddedGeometry(this._normalEmbeddedGeometry);
    this._windowState = 'normal';
    this._normalGeometry = null;
    this._normalEmbeddedGeometry = null;

    // Yield so the VM redraw from geometry restore completes
    // before the fade-in transition starts.
    await this._yieldToRenderer();

    this._bringToFront();

    // Phase 3: Fade content back in (from cutout)
    await this._fadeContentsTo(1, this._scaledMs(250));

    // Restore solid host bg
    this._setCutoutMode(false);
  }

  async _toggleMaximize() {
    if (this._isTransitioning) return this._windowState;
    this._isTransitioning = true;

    // Lock the frame color so hover changes can't alter it mid-transition.
    this._lockedFrameColor = getComputedStyle(this).backgroundColor || 'rgb(192, 192, 192)';

    try {
      if (this._isMaximized()) {
        await this._restoreNormal();
      } else {
        await this._maximize();
      }
      return this._windowState;
    } catch (err) {
      // If maximize/restore failed mid-flight, force a coherent visible
      // state instead of leaving the window half-faded with cutout chrome.
      try { this._setCutoutMode(false); } catch (_) {}
      try { this._setContentsOpacityImmediate(1); } catch (_) {}
      throw err;
    } finally {
      // Release the frame color lock without a visible transition.
      this.style.transition = 'none';
      this.style.removeProperty('background-color');
      this.getBoundingClientRect();
      this.style.removeProperty('transition');
      delete this._lockedFrameColor;
      this._isTransitioning = false;
    }
  }

  connectedCallback() {
    // Move 'title' to 'caption' to suppress native tooltip
    if (this.hasAttribute('title') && !this.hasAttribute('caption')) {
      this.setAttribute('caption', this.getAttribute('title'));
    }
    if (this.hasAttribute('title')) this.removeAttribute('title');
    this._dragging = false;
    this._didDrag = false;
    this._render();
    this._attachBehavior();
    window.addEventListener('resize', this._onViewportResize);
  }

  disconnectedCallback() {
    // The titlebar inside shadowRoot will be GC'd along with this element;
    // its listeners are bound to closures that don't outlive it, so we don't
    // need to remove them. Only listeners attached to objects that outlive
    // this element (window, document) need explicit cleanup.
    window.removeEventListener('resize', this._onViewportResize);
  }

  attributeChangedCallback(name) {
    if (name === 'title') {
      // Redirect 'title' to 'caption' and remove to suppress native tooltip
      var val = this.getAttribute('title');
      if (val) this.setAttribute('caption', val);
      this.removeAttribute('title');
      return;
    }
    if (name === 'caption') {
      var span = this.shadowRoot.querySelector('.title-text');
      if (span) span.textContent = this.getAttribute('caption') || '';
    }
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          position: absolute;
          z-index: 100;
          isolation: isolate;
          background-color: #c0c0c0;
          border-radius: 7px;
          padding: 25px 5px 5px 5px;
          transition: background-color 200ms;
        }
        :host(:hover) {
          background-color: #a8c8c8;
        }
        .titlebar {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 25px;
          display: flex;
          align-items: center;
          padding: 0 6px;
          user-select: none;
          cursor: grab;
        }
        .title-text {
          flex: 1;
          text-align: left;
          color: black;
          font-family: sans-serif;
          font-size: 13px;
          font-weight: bold;
          font-style: italic;
          margin-left: 9px;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
        .btn {
          cursor: pointer;
          flex-shrink: 0;
          transition: filter 150ms;
        }
        .btn:hover {
          filter: brightness(1.3);
        }
        .btn + .btn {
          margin-left: 3px;
        }
        .title-text + .btn {
          margin-left: 3px;
        }
        ::slotted([slot="titlebar-extras"]) {
          margin-left: 3px;
          margin-right: 12px;
          flex-shrink: 0;
        }
        .transition-overlay {
          position: absolute;
          top: 25px;
          left: 5px;
          right: 5px;
          bottom: 5px;
          width: calc(100% - 10px);
          height: calc(100% - 30px);
          object-fit: fill;
          opacity: 0;
          pointer-events: none;
          z-index: 5;
          background: transparent;
        }
        ::slotted(*) {
          border-bottom-left-radius: 7px;
          border-bottom-right-radius: 7px;
          overflow: hidden;
          user-select: none;
          -webkit-user-select: none;
        }
        .content-bg {
          position: absolute;
          top: 25px;
          left: 5px;
          right: 5px;
          bottom: 5px;
          pointer-events: none;
          z-index: -1;
        }
        .resize-zone {
          position: absolute;
          /* Small non-zero alpha forces participation in painting & hit-testing
             across browsers/compositor states; pure transparent has been
             observed to be optimized out, causing position-dependent cursor
             flicker. The chosen alpha is below the human visibility threshold. */
          background: rgba(0, 0, 0, 0.012);
          z-index: 10;
        }
        .resize-zone.edge-top,
        .resize-zone.edge-bottom { cursor: ns-resize; }
        .resize-zone.edge-left,
        .resize-zone.edge-right  { cursor: ew-resize; }
        .resize-zone.corner-tl,
        .resize-zone.corner-br   { cursor: nwse-resize; }
        .resize-zone.corner-tr,
        .resize-zone.corner-bl   { cursor: nesw-resize; }
        .resize-zone.edge-top    { top: 0;    left: 7px;  right: 7px; height: 5px; }
        .resize-zone.edge-bottom { bottom: 0; left: 7px;  right: 7px; height: 5px; }
        .resize-zone.edge-left   { left: 0;   top: 7px;  bottom: 7px; width: 5px;  }
        .resize-zone.edge-right  { right: 0;  top: 7px;  bottom: 7px; width: 5px;  }
        .resize-zone.corner-tl   { top: 0;    left: 0;  width: 7px;  height: 7px; }
        .resize-zone.corner-tr   { top: 0;    right: 0; width: 7px;  height: 7px; }
        .resize-zone.corner-bl   { bottom: 0; left: 0;  width: 7px;  height: 7px; }
        .resize-zone.corner-br   { bottom: 0; right: 0; width: 7px;  height: 7px; }
        /* While the command key is held, show the open-hand cursor over
           the whole window (host, resize zones, and slotted content),
           matching the titlebar's drag affordance. */
        :host(.cmd-held) { cursor: grab; }
        :host(.cmd-held) .titlebar,
        :host(.cmd-held) .resize-zone { cursor: grab; }
        :host(.cmd-held) ::slotted(*) { cursor: grab; }
        /* During a cmd-drag move, switch to the closed-hand cursor,
           matching the titlebar drag. Listed after .cmd-held so it
           wins via source order at equal specificity. */
        :host(.cmd-dragging) { cursor: grabbing; }
        :host(.cmd-dragging) .titlebar,
        :host(.cmd-dragging) .resize-zone { cursor: grabbing; }
        :host(.cmd-dragging) ::slotted(*) { cursor: grabbing; }
      </style>
      <div class="titlebar">
        <svg class="btn" id="close-button" width="15" height="15" viewBox="0 0 15 15">
          <circle cx="7.5" cy="7.5" r="6.5" fill="#e25c4f" stroke="#c94434" stroke-width="0.5"/>
          <line x1="4.5" y1="4.5" x2="10.5" y2="10.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="10.5" y1="4.5" x2="4.5" y2="10.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <span class="title-text"></span>
        <slot name="titlebar-extras"></slot>
        <svg class="btn" id="send-to-back-button" width="15" height="15" viewBox="0 0 15 15">
          <circle cx="7.5" cy="7.5" r="6.5" fill="#5b86e5" stroke="#4a6fc0" stroke-width="0.5"/>
          <polyline points="4.5,6 7.5,10 10.5,6" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <svg class="btn" id="maximize-button" width="15" height="15" viewBox="0 0 15 15">
          <circle cx="7.5" cy="7.5" r="6.5" fill="#50b948" stroke="#3d9a32" stroke-width="0.5"/>
          <line x1="7.5" y1="4" x2="7.5" y2="11" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="4" y1="7.5" x2="11" y2="7.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <svg class="btn" id="collapse-button" width="15" height="15" viewBox="0 0 15 15">
          <circle cx="7.5" cy="7.5" r="6.5" fill="#e87d2e" stroke="#c96a22" stroke-width="0.5"/>
          <line x1="4" y1="7.5" x2="11" y2="7.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>
      <img class="transition-overlay" alt="" aria-hidden="true" />
      <div class="content-bg"></div>
      <slot></slot>
      <div class="resize-zone edge-top"    data-edges="t"></div>
      <div class="resize-zone edge-bottom" data-edges="b"></div>
      <div class="resize-zone edge-left"   data-edges="l"></div>
      <div class="resize-zone edge-right"  data-edges="r"></div>
      <div class="resize-zone corner-tl"   data-edges="tl"></div>
      <div class="resize-zone corner-tr"   data-edges="tr"></div>
      <div class="resize-zone corner-bl"   data-edges="bl"></div>
      <div class="resize-zone corner-br"   data-edges="br"></div>
    `;
    // Set caption via textContent (NOT innerHTML) to prevent XSS via the
    // 'caption' attribute, whose values come from remote Smalltalk window
    // titles and are not trusted as HTML.
    var titleSpan = this.shadowRoot.querySelector('.title-text');
    if (titleSpan) titleSpan.textContent = this.getAttribute('caption') || '';
  }

  _attachBehavior() {
    var self = this;
    var titlebar = this.shadowRoot.querySelector('.titlebar');
    var buttons = this.shadowRoot.querySelectorAll('.btn');

    // Modifier-click handling (cmd/opt/ctrl) is installed once per
    // page at the window level so it runs before any per-instance
    // capture-phase handlers in transient-window/workbook-window/etc.
    MorphicWindow._installGlobalModifierClickHandler();
    MorphicWindow._installGlobalCmdCursorHandler();
    this._installIframeModifierClickHandlers();

    // Resize zones in the shadow DOM provide native CSS cursors and
    // pointerdown handlers. Native cursor styles avoid the one-frame
    // lag of setting host.style.cursor from a pointermove handler.
    var edgesByCode = {
      t:  { top: true,  bottom: false, left: false, right: false },
      b:  { top: false, bottom: true,  left: false, right: false },
      l:  { top: false, bottom: false, left: true,  right: false },
      r:  { top: false, bottom: false, left: false, right: true  },
      tl: { top: true,  bottom: false, left: true,  right: false },
      tr: { top: true,  bottom: false, left: false, right: true  },
      bl: { top: false, bottom: true,  left: true,  right: false },
      br: { top: false, bottom: true,  left: false, right: true  }
    };
    this.shadowRoot.querySelectorAll('.resize-zone').forEach(function(zone) {
      zone.addEventListener('pointerdown', function(e) {
        if (self._isMaximized()) return;
        var edges = edgesByCode[zone.dataset.edges];
        if (!edges) return;
        self._bringToFront();
        self._startResizeWithEdges(e, edges);
      });
    });

    this.removeEventListener('pointermove', this._onResizePointerMove);
    this.removeEventListener('pointerup', this._onResizePointerUp);
    this.addEventListener('pointermove', this._onResizePointerMove);
    this.addEventListener('pointerup', this._onResizePointerUp);

    // Buttons stop propagation so they don't trigger drag or bring-to-front
    buttons.forEach(function(btn) {
      btn.addEventListener('mousedown', function(e) { e.stopPropagation(); });
      btn.addEventListener('pointerdown', function(e) { e.stopPropagation(); });
      btn.addEventListener('click', function(e) { e.stopPropagation(); });
    });

    // Button click events
    this.shadowRoot.getElementById('close-button').addEventListener('click', function(e) {
      e.stopPropagation();
      self.style.opacity = '0.8';
      self.dispatchEvent(new CustomEvent('morphic-close', { bubbles: true }));
    });

    this.shadowRoot.getElementById('send-to-back-button').addEventListener('click', function(e) {
      e.stopPropagation();
      self._sendToBack();
      self.dispatchEvent(new CustomEvent('morphic-send-to-back', { bubbles: true }));
    });

    this.shadowRoot.getElementById('maximize-button').addEventListener('click', function(e) {
      e.stopPropagation();
      self._toggleMaximize().then(function(state) {
        self.dispatchEvent(new CustomEvent('morphic-maximize', {
          bubbles: true,
          detail: { state: state }
        }));
      });
    });

    this.shadowRoot.getElementById('collapse-button').addEventListener('click', function(e) {
      e.stopPropagation();
      self.collapse();
    });

    // Drag by titlebar using pointer capture
    titlebar.addEventListener('pointerdown', function(e) {
      // Don't start a drag for clicks on user-supplied titlebar extras
      // (e.g. a markdown-viewer reload button slotted into the titlebar).
      // Such elements opt out by carrying [data-no-drag] or by being
      // assigned to the named titlebar-extras slot.
      var t = e.target;
      if (t && (t.closest && (t.closest('[data-no-drag]') ||
                              t.closest('[slot="titlebar-extras"]')))) {
        return;
      }
      if (self._isMaximized()) {
        self._bringToFront();
        e.preventDefault();
        return;
      }
      self._dragging = true;
      self._didDrag = false;
      titlebar.style.cursor = 'grabbing';
      self._startX = e.clientX;
      self._startY = e.clientY;
      var rect = self.getBoundingClientRect();
      self._offsetX = e.clientX - rect.left;
      self._offsetY = e.clientY - rect.top;
      titlebar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    titlebar.addEventListener('pointermove', this._onPointerMove);
    titlebar.addEventListener('pointerup', this._onPointerUp);

    // Suppress page-wide text-selection drags initiated inside slotted
    // content. `::slotted(*) { user-select: none }` prevents text inside
    // the window from being selected, but it does NOT stop the browser
    // from starting a selection-drag on mousedown that then extends out
    // into selectable text elsewhere on the page (the rest of the body,
    // other windows, etc.). preventDefault() on the underlying mousedown
    // blocks that. Skip iframes (they own their own selection) and any
    // editable / form / anchor target where the default action matters.
    var slot = this.shadowRoot.querySelector('slot:not([name])');
    if (slot) {
      slot.addEventListener('mousedown', function(e) {
        var t = e.target;
        if (!t) return;
        if (t.tagName === 'IFRAME') return;
        if (t.closest && t.closest(
          'iframe, input, textarea, select, button, a, ' +
          '[contenteditable=""], [contenteditable="true"]'
        )) return;
        e.preventDefault();
      });
    }

    this._bringToFront();
  }

  _startResizeWithEdges(e, edges) {
    if (this._isMaximized()) return false;

    this._resizing = true;
    this._resizeEdges = edges;
    this._resizeStartX = e.clientX;
    this._resizeStartY = e.clientY;
    var rect = this.getBoundingClientRect();
    this._resizeStartRect = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };

    // Switch to cutout and fade contents out so the stale canvas
    // doesn't show during the drag. Frame chrome remains visible and
    // is what the user sees being dragged/resized in real time.
    // Skipped when useCutout is false so the contents (e.g. HTML)
    // can reflow live during the drag.
    if (this.useCutout) {
      this._setCutoutMode(true);
      this._fadeContentsTo(0, this._scaledMs(150));
    }

    this.setPointerCapture(e.pointerId);
    this._resizePointerId = e.pointerId;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  _onResizePointerMove(e) {
    if (!this._resizing) return;
    var dx = e.clientX - this._resizeStartX;
    var dy = e.clientY - this._resizeStartY;
    var r = this._resizeStartRect;
    var edges = this._resizeEdges;
    var minW = 100;
    var minH = 60;

    var top = r.top;
    var left = r.left;
    var width = r.width;
    var height = r.height;

    if (edges.right) {
      width = Math.max(minW, r.width + dx);
    }
    if (edges.left) {
      var newW = r.width - dx;
      if (newW >= minW) {
        left = r.left + dx;
        width = newW;
      } else {
        left = r.left + (r.width - minW);
        width = minW;
      }
    }
    if (edges.bottom) {
      height = Math.max(minH, r.height + dy);
    }
    if (edges.top) {
      var newH = r.height - dy;
      if (newH >= minH) {
        top = r.top + dy;
        height = newH;
      } else {
        top = r.top + (r.height - minH);
        height = minH;
      }
    }

    // Animate the cutout window itself by updating its geometry live.
    this.style.transition = 'none';
    this.style.left = left + 'px';
    this.style.top = top + 'px';
    this.style.width = width + 'px';
    this.style.height = height + 'px';
  }

  async _onResizePointerUp(e) {
    if (!this._resizing) return;
    this._resizing = false;
    try { this.releasePointerCapture(this._resizePointerId); } catch (_) {}

    // _onResizePointerMove pinned style.transition to 'none' on every
    // move to prevent animating live geometry changes. Clear it now so
    // later transitions (collapse fade, maximize, etc.) aren't blocked
    // or concatenated into an invalid 'none, opacity 250ms' value.
    this.style.removeProperty('transition');

    var newLeft = parseFloat(this.style.left);
    var newTop = parseFloat(this.style.top);
    var newWidth = parseFloat(this.style.width);
    var newHeight = parseFloat(this.style.height);

    this.style.cursor = '';

    // Chrome (titlebar + side/bottom borders) is owned entirely by
    // this component; the callback receives only the inner canvas
    // dimensions. The callback must invoke the `done` function when
    // the remote resize has actually finished (e.g. after the
    // SqueakJS VM has processed the WebSocket round-trip and
    // repainted). The fade-in is held until `done` is called.
    var remoteDonePromise = Promise.resolve();
    if (typeof this.onResizeComplete === 'function') {
      var sideBorder = this.sideBorderThickness();
      var titlebar = this.titlebarThickness();
      var resolveDone;
      remoteDonePromise = new Promise(function(resolve) { resolveDone = resolve; });
      var done = function() { resolveDone(); };
      this.onResizeComplete({
        x: Math.round(newLeft) + sideBorder,
        y: Math.round(newTop) + titlebar,
        width: Math.round(newWidth) - 2 * sideBorder,
        height: Math.round(newHeight) - titlebar - sideBorder,
        done: done
      });
    }

    await remoteDonePromise;
    if (this.useCutout) {
      await this._fadeContentsTo(1, this._scaledMs(350));
      this._setCutoutMode(false);
    }
  }

  _onPointerMove(e) {
    if (!this._dragging) return;
    var dx = e.clientX - this._startX;
    var dy = e.clientY - this._startY;
    if (!this._didDrag && (dx * dx + dy * dy) < 9) return;
    this._didDrag = true;
    this.style.left = (e.clientX - this._offsetX) + 'px';
    this.style.top = (e.clientY - this._offsetY) + 'px';
  }

  _onPointerUp(e) {
    try {
      if (this._dragging && !this._didDrag) {
        // Click without drag: bring to front
        this._bringToFront();
      }
      var titlebar = this.shadowRoot.querySelector('.titlebar');
      if (titlebar) {
        try { titlebar.releasePointerCapture(e.pointerId); } catch (_) {}
        titlebar.style.cursor = '';
      }
    } finally {
      this._dragging = false;
      this._didDrag = false;
      this.style.cursor = '';
    }
  }

  toggleMaximize() {
    return this._toggleMaximize();
  }

  // Modifier-click model:
  //   cmd-drag   -> move window (the gesture is fully buffered until
  //                 the pointer crosses a small threshold; nothing
  //                 leaks to the window content during arming)
  //   cmd-click  -> pass through to the window content (e.g. Squeak
  //                 in an iframe). The pointerdown is suppressed at
  //                 first and the full pointerdown/mousedown/
  //                 pointerup/mouseup/click sequence is synthesized
  //                 onto the original target once we know the user
  //                 isn't dragging.
  //   opt-click  -> collapse
  //
  // Installed once at the window level (capture phase) so it runs
  // before per-instance pointerdown handlers (transient-window and
  // workbook-window register raise-on-pointerdown listeners). Iframes
  // get their own document-level installer because their pointerdown
  // events never bubble out to the parent document.
  static _installGlobalModifierClickHandler() {
    if (window._morphicModifierClickInstalled) return;
    var topHandler = function(e) {
      MorphicWindow._handleModifierEvent(e, null);
    };
    window.addEventListener('pointerdown', topHandler, true);
    window.addEventListener('mousedown', topHandler, true);
    window._morphicModifierClickInstalled = true;
  }

  // Toggles a 'cmd-held' class on every morphic-window element while
  // the Meta (command) key is held, so CSS can switch the cursor to
  // 'grab' (open hand) over the whole window — matching the titlebar's
  // drag affordance and previewing the cmd-drag gesture.
  static _installGlobalCmdCursorHandler() {
    if (window._morphicCmdCursorInstalled) return;
    window.addEventListener('keydown', function(e) {
      if (e.key === 'Meta' || e.metaKey) MorphicWindow._setCmdHeld(true);
    }, true);
    window.addEventListener('keyup', function(e) {
      // After a Meta keyup, metaKey on the event itself is false.
      if (e.key === 'Meta' || !e.metaKey) MorphicWindow._setCmdHeld(false);
    }, true);
    window.addEventListener('blur', function() {
      MorphicWindow._setCmdHeld(false);
    }, true);
    window._morphicCmdCursorInstalled = true;
  }

  // Toggle the cmd-held visual state across the host page and any
  // tracked iframe documents (SqueakJS in the Caffeine window, etc.).
  // Maximized windows are skipped: cmd-drag does nothing on them, so
  // showing the open-hand cursor would be misleading.
  static _setCmdHeld(on) {
    document.querySelectorAll('morphic-window').forEach(function(mw) {
      if (on && typeof mw._isMaximized === 'function' && mw._isMaximized()) {
        mw.classList.remove('cmd-held');
        return;
      }
      mw.classList.toggle('cmd-held', !!on);
    });
    var docs = MorphicWindow._cmdCursorDocs;
    if (!docs) return;
    docs.forEach(function(doc) {
      try {
        if (!doc || !doc.documentElement) return;
        // Skip iframes whose enclosing morphic-window is maximized.
        var apply = !!on;
        if (apply) {
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            if (iframes[i].contentDocument === doc) {
              var host = MorphicWindow._findWindowAncestor(iframes[i]);
              if (host && typeof host._isMaximized === 'function' && host._isMaximized()) {
                apply = false;
              }
              break;
            }
          }
        }
        doc.documentElement.classList.toggle('morphic-cmd-held', apply);
      } catch (_) { /* cross-origin; ignore */ }
    });
  }

  // Toggle the cmd-drag (closed-hand) visual state on a single
  // morphic-window and across all tracked iframe documents. We apply
  // the iframe cursor globally so the cursor stays 'grabbing' even
  // when the pointer passes over an iframe whose pointer-events were
  // disabled for the duration of the drag.
  static _setCmdDragging(win, on) {
    if (win) win.classList.toggle('cmd-dragging', !!on);
    var docs = MorphicWindow._cmdCursorDocs;
    if (!docs) return;
    docs.forEach(function(doc) {
      try {
        if (!doc || !doc.documentElement) return;
        doc.documentElement.classList.toggle('morphic-cmd-dragging', !!on);
      } catch (_) { /* ignore */ }
    });
  }

  // Register an iframe's document so its cursor and keyboard state
  // participate in cmd-held tracking. Injects a stylesheet that
  // forces `cursor: grab` over the whole iframe while the html
  // element carries the 'morphic-cmd-held' class.
  static _registerCmdCursorDoc(doc) {
    if (!doc || !doc.documentElement) return;
    if (!MorphicWindow._cmdCursorDocs) MorphicWindow._cmdCursorDocs = new Set();
    var alreadyRegistered = MorphicWindow._cmdCursorDocs.has(doc);
    MorphicWindow._cmdCursorDocs.add(doc);
    var cursorCss =
      'html.morphic-cmd-held, html.morphic-cmd-held * { cursor: grab !important; }\n' +
      'html.morphic-cmd-dragging, html.morphic-cmd-dragging * { cursor: grabbing !important; }';
    try {
      var style = doc.getElementById('morphic-cmd-cursor-style');
      if (!style) {
        style = doc.createElement('style');
        style.id = 'morphic-cmd-cursor-style';
        (doc.head || doc.documentElement).appendChild(style);
      }
      // Refresh content so hot-reloads picking up new rules apply
      // immediately without recreating the element.
      if (style.textContent !== cursorCss) style.textContent = cursorCss;
    } catch (_) { /* ignore */ }
    if (alreadyRegistered) return;
    var keydown = function(e) {
      if (e.key === 'Meta' || e.metaKey) MorphicWindow._setCmdHeld(true);
    };
    var keyup = function(e) {
      if (e.key === 'Meta' || !e.metaKey) MorphicWindow._setCmdHeld(false);
    };
    var blur = function() { MorphicWindow._setCmdHeld(false); };
    try {
      doc.addEventListener('keydown', keydown, true);
      doc.addEventListener('keyup', keyup, true);
      if (doc.defaultView) doc.defaultView.addEventListener('blur', blur, true);
    } catch (_) { /* ignore */ }
  }

  static _isWindowEl(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    return MorphicWindow._WINDOW_TAGS.indexOf(tag) !== -1;
  }

  static _findWindowInPath(path) {
    for (var i = 0; i < path.length; i++) {
      if (MorphicWindow._isWindowEl(path[i])) return path[i];
    }
    return null;
  }

  static _findWindowAncestor(el) {
    var node = el;
    while (node) {
      if (MorphicWindow._isWindowEl(node)) return node;
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return null;
  }

  static _handleModifierEvent(e, sourceIframe) {
    // Ignore synthesized events (e.g. the ones _synthesizeClick
    // dispatches on the no-drag path); only real user gestures should
    // initiate arming. Without this guard, the synthetic pointerdown
    // dispatched after a cmd-click would re-enter _beginArming and
    // loop forever.
    if (e.isTrusted === false) return;
    var meta = !!e.metaKey, alt = !!e.altKey;
    // Only handle plain cmd or plain opt (and never with ctrl).
    if (e.ctrlKey) return;
    var n = (meta?1:0) + (alt?1:0);
    if (n !== 1) return;
    if (e.button !== 0) return;
    var win = sourceIframe
      ? MorphicWindow._findWindowAncestor(sourceIframe)
      : MorphicWindow._findWindowInPath(e.composedPath());
    if (!win) return;
    if (alt) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (typeof win.collapse === 'function') win.collapse();
      return;
    }
    // cmd: buffer the entire mouse/pointer gesture. The underlying
    // content (e.g. Squeak in an iframe) must not see the gesture
    // until we know whether the user is dragging the window or just
    // clicking. If it's a click (no drag), we synthesize the full
    // pointerdown/mousedown/pointerup/mouseup/click sequence onto the
    // original target so Squeak receives a coherent cmd-click.
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    // Don't start a new gesture while one is in flight. Single source
    // of truth is the global arm state; per-window flags can go stale.
    if (window.__morphicArmState || win._modifierDragging) return;
    if (e.type !== 'pointerdown') return;
    MorphicWindow._beginArming(win, e, sourceIframe);
  }

  // Single-persistent-dispatcher design: one static listener is
  // installed once on window/document/iframe-docs. It consults the
  // single window-global `__morphicArmState`; when null (the common
  // case) it returns immediately. No per-session closures are created,
  // so cmd-click gestures cannot leak listeners that strand the page.
  // Using a window-global (rather than a class-static) ensures that
  // hot-reloads which create a new MorphicWindow class object in an
  // eval scope still share the same state location.
  static _beginArming(win, e, sourceIframe) {
    // We arm even for maximized windows: cmd-click still needs to
    // pass through to the underlying content (the no-drag synth-click
    // path doesn't require window motion). _startModifierDrag itself
    // guards against drag on maximized windows.
    if (window.__morphicArmState) return; // already arming a gesture

    var origTarget = e.target;
    var origDoc = (origTarget && origTarget.ownerDocument) || document;
    var origView = origDoc.defaultView || window;
    var iframeOX = 0, iframeOY = 0;
    if (sourceIframe) {
      var r = sourceIframe.getBoundingClientRect();
      iframeOX = r.left; iframeOY = r.top;
    }

    var st = {
      win: win,
      sourceIframe: sourceIframe,
      origTarget: origTarget,
      origView: origView,
      origPointerId: e.pointerId,
      origPointerType: e.pointerType || 'mouse',
      downSrcX: e.clientX,   downSrcY: e.clientY,
      downScreenX: e.screenX, downScreenY: e.screenY,
      iframeOX: iframeOX,    iframeOY: iframeOY,
      startX: e.clientX + iframeOX,
      startY: e.clientY + iframeOY,
      threshold: 4,
      decided: false,
      captured: false,
      safetyTimer: null,
      bailListener: null
    };
    MorphicWindow._armState = st;
    window.__morphicArmState = st;
    win._modifierArming = true;

    MorphicWindow._installArmDispatchers();

    // Explicit pointer capture on the morphic-window element so that
    // subsequent pointer events for this pointer reliably surface in
    // the outer document, even if the cursor leaves the page or roams
    // over iframes we can't introspect.
    try {
      if (typeof win.setPointerCapture === 'function' && e.pointerId != null) {
        win.setPointerCapture(e.pointerId);
        st.captured = true;
      }
    } catch (_) {}

    // Safety net: if nothing resolves the gesture in 3 seconds, or if
    // focus/visibility changes (usually meaning the gesture ended
    // somewhere we can't observe), force-end arming.
    st.safetyTimer = setTimeout(function() {
      if (window.__morphicArmState !== st || st.decided) return;
      st.decided = true;
      MorphicWindow._endArming();
    }, 3000);
    st.bailListener = function(ev) {
      if (window.__morphicArmState !== st || st.decided) return;
      st.decided = true;
      MorphicWindow._endArming();
    };
    // Only listen for visibilitychange. We deliberately do NOT listen
    // for window 'blur', because pointerdown on a focusable element
    // (e.g. the streamed VisualWorks window image) can fire blur as a
    // side effect of the click itself, which would abort arming on
    // the very gesture that started it.
    document.addEventListener('visibilitychange', st.bailListener, true);
  }

  static _endArming() {
    var st = window.__morphicArmState;
    if (!st) return;
    window.__morphicArmState = null;
    MorphicWindow._armState = null;
    if (st.win) st.win._modifierArming = false;
    if (st.safetyTimer != null) {
      clearTimeout(st.safetyTimer);
      st.safetyTimer = null;
    }
    if (st.captured && st.win && st.origPointerId != null) {
      try { st.win.releasePointerCapture(st.origPointerId); } catch (_) {}
    }
    if (st.bailListener) {
      try { document.removeEventListener('visibilitychange', st.bailListener, true); } catch (_) {}
      st.bailListener = null;
    }
    // Dispatcher listeners remain attached but become no-ops since
    // __morphicArmState is null. Nothing to leak.
  }

  static get _SUP_TYPES() {
    return ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
            'mousedown', 'mousemove', 'mouseup',
            'click', 'dblclick', 'auxclick', 'contextmenu'];
  }

  static _armDispatcher(ev) {
    var st = window.__morphicArmState;
    if (!st) return;                  // common path: do nothing
    // Let our own synthesized events through unmodified; they are
    // generated by _synthesizeClick on the no-drag path and must reach
    // the underlying content.
    if (ev.isTrusted === false) return;
    // While armed, suppress every gesture event so the underlying
    // content (Squeak/iframe/etc.) does not observe anything until we
    // synthesize a clean sequence on the no-drag path.
    ev.preventDefault();
    ev.stopImmediatePropagation();
    ev.stopPropagation();
    if (st.decided) return;

    if (ev.type === 'pointermove') {
      var off = MorphicWindow._iframeOffsetForDoc(ev.target && ev.target.ownerDocument);
      var dx = ev.clientX + off.x - st.startX;
      var dy = ev.clientY + off.y - st.startY;
      if (dx * dx + dy * dy < st.threshold * st.threshold) return;
      st.decided = true;
      var win = st.win, sourceIframe = st.sourceIframe;
      var sX = st.startX, sY = st.startY;
      setTimeout(function() {
        MorphicWindow._endArming();
        MorphicWindow._startModifierDrag(win, ev, sourceIframe, sX, sY);
      }, 0);
      return;
    }

    if (ev.type === 'pointerup' || ev.type === 'pointercancel') {
      st.decided = true;
      var upOff = MorphicWindow._iframeOffsetForDoc(ev.target && ev.target.ownerDocument);
      var upOuterX = ev.clientX + upOff.x;
      var upOuterY = ev.clientY + upOff.y;
      var upSrcX = upOuterX - st.iframeOX;
      var upSrcY = upOuterY - st.iframeOY;
      var upScreenX = ev.screenX, upScreenY = ev.screenY;
      var origTarget = st.origTarget, origView = st.origView;
      var origPointerId = st.origPointerId, origPointerType = st.origPointerType;
      var downSrcX = st.downSrcX, downSrcY = st.downSrcY;
      var downScreenX = st.downScreenX, downScreenY = st.downScreenY;
      setTimeout(function() {
        MorphicWindow._endArming();
        MorphicWindow._synthesizeClick(origTarget, origView, {
          pointerId: origPointerId,
          pointerType: origPointerType,
          down: { clientX: downSrcX, clientY: downSrcY,
                  screenX: downScreenX, screenY: downScreenY },
          up:   { clientX: upSrcX,   clientY: upSrcY,
                  screenX: upScreenX, screenY: upScreenY }
        });
      }, 0);
      return;
    }
    // Other event types: pure suppression (handled above).
  }

  static _ensureArmDispatcherOn(target) {
    if (!target) return;
    if (target.__morphicArmDispatcherInstalled) return;
    var types = MorphicWindow._SUP_TYPES;
    for (var i = 0; i < types.length; i++) {
      try { target.addEventListener(types[i], MorphicWindow._armDispatcher, true); } catch (_) {}
    }
    target.__morphicArmDispatcherInstalled = true;
  }

  static _installArmDispatchers() {
    MorphicWindow._ensureArmDispatcherOn(window);
    MorphicWindow._ensureArmDispatcherOn(document);
    Array.from(document.querySelectorAll('iframe')).forEach(function(f) {
      try {
        if (f.contentDocument) MorphicWindow._ensureArmDispatcherOn(f.contentDocument);
      } catch (_) {}
    });
  }

  // Map a Document (which may belong to an iframe) to the outer-document
  // (clientX,clientY) offset of that iframe's viewport origin. Returns
  // {x:0,y:0} for the outer document or an unknown document.
  static _iframeOffsetForDoc(doc) {
    if (!doc || doc === document) return { x: 0, y: 0 };
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      var f = iframes[i];
      try {
        if (f.contentDocument === doc) {
          var r = f.getBoundingClientRect();
          return { x: r.left, y: r.top };
        }
      } catch (_) {}
    }
    return { x: 0, y: 0 };
  }

  // Emergency: clear any current arm session. Now trivial because all
  // state lives in MorphicWindow._armState.
  static forceDisarmAll() {
    MorphicWindow._endArming();
  }

  // Dispatch a synthetic cmd-click sequence on `target`. Used when a
  // cmd-pointerdown on a morphic-window doesn't turn into a drag, so
  // the underlying content (Squeak) receives a clean gesture that we
  // had buffered.
  static _synthesizeClick(target, view, info) {
    if (!target) return;
    var PE = view.PointerEvent || window.PointerEvent;
    var ME = view.MouseEvent || window.MouseEvent;
    var pid = (info.pointerId != null) ? info.pointerId : 1;
    var ptype = info.pointerType || 'mouse';
    var common = {
      bubbles: true, cancelable: true, composed: true, view: view,
      button: 0,
      metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      detail: 1
    };
    function mkPointer(type, coords, buttons) {
      var init = Object.assign({}, common, coords, {
        buttons: buttons, pointerId: pid, pointerType: ptype, isPrimary: true
      });
      return new PE(type, init);
    }
    function mkMouse(type, coords, buttons) {
      var init = Object.assign({}, common, coords, { buttons: buttons });
      return new ME(type, init);
    }
    try { target.dispatchEvent(mkPointer('pointerdown', info.down, 1)); } catch (_) {}
    try { target.dispatchEvent(mkMouse('mousedown',   info.down, 1)); } catch (_) {}
    try { target.dispatchEvent(mkPointer('pointerup', info.up,   0)); } catch (_) {}
    try { target.dispatchEvent(mkMouse('mouseup',     info.up,   0)); } catch (_) {}
    try { target.dispatchEvent(mkMouse('click',       info.up,   0)); } catch (_) {}
  }

  static _startModifierDrag(win, e, sourceIframe, startX, startY) {
    if (win._isMaximized && win._isMaximized()) return;
    if (startX === undefined || startY === undefined) {
      var iframeOX = 0, iframeOY = 0;
      if (sourceIframe) {
        var r = sourceIframe.getBoundingClientRect();
        iframeOX = r.left; iframeOY = r.top;
      }
      startX = e.clientX + iframeOX;
      startY = e.clientY + iframeOY;
    }
    var rect = win.getBoundingClientRect();
    var offX = startX - rect.left;
    var offY = startY - rect.top;
    win._modifierDragging = true;
    MorphicWindow._setCmdDragging(win, true);
    var prevSel = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    var allIframes = Array.from(document.querySelectorAll('iframe'));
    var prevPE = allIframes.map(function(f) { return f.style.pointerEvents; });
    allIframes.forEach(function(f) { f.style.pointerEvents = 'none'; });
    var onMove = function(ev) {
      if (!win._modifierDragging) return;
      ev.preventDefault();
      var sd = (ev.target && ev.target.ownerDocument) || document;
      var ox = 0, oy = 0;
      if (sd !== document && sourceIframe) {
        var r2 = sourceIframe.getBoundingClientRect();
        ox = r2.left; oy = r2.top;
      }
      win.style.left = (ev.clientX + ox - offX) + 'px';
      win.style.top  = (ev.clientY + oy - offY) + 'px';
    };
    var onUp = function(ev) {
      if (!win._modifierDragging) return;
      win._modifierDragging = false;
      MorphicWindow._setCmdDragging(win, false);
      // The 'cmd-held' class may have been cleared during the drag
      // (e.g. by a window blur fired as a side effect of pointerdown
      // on a focusable target). If the Meta key is still down at
      // mouseup, restore the open-hand cursor immediately rather than
      // waiting for the next Meta keydown.
      if (ev && ev.metaKey) MorphicWindow._setCmdHeld(true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      if (sourceIframe) {
        try {
          sourceIframe.contentDocument.removeEventListener('pointermove', onMove, true);
          sourceIframe.contentDocument.removeEventListener('pointerup', onUp, true);
        } catch (_) {}
      }
      document.body.style.userSelect = prevSel;
      allIframes.forEach(function(f, i) { f.style.pointerEvents = prevPE[i] || ''; });
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    if (sourceIframe) {
      try {
        sourceIframe.contentDocument.addEventListener('pointermove', onMove, true);
        sourceIframe.contentDocument.addEventListener('pointerup', onUp, true);
      } catch (_) {}
    }
  }

  _installIframeModifierClickHandlers() {
    var iframes = this.querySelectorAll('iframe');
    iframes.forEach(function(iframe) {
      var attach = function() {
        var doc;
        try { doc = iframe.contentDocument; } catch (_) { return; }
        if (!doc) return;
        MorphicWindow._registerCmdCursorDoc(doc);
        if (doc._morphicModifierClickInstalled) return;
        var pd = function(e) { MorphicWindow._handleModifierEvent(e, iframe); };
        doc.addEventListener('pointerdown', pd, true);
        doc.addEventListener('mousedown', pd, true);
        doc._morphicModifierClickInstalled = true;
      };
      attach();
      // Gate the load listener so repeated _attachBehavior calls (each
      // hot-reload, each reconnect) don't accumulate fresh closures on
      // the same iframe.
      if (!iframe.__morphicLoadHookInstalled) {
        iframe.__morphicLoadHookInstalled = true;
        iframe.addEventListener('load', attach);
      }
    });
  }

  collapse() {
    if (this.style.visibility === 'hidden' || this.dataset.iconManagerPendingHidden === 'true') return;
    var self = this;
    var existing = this.style.transition || '';
    if (existing.indexOf('opacity') === -1) {
      this.style.transition = existing ? (existing + ', opacity 250ms') : 'opacity 250ms';
    }
    this.style.visibility = 'visible';
    this.style.opacity = '1';
    this.dataset.iconManagerPendingHidden = 'true';
    var fallbackTimer = null;
    function finish() {
      self.removeEventListener('transitionend', onFadeOut);
      if (fallbackTimer != null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      if (self.dataset.iconManagerPendingHidden !== 'true') return;
      self.style.visibility = 'hidden';
      delete self.dataset.iconManagerPendingHidden;
    }
    function onFadeOut(ev) {
      if (ev.propertyName !== 'opacity') return;
      finish();
    }
    this.addEventListener('transitionend', onFadeOut);
    // Fallback: if the opacity transition is interrupted (maximize toggled,
    // _setCutoutMode resets style.transition, etc.) transitionend never
    // fires. Clean up after a slack window so the listener doesn't leak
    // and the dataset flag doesn't get pinned.
    fallbackTimer = setTimeout(finish, 500);
    requestAnimationFrame(function() {
      self.style.opacity = '0';
    });
    this.dispatchEvent(new CustomEvent('morphic-collapse', { bubbles: true }));
  }

  setCaption(text) {
    this.setAttribute('caption', text);
  }

  titlebarThickness() {
    var titlebar = this.shadowRoot.querySelector('.titlebar');
    return titlebar ? titlebar.offsetHeight : 25;
  }

  sideBorderThickness() {
    return parseInt(getComputedStyle(this.shadowRoot.host).paddingLeft, 10) || 5;
  }

  isMaximized() {
    // Returns 1/0 (not true/false) for Smalltalk consumers that expect
    // a SmallInteger; do not "fix" to a boolean.
    return this._isMaximized() ? 1 : 0;
  }

  isOccluded() {
    var myZ = parseInt(this.style.zIndex, 10) || 0;
    var wins = MorphicWindow._allWindows();
    var nonTransients = wins.filter(function(w) {
      return w.tagName.toLowerCase() !== 'transient-window';
    });
    var maxZ = myZ;
    for (var i = 0; i < nonTransients.length; i++) {
      var z = parseInt(nonTransients[i].style.zIndex, 10) || 0;
      if (z > maxZ) maxZ = z;
    }
    if (maxZ <= myZ) return false;
    var myRect = this.getBoundingClientRect();
    for (var i = 0; i < nonTransients.length; i++) {
      var w = nonTransients[i];
      if (w === this) continue;
      var wZ = parseInt(w.style.zIndex, 10) || 0;
      if (wZ <= myZ) continue;
      if (w.style.visibility === 'hidden' || w.style.display === 'none') continue;
      var r = w.getBoundingClientRect();
      if (r.left < myRect.right && r.right > myRect.left &&
          r.top < myRect.bottom && r.bottom > myRect.top) {
        return true;
      }
    }
    return false;
  }

  static hotReload() {
    var ExistingClass = customElements.get('morphic-window');
    return fetch('js/components/morphic-window.js?' + Date.now())
      .then(function(r) { return r.text(); })
      .then(function(src) {
        // Strip the customElements.define call so re-registration doesn't fail
        src = src.replace(/customElements\.define\([^)]+\);?/, '');
        var NewClass = new Function(src + '\nreturn MorphicWindow;')();
        Object.getOwnPropertyNames(NewClass.prototype).forEach(function(key) {
          if (key !== 'constructor') {
            ExistingClass.prototype[key] = NewClass.prototype[key];
          }
        });
        // Copy static methods/properties (except hotReload itself, to avoid recursion issues)
        Object.getOwnPropertyNames(NewClass).forEach(function(key) {
          if (key !== 'prototype' && key !== 'length' && key !== 'name') {
            var desc = Object.getOwnPropertyDescriptor(NewClass, key);
            Object.defineProperty(ExistingClass, key, desc);
          }
        });
        // Rebuild existing instances
        document.querySelectorAll('morphic-window').forEach(function(mw) {
          var titlebar = mw.shadowRoot.querySelector('.titlebar');
          if (titlebar) {
            titlebar.removeEventListener('pointermove', mw._onPointerMove);
            titlebar.removeEventListener('pointerup', mw._onPointerUp);
          }
          mw.removeEventListener('pointermove', mw._onResizePointerMove);
          mw.removeEventListener('pointerup', mw._onResizePointerUp);
          window.removeEventListener('resize', mw._onViewportResize);
          ExistingClass._BOUND_METHODS.forEach(function(name) {
            mw[name] = ExistingClass.prototype[name].bind(mw);
          });
          window.addEventListener('resize', mw._onViewportResize);
          mw._render();
          mw._attachBehavior();
        });
      });
  }
}

customElements.define('morphic-window', MorphicWindow);
