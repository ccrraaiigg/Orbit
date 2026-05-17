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
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onCursorMove = this._onCursorMove.bind(this);
    this._onCursorLeave = this._onCursorLeave.bind(this);
    this._onViewportResize = this._onViewportResize.bind(this);
    this._onResizePointerMove = this._onResizePointerMove.bind(this);
    this._onResizePointerUp = this._onResizePointerUp.bind(this);
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
    return Array.from(document.querySelectorAll('morphic-window, transient-window'));
  }

  _bringToFront() {
    var self = this;
    var allWins = MorphicWindow._allWindows();
    var morphics = allWins.filter(function(w) {
      return w.tagName.toLowerCase() !== 'transient-window';
    });
    var transients = allWins.filter(function(w) {
      return w.tagName.toLowerCase() === 'transient-window';
    });
    if (morphics.length <= 1 && transients.length === 0) return;
    // Sort others by current z, preserving their relative order
    var others = morphics.filter(function(w) { return w !== self; });
    others.sort(function(a, b) {
      return (parseInt(a.style.zIndex, 10) || 0) - (parseInt(b.style.zIndex, 10) || 0);
    });
    // Assign compact sequential z-indices: others 0..N-2, self N-1
    for (var i = 0; i < others.length; i++) {
      others[i].style.zIndex = i;
    }
    this.style.zIndex = others.length;
    // Ensure transient windows remain above all morphic windows
    var transientBase = morphics.length;
    transients.sort(function(a, b) {
      return (parseInt(a.style.zIndex, 10) || 0) - (parseInt(b.style.zIndex, 10) || 0);
    });
    for (var i = 0; i < transients.length; i++) {
      transients[i].style.zIndex = transientBase + i;
    }
  }

  _sendToBack() {
    var self = this;
    var allWins = MorphicWindow._allWindows();
    var morphics = allWins.filter(function(w) {
      return w.tagName.toLowerCase() !== 'transient-window';
    });
    var transients = allWins.filter(function(w) {
      return w.tagName.toLowerCase() === 'transient-window';
    });
    if (morphics.length <= 1 && transients.length === 0) return;
    // Desired order: self on bottom, then others in their current relative order
    var others = morphics.filter(function(w) { return w !== self; });
    others.sort(function(a, b) {
      return (parseInt(a.style.zIndex, 10) || 0) - (parseInt(b.style.zIndex, 10) || 0);
    });
    this.style.zIndex = 0;
    for (var i = 0; i < others.length; i++) {
      others[i].style.zIndex = i + 1;
    }
    // Ensure transient windows remain above all morphic windows
    var transientBase = morphics.length;
    transients.sort(function(a, b) {
      return (parseInt(a.style.zIndex, 10) || 0) - (parseInt(b.style.zIndex, 10) || 0);
    });
    for (var i = 0; i < transients.length; i++) {
      transients[i].style.zIndex = transientBase + i;
    }
  }

  _isMaximized() {
    return this._windowState === 'maximized';
  }

  _scaledMs(ms) {
    var scale = this._transitionTimeScale;
    if (typeof scale !== 'number' || !isFinite(scale) || scale <= 0) scale = 4;
    return Math.round(ms * scale);
  }

  _wait(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }

  _yieldToRenderer() {
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
    } catch (_) {
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

  _resizeEmbeddedSurfaceToWindow() {
    var iframe = this._embeddedIframe();
    if (!iframe) return;

    var width = Math.max(1, Math.floor(this.clientWidth - 10));
    var height = Math.max(1, Math.floor(this.clientHeight - 30));

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
    var titlebar = this.shadowRoot.querySelector('.titlebar');
    if (titlebar) {
      titlebar.removeEventListener('pointermove', this._onPointerMove);
      titlebar.removeEventListener('pointerup', this._onPointerUp);
    }
    this.removeEventListener('pointermove', this._onResizePointerMove);
    this.removeEventListener('pointerup', this._onResizePointerUp);
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
    var title = this.getAttribute('caption') || '';
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
      </style>
      <div class="titlebar">
        <svg class="btn" id="close-button" width="15" height="15" viewBox="0 0 15 15">
          <circle cx="7.5" cy="7.5" r="6.5" fill="#e25c4f" stroke="#c94434" stroke-width="0.5"/>
          <line x1="4.5" y1="4.5" x2="10.5" y2="10.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="10.5" y1="4.5" x2="4.5" y2="10.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <span class="title-text">${title}</span>
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
  }

  _attachBehavior() {
    var self = this;
    var titlebar = this.shadowRoot.querySelector('.titlebar');
    var buttons = this.shadowRoot.querySelectorAll('.btn');

    // Modifier-click handling (cmd/opt/ctrl) is installed once per
    // page at the window level so it runs before any per-instance
    // capture-phase handlers in transient-window/workbook-window/etc.
    MorphicWindow._installGlobalModifierClickHandler();
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

  _edgeCursorForPoint(clientX, clientY) {
    var rect = this.getBoundingClientRect();
    var x = clientX - rect.left;
    var y = clientY - rect.top;
    var edgeT = 5;
    var cornerT = 7;

    var nearLeftEdge = x >= 0 && x <= edgeT;
    var nearRightEdge = x <= rect.width && x >= (rect.width - edgeT);
    var nearTopEdge = y >= 0 && y <= edgeT;
    var nearBottomEdge = y <= rect.height && y >= (rect.height - edgeT);

    var nearLeftCorner = x >= 0 && x <= cornerT;
    var nearRightCorner = x <= rect.width && x >= (rect.width - cornerT);
    var nearTopCorner = y >= 0 && y <= cornerT;
    var nearBottomCorner = y <= rect.height && y >= (rect.height - cornerT);

    if ((nearTopCorner && nearLeftCorner) || (nearBottomCorner && nearRightCorner)) return 'nwse-resize';
    if ((nearTopCorner && nearRightCorner) || (nearBottomCorner && nearLeftCorner)) return 'nesw-resize';
    if (nearTopEdge || nearBottomEdge) return 'ns-resize';
    if (nearLeftEdge || nearRightEdge) return 'ew-resize';
    return '';
  }

  _onCursorMove(e) {
    if (this._dragging) return;
    var cursor = this._edgeCursorForPoint(e.clientX, e.clientY);
    this.style.cursor = cursor;
    var titlebar = this.shadowRoot.querySelector('.titlebar');
    if (titlebar) titlebar.style.cursor = cursor || '';
  }

  _onCursorLeave(e) {
    // Capture-phase pointerleave fires for descendants too (e.g. the
    // slotted iframe). Only clear cursor when the host itself is left.
    if (e && e.target !== this) return;
    if (!this._dragging && !this._resizing) {
      this.style.cursor = '';
      var titlebar = this.shadowRoot.querySelector('.titlebar');
      if (titlebar) titlebar.style.cursor = '';
    }
  }

  _edgesForPoint(clientX, clientY) {
    var rect = this.getBoundingClientRect();
    var x = clientX - rect.left;
    var y = clientY - rect.top;
    var edgeT = 5;
    var cornerT = 7;

    var top = y >= 0 && y <= edgeT;
    var bottom = y <= rect.height && y >= (rect.height - edgeT);
    var left = x >= 0 && x <= edgeT;
    var right = x <= rect.width && x >= (rect.width - edgeT);

    // Expand to corner zones
    if (top || bottom) {
      if (x >= 0 && x <= cornerT) left = true;
      if (x <= rect.width && x >= (rect.width - cornerT)) right = true;
    }
    if (left || right) {
      if (y >= 0 && y <= cornerT) top = true;
      if (y <= rect.height && y >= (rect.height - cornerT)) bottom = true;
    }

    if (!top && !bottom && !left && !right) return null;
    return { top: top, bottom: bottom, left: left, right: right };
  }

  _startResize(e) {
    var edges = this._edgesForPoint(e.clientX, e.clientY);
    if (!edges) return false;
    return this._startResizeWithEdges(e, edges);
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
    this.releasePointerCapture(this._resizePointerId);

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
    if (this._dragging && !this._didDrag) {
      // Click without drag: bring to front
      this._bringToFront();
    }

    this._dragging = false;
    this._didDrag = false;
    var titlebar = this.shadowRoot.querySelector('.titlebar');
    titlebar.releasePointerCapture(e.pointerId);
    titlebar.style.cursor = '';
    this.style.cursor = '';
  }

  toggleMaximize() {
    return this._toggleMaximize();
  }

  // Modifier-click model:
  //   cmd-drag   -> move window (no need for a raise binding;
  //                 clicking an occluded window already raises it
  //                 without propagating the click into the window)
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

  static _isWindowEl(el) {
    return el && el.tagName &&
      /^(morphic-window|transient-window|workbook-window)$/i.test(el.tagName);
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
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    if (meta) { MorphicWindow._startModifierDrag(win, e, sourceIframe); return; }
    if (alt)  { if (typeof win.collapse === 'function') win.collapse(); return; }
  }

  static _startModifierDrag(win, e, sourceIframe) {
    if (win._isMaximized && win._isMaximized()) return;
    var iframeOX = 0, iframeOY = 0;
    if (sourceIframe) {
      var r = sourceIframe.getBoundingClientRect();
      iframeOX = r.left; iframeOY = r.top;
    }
    var startX = e.clientX + iframeOX;
    var startY = e.clientY + iframeOY;
    var rect = win.getBoundingClientRect();
    var offX = startX - rect.left;
    var offY = startY - rect.top;
    win._modifierDragging = true;
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
    var onUp = function() {
      if (!win._modifierDragging) return;
      win._modifierDragging = false;
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
        if (doc._morphicModifierClickInstalled) return;
        var pd = function(e) { MorphicWindow._handleModifierEvent(e, iframe); };
        doc.addEventListener('pointerdown', pd, true);
        doc.addEventListener('mousedown', pd, true);
        doc._morphicModifierClickInstalled = true;
      };
      attach();
      iframe.addEventListener('load', attach);
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
    function onFadeOut(ev) {
      if (ev.propertyName !== 'opacity') return;
      self.removeEventListener('transitionend', onFadeOut);
      self.style.visibility = 'hidden';
      delete self.dataset.iconManagerPendingHidden;
    }
    this.addEventListener('transitionend', onFadeOut);
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
          mw._onPointerMove = ExistingClass.prototype._onPointerMove.bind(mw);
          mw._onPointerUp = ExistingClass.prototype._onPointerUp.bind(mw);
          mw._onResizePointerMove = ExistingClass.prototype._onResizePointerMove.bind(mw);
          mw._onResizePointerUp = ExistingClass.prototype._onResizePointerUp.bind(mw);
          mw._onCursorMove = ExistingClass.prototype._onCursorMove.bind(mw);
          mw._onCursorLeave = ExistingClass.prototype._onCursorLeave.bind(mw);
          mw._render();
          mw._attachBehavior();
        });
      });
  }
}

customElements.define('morphic-window', MorphicWindow);
