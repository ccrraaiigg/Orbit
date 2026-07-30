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
    // 'chromeless' has no JS-side handling: pure CSS via :host([chromeless])
    // rules hides the titlebar, resize zones, padding, and hover tint.
    // Set it on a window whose content (e.g. a Squeak SystemWindow rendered
    // into our canvas) already draws its own chrome.
    return ['caption', 'title', 'chromeless'];
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

  static _updateOcclusionShields() {
    // For each non-Caffeine chromed morphic-window, use actual
    // rect-overlap occlusion (not mere z-order) to decide whether clicks
    // pass through: when not occluded all clicks reach content; when
    // occluded, slotted children are made inert so the first click
    // raises the window instead. Chromeless mirrors need no shield — the
    // .title-text strip always catches wrapper drags and everything else
    // passes through to the Squeak canvas, occluded or not.
    var all = MorphicWindow._allWindows();
    for (var i = 0; i < all.length; i++) {
      var w = all[i];
      if (w.tagName.toLowerCase() === 'transient-window') continue;
      if (w.id === 'embeddedSqueak') continue;
      if (w.hasAttribute('chromeless')) continue;
      var occluded = w.isOccluded();
      var children = w.children;
      for (var j = 0; j < children.length; j++) {
        if (children[j].slot) continue;
        if (!occluded) {
          children[j].removeAttribute('inert');
        } else {
          children[j].setAttribute('inert', '');
        }
      }
    }
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
    var transientBase = MorphicWindow.Z_TRANSIENT_BASE;
    transients.sort(function(a, b) {
      return (parseInt(a.style.zIndex, 10) || 0) - (parseInt(b.style.zIndex, 10) || 0);
    });
    for (var k = 0; k < transients.length; k++) {
      transients[k].style.zIndex = transientBase + k;
    }
  }

  // Z-index tiers (low → high):
  //   Morphic windows (normal _assignZ): 0 .. N-1
  //   Caffeine active / maximized:       4500
  //   Transient windows:                 5000+
  //   Icon manager:                      9999
  static get Z_MAXIMIZED()       { return 4500; }
  static get Z_TRANSIENT_BASE()  { return 5000; }

  _bringToFront() {
    this._assignZ('top');
    // Keep a maximized window in its elevated z tier.
    if (this._isMaximized()) this.style.zIndex = String(MorphicWindow.Z_MAXIMIZED);
    // Toggle occlusion shields: disable ours, enable on all others.
    MorphicWindow._updateOcclusionShields();
  }
  _sendToBack() {
    this._assignZ('bottom');
    MorphicWindow._updateOcclusionShields();
  }

  // Clamp position so the window is fully visible within the viewport.
  // Adjusts left/top (and shrinks width/height if needed) so no edge
  // extends beyond the viewport boundaries.
  //
  // Self-healing: the shrink is released and re-measured on every call so
  // that a window clamped to a small viewport re-expands when the viewport
  // later grows. We only ever touch a width/height WE applied (tracked via
  // _clampAppliedW/H); the pre-clamp inline value (which may be empty for a
  // content-driven/canvas-backed window, or an intrinsic size set by a
  // content component such as <markdown-viewer>) is captured and restored,
  // so clamping never clobbers an intentional size.
  _clampToViewport() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // A canvas-backed (Snowglobe-mapped) window shrink-wraps its slotted
    // <canvas>, whose size is owned by the remote display policy. We must
    // NOT write style.width/height on it here: that resizes the host
    // chrome WITHOUT going through onResizeComplete, so Squeak is never
    // told, the canvas desyncs from the chrome, and the window appears to
    // vanish. For these windows we clamp position only and leave sizing to
    // the remote resize path.
    var canvasBacked = !!(this.querySelector && this.querySelector('canvas'));

    if (!canvasBacked) {
      // 1. Release any clamp WE applied previously, restoring the original
      //    inline value so we can re-measure the natural size.
      if (this._clampAppliedW) {
        if (this._preClampW) this.style.width = this._preClampW;
        else this.style.removeProperty('width');
        this._clampAppliedW = false;
      }
      if (this._clampAppliedH) {
        if (this._preClampH) this.style.height = this._preClampH;
        else this.style.removeProperty('height');
        this._clampAppliedH = false;
      }
    }

    // 2. Measure the natural (unclamped) size.
    var w = this.offsetWidth;
    var h = this.offsetHeight;

    // 3. Shrink to fit only if still larger than the viewport, remembering
    //    the original inline value so it can be restored later. Skipped for
    //    canvas-backed windows (see above).
    if (!canvasBacked) {
      if (w > vw) {
        this._preClampW = this.style.width;
        this.style.width = vw + 'px';
        this._clampAppliedW = true;
        w = vw;
      }
      if (h > vh) {
        this._preClampH = this.style.height;
        this.style.height = vh + 'px';
        this._clampAppliedH = true;
        h = vh;
      }
    }

    // 4. Keep the window within the viewport bounds.
    var left = parseFloat(this.style.left) || 0;
    var top = parseFloat(this.style.top) || 0;
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (left + w > vw) left = Math.max(0, vw - w);
    if (top + h > vh) top = Math.max(0, vh - h);
    this.style.left = left + 'px';
    this.style.top = top + 'px';
  }

  // Nudge a freshly-opened window off the icon-manager so it never comes
  // up occluded by that always-on-top panel (fixed bottom-right, z-index
  // 9999). This is an OPEN-TIME-ONLY placement fix: unlike
  // _clampToViewport it is NOT wired into the viewport-resize path, so a
  // window the user has deliberately parked under/beside the panel is left
  // undisturbed. Position-only (never touches width/height), so it is safe
  // for canvas-backed (Snowglobe-mapped) windows too.
  _avoidIconManager() {
    var im = document.querySelector('icon-manager');
    if (!im) return;
    // Maximized/fullscreen windows intentionally cover the whole viewport
    // (and sit above the panel); don't fight that.
    if (typeof this._isMaximized === 'function' && this._isMaximized()) return;
    var imRect;
    try { imRect = im.getBoundingClientRect(); } catch (_) { return; }
    // Panel not laid out (hidden/empty) — nothing to avoid.
    if (!imRect || imRect.width === 0 || imRect.height === 0) return;
    var rect = this.getBoundingClientRect();
    // No overlap? Leave the window exactly where it was placed.
    if (rect.right <= imRect.left || rect.left >= imRect.right ||
        rect.bottom <= imRect.top || rect.top >= imRect.bottom) return;

    var gap = 8;
    var w = rect.width, h = rect.height;
    var left = parseFloat(this.style.left);
    if (isNaN(left)) left = rect.left;
    var top = parseFloat(this.style.top);
    if (isNaN(top)) top = rect.top;

    // Candidate clears: slide left of the panel, or up above it.
    var leftShifted = imRect.left - gap - w; // new left to clear horizontally
    var upShifted = imRect.top - gap - h;    // new top to clear vertically
    var canLeft = leftShifted >= 0;
    var canUp = upShifted >= 0;

    if (canLeft || canUp) {
      // Prefer the smaller on-screen displacement.
      var leftCost = canLeft ? Math.abs(left - leftShifted) : Infinity;
      var upCost = canUp ? Math.abs(top - upShifted) : Infinity;
      if (leftCost <= upCost) left = leftShifted;
      else top = upShifted;
    } else {
      // Window too large to sit beside or above the panel: pin to the
      // top-left so at least its titlebar and top-left content are clear.
      left = 0;
      top = 0;
    }
    this.style.left = Math.max(0, left) + 'px';
    this.style.top = Math.max(0, top) + 'px';
  }

  // True iff this window is not visually occluded (no higher-z window
  // overlaps its rect). Used by occlusion guards to decide whether
  // clicks should pass through without raising.
  _isFrontMostMorphic() {
    return !this.isOccluded();
  }

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
    // Restore the solid host bg by handing control BACK to the shadow
    // stylesheet (`:host` #c0c0c0 / `:host(:hover)` #a8c8c8) rather than
    // pinning an inline color. An inline background-color outranks the
    // `:host(:hover)` rule, so leaving one here permanently defeats the
    // teal hover tint for any window that has gone through a cutout
    // transition (e.g. an interactive resize, whose pointer-up path does
    // not otherwise clear it). The default `:host` color equals the
    // normal lock color, so this is visually identical in the common
    // case and additionally lets the stylesheet resolve the hover state.
    this.style.removeProperty('background-color');
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
    if (this.hasAttribute('chromeless')) return { width: 0, height: 0 };
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
    if (this._isMaximized()) {
      this._resizeEmbeddedSurfaceToWindow();
      return;
    }
    // Re-evaluate viewport clamping for normal windows so one shrunk to fit
    // a smaller viewport is released (and re-tracks its content) once the
    // viewport grows again. Skip while a transition or interactive resize is
    // in flight to avoid fighting those geometry animations.
    if (this._isTransitioning || this._resizing) return;
    this._clampToViewport();
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

    // Put this window above frozen snapshot overlays before the
    // fade-in so the content appears in front.
    this._bringToFront();
    this.style.zIndex = String(MorphicWindow.Z_MAXIMIZED);

    // Resize to final dimensions, then yield so the VM redraw
    // completes before the fade-in transition starts.
    this._resizeEmbeddedSurfaceToWindow();
    await this._yieldToRenderer();

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

    // Phase 1: Fade content → dissolves to reveal cutout.
    // Keep the high z-index during the fade so frozen overlays are
    // revealed THROUGH the dissolving cutout rather than popping in
    // front immediately.
    await this._fadeContentsTo(0, this._scaledMs(250));

    // NOW drop z-index — content is fully transparent so the
    // visual transition is seamless.
    this._assignZ('top');

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
    // Open collapsed if the creator stipulated it (boolean `collapsed`
    // attribute, read once at mount). The icon-manager lists every
    // morphic-window and treats a hidden window as collapsed (docked), so
    // we simply come up hidden — no flash, no fade. This matches the
    // resting state collapse() leaves a window in (visibility:hidden,
    // opacity:0), so the icon-manager's restore path fades it back in
    // exactly as for a window the user collapsed by hand. Set the
    // attribute BEFORE the element is connected (e.g. before appending it)
    // for the creator's stipulation to take effect.
    if (this.hasAttribute('collapsed')) {
      this.style.visibility = 'hidden';
      this.style.opacity = '0';
      // One-shot directive: consume it so a later re-connect (e.g. the
      // element being moved in the DOM) doesn't re-collapse a window the
      // user has since restored.
      this.removeAttribute('collapsed');
    }
    // Ensure the window comes up entirely onscreen, wherever it was
    // inserted. Deferred a frame so content (canvas/iframe) has laid out
    // before we measure. (The MutationObserver below is the hot-reload-safe
    // path; this covers the freshly-defined class on a clean page load.)
    var self = this;
    requestAnimationFrame(function() {
      if (self.isConnected && typeof self._clampToViewport === 'function') {
        self._clampToViewport();
        // Open-time only: keep the new window clear of the icon-manager.
        if (typeof self._avoidIconManager === 'function') self._avoidIconManager();
      }
    });
  }

  disconnectedCallback() {
    // The titlebar inside shadowRoot will be GC'd along with this element;
    // its listeners are bound to closures that don't outlive it, so we don't
    // need to remove them. Only listeners attached to objects that outlive
    // this element (window, document) need explicit cleanup.
    window.removeEventListener('resize', this._onViewportResize);
    // Recalculate occlusion so the next window in line becomes non-inert.
    MorphicWindow._updateOcclusionShields();
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
    if (name === 'chromeless') {
      if (this.hasAttribute('chromeless')) {
        this._installChromelessResizeFade();
      } else {
        this._uninstallChromelessResizeFade();
      }
    }
  }

  // Mask the flash that happens when a remote Squeak window collapses
  // or expands by snapshotting the slotted canvas just before each
  // dimension change and fading the snapshot out over 500ms on top of
  // the resized canvas. Since we can't delay the upstream resize, this
  // gives a smooth cross-fade from the old visual to the new one.
  _installChromelessResizeFade() {
    if (this._chromelessResizeFadeInstalled) return;
    this._chromelessResizeFadeInstalled = true;
    var self = this;
    this._instrumentSlottedCanvases();
    // Watch for the slotted canvas being added/replaced later.
    var slot = this.shadowRoot.querySelector('slot:not([name])');
    if (slot) {
      slot.addEventListener('slotchange', function() {
        self._instrumentSlottedCanvases();
      });
    }
  }

  _uninstallChromelessResizeFade() {
    this._chromelessResizeFadeInstalled = false;
    // We leave any per-canvas instrumentation in place; it harmlessly
    // no-ops while the host isn't chromeless because we gate snapshot
    // emission on the chromeless attribute.
  }

  // Attach a ResizeObserver to each slotted canvas so a server-driven
  // resize (which changes the offscreen canvas from the worker, bypassing
  // the main-thread canvas.width setter) reconciles this wrapper's size.
  _installCanvasSizeSync() {
    if (typeof ResizeObserver === 'undefined') return;
    var slot = this.shadowRoot.querySelector('slot:not([name])');
    if (!slot) return;
    var assigned = slot.assignedElements ? slot.assignedElements() : [];
    var canvases = [];
    assigned.forEach(function(el) {
      if (el.tagName === 'CANVAS') canvases.push(el);
      else if (el.querySelectorAll) el.querySelectorAll('canvas').forEach(function(c) { canvases.push(c); });
    });
    var host = this;
    canvases.forEach(function(c) {
      c.__sizeSyncHost = host;
      if (c.__sizeSyncObserver) return;
      var ro = new ResizeObserver(function() {
        var h = c.__sizeSyncHost;
        if (h && typeof h._syncSizeToCanvas === 'function') h._syncSizeToCanvas(c);
      });
      try { ro.observe(c); } catch (_) { return; }
      c.__sizeSyncObserver = ro;
    });
  }

  // Among this window's slotted canvases, return the one that is its real
  // remote surface: the canvas whose control was transferred to the
  // OffscreenCanvas worker (Snowglobe paints into it). Caffeine can append a
  // stray blank default canvas to a window element when a canvas is rewrapped
  // (Webpage>>createWorldOfKind:withCanvas: parents the canvas into a fresh
  // <div>/body) — e.g. when a pull-down menu triggers the recycle path in
  // Snowglobe>>mapWindow:. Such a stray canvas is NOT transferred to an
  // offscreen, so it must never drive the wrapper's size. Returns null when
  // no canvas can be identified.
  _windowSurfaceCanvas() {
    var slot = this.shadowRoot.querySelector('slot:not([name])');
    if (!slot) return null;
    var assigned = slot.assignedElements ? slot.assignedElements() : [];
    var canvases = [];
    assigned.forEach(function(el) {
      if (el.tagName === 'CANVAS') canvases.push(el);
      else if (el.querySelectorAll) el.querySelectorAll('canvas').forEach(function(c) { canvases.push(c); });
    });
    if (canvases.length === 0) return null;
    // A canvas whose control was transferred to an OffscreenCanvas can no
    // longer yield a 2d context on the main thread (getContext throws or
    // returns null). That is exactly the remote window surface; a stray blank
    // canvas still hands back a live context.
    var transferred = canvases.filter(function(c) {
      try { return c.getContext('2d') == null; } catch (_) { return true; }
    });
    var pool = transferred.length ? transferred : canvases;
    // Prefer the largest by area (real content vs. any default-size stray).
    return pool.reduce(function(best, c) {
      return (!best || (c.width * c.height) > (best.width * best.height)) ? c : best;
    }, null);
  }

  // Set this wrapper's width/height to match its canvas (plus chrome),
  // leaving its position untouched. Skipped during a live drag or while
  // maximized so it never fights those paths. A no-op when already in
  // sync, which also prevents any observer feedback loop.
  _syncSizeToCanvas(canvas) {
    if (this._resizing) return;
    if (typeof this._isMaximized === 'function' && this._isMaximized()) return;
    // Always reconcile to the window's real remote surface, not whichever
    // canvas happened to trigger the ResizeObserver. A stray blank canvas
    // appended to the window element must never shrink the wrapper.
    var surface = this._windowSurfaceCanvas() || canvas;
    var cw = surface.width, ch = surface.height;
    if (!cw || !ch) return;
    var sb = this.sideBorderThickness();
    var tb = this.titlebarThickness();
    var targetW = cw + 2 * sb;
    var targetH = ch + tb + sb;
    var curW = Math.round(parseFloat(this.style.width));
    var curH = Math.round(parseFloat(this.style.height));
    if (curW === targetW && curH === targetH) {
      // Already the right size (e.g. a client-initiated resize drag already
      // applied it). Drop any pending server anchor so it can't apply to a
      // later, unrelated resize.
      this.__sgAnchor = null;
      return;
    }
    this.style.width = targetW + 'px';
    this.style.height = targetH + 'px';
    // Corner-anchoring for a SERVER-originated resize (the original window
    // was resized in the Squeak UI): the ResizeWindow frame reported which
    // of the original's edges moved, stashed as __sgAnchor by the consumer's
    // message handler along with the pre-resize right/bottom viewport edges.
    // Hold the opposite (anchored) edge fixed on the page by repositioning
    // the wrapper; leave the moved edge to grow from the new size.
    var a = this.__sgAnchor;
    this.__sgAnchor = null;
    if (a) {
      if (a.leftMoved) this.style.left = (a.right - targetW) + 'px';
      if (a.topMoved) this.style.top = (a.bottom - targetH) + 'px';
    }
  }

  _instrumentSlottedCanvases() {
    var slot = this.shadowRoot.querySelector('slot:not([name])');
    if (!slot) return;
    var assigned = slot.assignedElements ? slot.assignedElements() : [];
    var canvases = [];
    assigned.forEach(function(el) {
      if (el.tagName === 'CANVAS') canvases.push(el);
      else if (el.querySelectorAll) {
        el.querySelectorAll('canvas').forEach(function(c) { canvases.push(c); });
      }
    });
    var host = this;
    canvases.forEach(function(c) { MorphicWindow._instrumentCanvasForResizeFade(c, host); });
  }

  static _instrumentCanvasForResizeFade(canvas, host) {
    if (canvas.__resizeSnapshotInstalled) {
      canvas.__resizeSnapshotHost = host;
      return;
    }
    canvas.__resizeSnapshotInstalled = true;
    canvas.__resizeSnapshotHost = host;
    var widthDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    var heightDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
    var pendingSnapshot = false;
    function maybeSnapshot() {
      if (pendingSnapshot) return;
      var h = canvas.__resizeSnapshotHost;
      if (!h || !h.hasAttribute('chromeless')) return;
      var oldW = widthDesc.get.call(canvas);
      var oldH = heightDesc.get.call(canvas);
      if (oldW <= 0 || oldH <= 0) return;
      pendingSnapshot = true;
      // Snapshot synchronously before the resize is applied.
      var snap = document.createElement('canvas');
      snap.width = oldW;
      snap.height = oldH;
      try { snap.getContext('2d').drawImage(canvas, 0, 0); }
      catch (_) { pendingSnapshot = false; return; }
      var rect = canvas.getBoundingClientRect();
      snap.style.cssText =
        'position:absolute;top:0;left:0;' +
        'width:' + rect.width + 'px;height:' + rect.height + 'px;' +
        'pointer-events:none;z-index:50;' +
        'opacity:1;transition:opacity 500ms ease;';
      h.shadowRoot.appendChild(snap);
      // Force layout, then fade out.
      requestAnimationFrame(function() {
        requestAnimationFrame(function() { snap.style.opacity = '0'; });
      });
      setTimeout(function() {
        if (snap.parentNode) snap.parentNode.removeChild(snap);
        pendingSnapshot = false;
      }, 600);
    }
    Object.defineProperty(canvas, 'width', {
      configurable: true,
      get: function() { return widthDesc.get.call(this); },
      set: function(v) {
        if (v !== widthDesc.get.call(this)) maybeSnapshot();
        widthDesc.set.call(this, v);
      }
    });
    Object.defineProperty(canvas, 'height', {
      configurable: true,
      get: function() { return heightDesc.get.call(this); },
      set: function(v) {
        if (v !== heightDesc.get.call(this)) maybeSnapshot();
        heightDesc.set.call(this, v);
      }
    });
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
          transition: background-color 200ms, box-shadow 200ms;
        }
        :host(:hover) {
          background-color: #a8c8c8;
        }
        /* Chromeless mode: the slotted content (typically a canvas painted
           by Squeak, which draws its own title bar, borders, and resize
           handles) fills the host edge to edge. The titlebar, resize
           zones, hover tint, padding, and content-area border-radius are
           all suppressed; only the structural <slot> remains visible.
           Drag, resize, send-to-back, maximize, and collapse remain
           callable via the public JS API. */
        :host([chromeless]) {
          padding: 0;
          background-color: transparent;
          border-radius: 7px;
          overflow: hidden;
          box-shadow:
            0 2px 6px rgba(0, 0, 0, 0.25),
            0 0 12px rgba(80, 140, 255, 0.35);
          transition: box-shadow 200ms, opacity 500ms ease;
        }
        /* Hover drop-shadow only for the mirror of the sole ACTIVE original
           window (marked [sg-active] by the snowglobe-active-changed handler).
           Non-active mirrors keep their base shadow on hover. */
        :host([chromeless][sg-active]:hover) {
          background-color: transparent;
          box-shadow:
            0 4px 10px rgba(0, 0, 0, 0.3),
            0 0 18px rgba(80, 140, 255, 0.55);
        }
        :host([chromeless]) .transition-overlay,
        :host([chromeless]) .content-bg {
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          width: 100%;
          height: 100%;
        }
        :host([chromeless]) ::slotted(*) {
          border-radius: 7px;
        }
        /* Chromeless titlebar: only the .title-text strip in the middle
           catches pointer events, and it ALWAYS does so — dragging it
           moves the page-side mirror window (wrapper drag). The button
           positions and slotted extras pass clicks through to the
           underlying canvas, where Squeak draws its own titlebar buttons
           and handles them natively. Use opacity:0 (not visibility:hidden)
           on the buttons so they keep their flex layout footprint without
           disabling hit-testing on .title-text. Resize zones already use
           a near-zero alpha background and need no changes.

           (Formerly the front-most mirror let the whole titlebar pass
           through to Squeak so a titlebar drag moved the *real* window
           natively — but a mirror shows the window's own pixels, not its
           position in Squeak's world, so that drag was invisible and the
           front-most mirror looked undraggable. Now every mirror's strip
           drags the page window, occluded or not.) */
        :host([chromeless]) .titlebar {
          background: transparent;
          pointer-events: none;
        }
        :host([chromeless]) .titlebar > .btn,
        :host([chromeless]) ::slotted([slot="titlebar-extras"]) {
          opacity: 0;
          pointer-events: none;
        }
        :host([chromeless]) .titlebar > .title-text {
          opacity: 0;
          pointer-events: auto;
          cursor: grab;
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
          border-radius: 7px;
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

    // Chromeless occlusion guard: if this chromeless window is not the
    // front-most morphic-window, raise it on pointerdown. The event is
    // not consumed — it still flows through to the slotted Squeak
    // canvas (or the title-text drag strip).
    if (!this._chromelessOcclusionGuardInstalled) {
      this._chromelessOcclusionGuardInstalled = true;
      this.addEventListener('pointerdown', function(e) {
        if (!self.hasAttribute('chromeless')) return;
        if (self._isFrontMostMorphic()) return;
        // If the pointerdown landed on a titlebar button (close,
        // send-to-back, etc.), don't raise the window.
        if (e.composedPath().some(function(el) {
          return el.classList && el.classList.contains('btn');
        })) return;
        // If the event targets the title-text drag strip, raise the
        // window but let the event continue so the titlebar drag
        // handler can initiate a move gesture.
        var titleText = self.shadowRoot.querySelector('.title-text');
        var isTitleTextHit = titleText && e.composedPath().indexOf(titleText) !== -1;
        self._bringToFront();
        self._activateRemoteWindow();
        if (!isTitleTextHit) {
          try { e.stopPropagation(); e.stopImmediatePropagation(); } catch (_) {}
          try { e.preventDefault(); } catch (_) {}
        }
      }, true);
    }

    // Non-Caffeine chromed window occlusion guard: when this window is
    // occluded (visually overlapped by a higher window), the first
    // pointerdown raises it. Slotted children are `inert` so the event
    // hits this capture listener. If the pointerdown is on the titlebar,
    // let it through so the drag handler can start a move.
    if (!this._chromedOcclusionGuardInstalled) {
      this._chromedOcclusionGuardInstalled = true;
      this.addEventListener('pointerdown', function(e) {
        if (self.hasAttribute('chromeless')) return;
        if (self.id === 'embeddedSqueak') return;
        if (!self.isOccluded()) return;
        // If the pointerdown landed on a titlebar button (close,
        // send-to-back, etc.), don't raise the window.
        if (e.composedPath().some(function(el) {
          return el.classList && el.classList.contains('btn');
        })) return;
        // Raise the window. If the pointerdown landed on the titlebar,
        // let the event continue so the drag handler can start a move.
        var titlebar = self.shadowRoot.querySelector('.titlebar');
        var isTitlebarHit = titlebar && e.composedPath().indexOf(titlebar) !== -1;
        self._bringToFront();
        if (!isTitlebarHit) {
          e.stopPropagation();
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      }, true);
      MorphicWindow._updateOcclusionShields();
    }

    // Recalculate occlusion when the mouse enters this window. This
    // ensures that after a window closes, the next window the mouse
    // hovers over becomes non-inert without requiring a click.
    if (!this._pointerEnterOcclusionInstalled) {
      this._pointerEnterOcclusionInstalled = true;
      this.addEventListener('pointerenter', function() {
        MorphicWindow._updateOcclusionShields();
      });
    }

    // embeddedSqueak reclaim: when the Caffeine canvas is clicked while a
    // chromed window is above it, reclaim z-index top.
    if (this.id === 'embeddedSqueak' && !this._esReclaimInstalled) {
      this._esReclaimInstalled = true;
      this.addEventListener('pointerdown', function() {
        self._assignZ('top');
        MorphicWindow._updateOcclusionShields();
      }, true);
    }

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

    // Keep the wrapper sized to its slotted canvas. When the SERVER resizes
    // a mirrored window (e.g. the user resizes the original window in the
    // Squeak UI), the worker resizes the offscreen canvas but nothing
    // updates this wrapper's explicit width/height -- which a prior resize
    // drag may have pinned to a now-stale value. A ResizeObserver on the
    // canvas reconciles the wrapper to the canvas size (see
    // _syncSizeToCanvas), preserving the wrapper's position. Re-run on
    // slotchange so a recycled/replaced canvas is re-observed.
    if (!this._canvasSizeSyncInstalled) {
      this._canvasSizeSyncInstalled = true;
      this._installCanvasSizeSync();
      var syncSlot = this.shadowRoot.querySelector('slot:not([name])');
      if (syncSlot) syncSlot.addEventListener('slotchange', function() { self._installCanvasSizeSync(); });
    }

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
      // Report which edges the user dragged so the server can keep the
      // OPPOSITE (anchored) corner fixed: dragging the left edge holds the
      // right edge; dragging the top edge holds the bottom edge.
      var edges = this._resizeEdges || {};
      this.onResizeComplete({
        x: Math.round(newLeft) + sideBorder,
        y: Math.round(newTop) + titlebar,
        width: Math.round(newWidth) - 2 * sideBorder,
        height: Math.round(newHeight) - titlebar - sideBorder,
        left: edges.left ? 1 : 0,
        top: edges.top ? 1 : 0,
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
    this._clampToViewport();
  }

  _onPointerUp(e) {
    try {
      if (this._dragging && !this._didDrag) {
        // Click without drag: in chromeless mode the slotted canvas
        // (e.g. a Squeak window with its own titlebar) sits underneath
        // the wrapper's drag strip. Forward the click through so a
        // single click on the wrapper's draggable area reaches the
        // remote window. Otherwise (chromed mode), just bring to front.
        if (this.hasAttribute('chromeless')) {
          // Click on the wrapper's drag strip without a drag: don't
          // synthesize a click on the canvas (it could land on a
          // fragment of an overlapping window in the Squeak world).
          // Ask the SnowglobeMorphicService to #activate the real
          // SystemWindow instead, and raise the wrapper.
          this._activateRemoteWindow();
          this._bringToFront();
        } else {
          this._bringToFront();
        }
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

  // Tell the SnowglobeMorphicService (running inside the Caffeine
  // SqueakJS image) to activate the real Morphic SystemWindow this
  // wrapper is mirroring. The Smalltalk side installs an
  // 'activate-remote' listener in Snowglobe>>mapWindow: that maps the
  // wrapper back to its remote-window id and forwards to
  // SnowglobeMorphicService>>activateWindowID:. No-op on non-chromeless
  // wrappers (they don't have the listener).
  _activateRemoteWindow() {
    try {
      this.dispatchEvent(new CustomEvent('activate-remote', {
        bubbles: false, cancelable: false, composed: false
      }));
    } catch (_) {}
  }

  _forwardClickToContent(e) {
    // Find the slotted canvas (or first slotted element) and dispatch
    // a mousedown/mouseup pair on it at the same screen coordinates.
    var slot = this.shadowRoot.querySelector('slot:not([name])');
    if (!slot) return;
    var assigned = slot.assignedElements ? slot.assignedElements() : [];
    var target = null;
    for (var i = 0; i < assigned.length; i++) {
      var el = assigned[i];
      if (el.tagName === 'CANVAS') { target = el; break; }
      var c = el.querySelector && el.querySelector('canvas');
      if (c) { target = c; break; }
      if (!target) target = el;
    }
    if (!target) return;
    var common = {
      bubbles: true, cancelable: true, composed: true,
      clientX: e.clientX, clientY: e.clientY,
      screenX: e.screenX, screenY: e.screenY,
      button: 0, buttons: 0, view: window
    };
    try {
      target.dispatchEvent(new MouseEvent('mousedown', common));
      target.dispatchEvent(new MouseEvent('mouseup', common));
      target.dispatchEvent(new MouseEvent('click', common));
    } catch (_) {}
    this._bringToFront();
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
  //   ctrl-click -> send to back (non-iframe windows only)
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
          var iframes = MorphicWindow._allIframes();
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
    var meta = !!e.metaKey, alt = !!e.altKey, ctrl = !!e.ctrlKey;
    // Handle plain cmd, plain opt, or plain ctrl (never combinations).
    var n = (meta?1:0) + (alt?1:0) + (ctrl?1:0);
    if (n !== 1) return;
    if (e.button !== 0) return;
    var win = sourceIframe
      ? MorphicWindow._findWindowAncestor(sourceIframe)
      : MorphicWindow._findWindowInPath(e.composedPath());
    if (!win) return;
    if (ctrl) {
      // ctrl-click sends the window to back, but only for windows
      // that don't have an iframe as their slotted content (i.e. not
      // the Caffeine window, whose ctrl-clicks belong to Squeak).
      if (win.querySelector('iframe')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      // Suppress the rest of the gesture (pointerup/mouseup/click)
      // so nothing leaks to content or other handlers.
      MorphicWindow._suppressNextGestureTail();
      win._sendToBack();
      win.dispatchEvent(new CustomEvent('morphic-send-to-back', { bubbles: true }));
      return;
    }
    if (alt) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      // Suppress the rest of the gesture (pointerup/mouseup/click) so
      // the click doesn't leak to content underneath (e.g. a Keep
      // viewer table row, which would otherwise open a detail window).
      MorphicWindow._suppressNextGestureTail();
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

  // Collect every iframe in the document, descending into open shadow
  // roots. The plain `document.querySelectorAll('iframe')` misses
  // iframes that live inside a component's shadow DOM (e.g. the Keep
  // viewer's graph frames), so cmd-drag would not engage over them.
  static _allIframes() {
    var out = [];
    (function walk(root) {
      try {
        var ifs = root.querySelectorAll('iframe');
        for (var i = 0; i < ifs.length; i++) out.push(ifs[i]);
        var els = root.querySelectorAll('*');
        for (var j = 0; j < els.length; j++) {
          if (els[j].shadowRoot) walk(els[j].shadowRoot);
        }
      } catch (_) {}
    })(document);
    return out;
  }

  static _installArmDispatchers() {
    MorphicWindow._ensureArmDispatcherOn(window);
    MorphicWindow._ensureArmDispatcherOn(document);
    MorphicWindow._allIframes().forEach(function(f) {
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
    var iframes = MorphicWindow._allIframes();
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

  // Suppress the remaining events in a pointer gesture (pointerup,
  // mouseup, click) after a modifier-click that was fully handled on
  // pointerdown/mousedown. Installs one-shot capture-phase listeners
  // that eat the next occurrence of each event type and then remove
  // themselves.
  static _suppressNextGestureTail() {
    var types = ['pointerup', 'mouseup', 'click', 'contextmenu'];
    types.forEach(function(type) {
      var handler = function(ev) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        ev.stopPropagation();
        window.removeEventListener(type, handler, true);
      };
      window.addEventListener(type, handler, true);
      // Safety: auto-remove after 2s in case the events never fire.
      setTimeout(function() {
        window.removeEventListener(type, handler, true);
      }, 2000);
    });
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
    var allIframes = MorphicWindow._allIframes();
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

  // Install the cmd/opt/ctrl modifier-click handlers on a single
  // iframe so its content participates in cmd-drag (window move),
  // opt-click (collapse), and ctrl-click (send-to-back). Idempotent and
  // safe to call repeatedly; handles srcdoc/lazy iframes via a load
  // hook. Exposed statically so components that create their own
  // iframes inside shadow DOM (e.g. <keep-viewer>'s graph frames) can
  // register them — the instance-level scan below only sees light-DOM
  // iframes.
  static _attachModifierClickToIframe(iframe) {
    if (!iframe) return;
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
    // Gate the load listener so repeated calls (each hot-reload, each
    // reconnect, each srcdoc swap) don't accumulate fresh closures on
    // the same iframe.
    if (!iframe.__morphicLoadHookInstalled) {
      iframe.__morphicLoadHookInstalled = true;
      iframe.addEventListener('load', attach);
    }
  }

  _installIframeModifierClickHandlers() {
    this.querySelectorAll('iframe').forEach(function(iframe) {
      MorphicWindow._attachModifierClickToIframe(iframe);
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
    if (this.hasAttribute('chromeless')) return 0;
    var titlebar = this.shadowRoot.querySelector('.titlebar');
    return titlebar ? titlebar.offsetHeight : 25;
  }

  sideBorderThickness() {
    if (this.hasAttribute('chromeless')) return 0;
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
            // Copy the descriptor rather than reading NewClass.prototype[key]:
            // reading an accessor (e.g. `get borderExtent`) would invoke the
            // getter with the prototype as `this`, throwing "Illegal
            // invocation" when it touches DOM APIs. defineProperty preserves
            // accessors and plain methods alike.
            var desc = Object.getOwnPropertyDescriptor(NewClass.prototype, key);
            Object.defineProperty(ExistingClass.prototype, key, desc);
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

// Clamp newly-added morphic-windows to the viewport.
// connectedCallback isn't patchable via hot-reload, so we use a
// MutationObserver to catch any morphic-window insertion.
//
// The observer watches the WHOLE subtree of document.body, not just its
// direct children: windows are frequently inserted *nested* inside host
// components (e.g. <orbit-task-mirror>, <evaluate-ledger>) rather than
// appended straight to body, and those would otherwise never be clamped.
// Each candidate window is passed by value into clampOne() so the rAF
// closure captures the right element (a prior `var node` loop closure bug
// clamped only the last added node).
(function() {
  function clampOne(win) {
    if (!win || win.id === 'embeddedSqueak') return;
    if (typeof win._clampToViewport !== 'function') return;
    // Defer one frame so the window has laid out (sized its content/
    // canvas/iframe) before we measure and clamp it.
    requestAnimationFrame(function() {
      if (win.isConnected && typeof win._clampToViewport === 'function') {
        win._clampToViewport();
        // Open-time only: keep the new window clear of the icon-manager.
        if (typeof win._avoidIconManager === 'function') win._avoidIconManager();
      }
    });
  }

  function clampInSubtree(node) {
    if (!node || node.nodeType !== 1) return;
    var tag = node.tagName && node.tagName.toLowerCase();
    if (tag === 'morphic-window') clampOne(node);
    if (node.querySelectorAll) {
      node.querySelectorAll('morphic-window').forEach(clampOne);
    }
  }

  // Re-installable across hot-reloads: tear down a prior observer first.
  if (window.__morphicWindowClampObserver) {
    try { window.__morphicWindowClampObserver.disconnect(); } catch (_) {}
  }
  window.__morphicWindowClampObserver = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        clampInSubtree(nodes[j]);
      }
    }
  });
  window.__morphicWindowClampObserver.observe(document.body, {
    childList: true, subtree: true
  });
})();

// Active-window mirroring. The Snowglobe server announces which original
// window is the sole active (topmost) one via the SetActiveWindow (19)
// instruction; the consumer's decode dispatches a 'snowglobe-active-changed'
// event (detail.id = the active window's remote id, "0"/none) on window.top.
// In response we (1) raise that window's mirror to the front so it is topmost
// among the icon-manager windows, mirroring the original's stacking, and
// (2) mark it [sg-active] so only the active mirror shows the hover
// drop-shadow (see the :host([chromeless][sg-active]:hover) rule). Mirror
// elements are tagged with data-remote-world-id in Snowglobe>>mapWindow:.
// Re-installable across hot-reloads.
(function() {
  // Answer the remote-world-id of the mirror under the page pointer, or null
  // (pointer not over a mirror). The consumer's keyboard-forwarding guard
  // (RemoteWindow>>handleKeystroke:) consults this to discard keystrokes typed
  // while the pointer is over an INACTIVE window's mirror — keystrokes land on
  // the active window's canvas (which holds DOM focus) regardless of hover.
  window.__sgMirrorUnderMouse = function() {
    try {
      var pm = window.__pageMouse;
      if (!pm) return null;
      var x = pm.x, y = pm.y;
      if (x == null || y == null) return null;
      var el = document.elementFromPoint(x, y);
      if (!el) return null;
      var mw = el.closest ? el.closest('morphic-window[data-remote-world-id]') : null;
      return mw ? mw.getAttribute('data-remote-world-id') : null;
    } catch (e) { return null; }
  };
  function applyActive(id) {
    var sid = (id == null) ? null : String(id);
    window.__snowglobeActiveWorldID = sid;
    var active = null;
    document.querySelectorAll('morphic-window[data-remote-world-id]').forEach(function(w) {
      if (sid != null && w.getAttribute('data-remote-world-id') === sid) {
        w.setAttribute('sg-active', '');
        active = w;
      } else {
        w.removeAttribute('sg-active');
      }
    });
    if (active && typeof active._bringToFront === 'function') {
      try { active._bringToFront(); } catch (_) {}
    }
  }
  // Re-installable: drop a prior listener first.
  if (window.__snowglobeActiveListener) {
    window.removeEventListener('snowglobe-active-changed', window.__snowglobeActiveListener);
  }
  window.__snowglobeActiveListener = function(e) {
    applyActive(e && e.detail && e.detail.id);
  };
  window.addEventListener('snowglobe-active-changed', window.__snowglobeActiveListener);
  // Apply any already-known active id (e.g. after a hot-reload re-render
  // cleared the [sg-active] attributes).
  if (window.__snowglobeActiveWorldID != null) applyActive(window.__snowglobeActiveWorldID);
})();
