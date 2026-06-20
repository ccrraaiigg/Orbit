// <lam2300-vr> Web Component
//
// An Orbit window hosting an A-Frame (WebXR) VR simulation of the Lam
// Research 2300 cluster etch tool. The VR scene lives in a dedicated
// page (lam2300-vr.html) and is embedded via an <iframe>, mirroring
// how the Caffeine SqueakJS canvas is embedded in #embeddedSqueak.
// Using an iframe isolates A-Frame's heavy DOM/global footprint from
// the Orbit page and lets <morphic-window> reuse its canvas-cutout
// resize machinery.
//
// Usage:
//
//   var vr = document.createElement('lam2300-vr');
//   vr.setAttribute('caption', 'Lam 2300 — VR');
//   vr.style.top = '120px';
//   vr.style.left = '160px';
//   vr.style.width = '900px';
//   vr.style.height = '560px';
//   document.body.appendChild(vr);
//
// Attributes:
//
//   src      — URL of the VR page (defaults to 'lam2300-vr.html').
//   caption  — Titlebar caption.
//
// The host element uses `display: contents` so the inner morphic-window
// occupies the layout slot. Geometry styles set on the host
// (top/left/width/height/transform/zIndex/position) are mirrored onto
// the inner window.

const LAM2300_FORWARDED_STYLES = ['top', 'left', 'right', 'bottom',
                                  'width', 'height', 'transform', 'zIndex',
                                  'position'];

const LAM2300_FORWARDED_EVENTS = ['morphic-close', 'morphic-send-to-back',
                                  'morphic-maximize', 'morphic-collapse'];

class Lam2300VR extends HTMLElement {

  static get observedAttributes() { return ['src', 'caption']; }

  constructor() {
    super();
    this._window = null;
    this._iframe = null;
  }

  connectedCallback() {
    this.style.display = this.style.display || 'contents';
    this._build();
    this._forwardStyles();
  }

  disconnectedCallback() {
    if (this._window && this._window.parentNode === this) {
      this.removeChild(this._window);
    }
    this._window = null;
    this._iframe = null;
  }

  attributeChangedCallback(name, _oldVal, newVal) {
    if (!this._window) return;
    if (name === 'src' && this._iframe) {
      this._iframe.setAttribute('src', newVal || 'lam2300-vr.html');
    } else if (name === 'caption') {
      this._window.setAttribute('caption',
                                newVal != null ? newVal : 'Lam 2300 — VR');
    }
  }

  // ---- public API ----

  get src() { return this.getAttribute('src') || 'lam2300-vr.html'; }
  set src(v) {
    if (v == null) this.removeAttribute('src');
    else this.setAttribute('src', String(v));
  }

  get caption() { return this.getAttribute('caption') || ''; }
  set caption(v) {
    if (v == null) this.removeAttribute('caption');
    else this.setAttribute('caption', String(v));
  }

  get window() { return this._window; }

  // Access the embedded VR scene's external API (window.Lam2300VR),
  // available once the iframe has loaded.
  get vrApi() {
    try { return this._iframe && this._iframe.contentWindow.Lam2300VR; }
    catch (_) { return null; }
  }

  reload() {
    if (this._iframe) {
      // eslint-disable-next-line no-self-assign
      this._iframe.src = this._iframe.src;
    }
  }

  // ---- internals ----

  _build() {
    if (this._window) return;

    var mw = document.createElement('morphic-window');
    // Canvas-backed (WebGL) embed: keep morphic-window's cutout
    // behavior (the default) so resize drags don't thrash the GL
    // context — same as the Squeak iframe embed.
    var caption = this.getAttribute('caption');
    if (caption == null) caption = 'Lam 2300 — VR';
    mw.setAttribute('caption', caption);

    // Reload button (dev hosts only), parallel to markdown-viewer.
    if (Lam2300VR._isDevHost()) {
      var reloadBtn = Lam2300VR._buildReloadButton();
      var self0 = this;
      reloadBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        self0.reload();
      });
      mw.appendChild(reloadBtn);
    }

    // Centered iframe wrapper, matching the #embeddedSqueak structure
    // (a <center> around the iframe) so morphic-window's geometry and
    // cutout helpers find the iframe as expected.
    var center = document.createElement('center');
    center.style.cssText = 'width:100%;height:100%;margin:0;';

    var iframe = document.createElement('iframe');
    iframe.setAttribute('src', this.getAttribute('src') || 'lam2300-vr.html');
    iframe.setAttribute('marginheight', '0');
    iframe.setAttribute('marginwidth', '0');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('scrolling', 'no');
    iframe.setAttribute('allow', 'xr-spatial-tracking; fullscreen');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('width', '900');
    iframe.setAttribute('height', '520');
    iframe.style.cssText =
      'overflow:hidden;border:0;display:block;width:100%;height:100%;';

    center.appendChild(iframe);
    mw.appendChild(center);
    this.appendChild(mw);

    this._window = mw;
    this._iframe = iframe;

    var self = this;
    LAM2300_FORWARDED_EVENTS.forEach(function (name) {
      mw.addEventListener(name, function (e) {
        self.dispatchEvent(new CustomEvent(name, {
          detail: e.detail, bubbles: true, composed: true
        }));
      });
    });
    mw.addEventListener('morphic-close', function () {
      if (self.parentNode) self.parentNode.removeChild(self);
    });
  }

  _forwardStyles() {
    if (!this._window) return;
    var self = this;
    LAM2300_FORWARDED_STYLES.forEach(function (prop) {
      var v = self.style[prop];
      if (v) self._window.style[prop] = v;
    });
  }

  // ---- static helpers ----

  static _isDevHost() {
    try {
      return new URLSearchParams(location.search).get('backend')
        === '192.168.1.140';
    } catch (_) { return false; }
  }

  static _buildReloadButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Reload VR scene';
    btn.textContent = '\u21bb';
    // Slot into the titlebar so it doesn't take space in the content
    // flow (which would push the iframe down past the bottom edge).
    btn.setAttribute('slot', 'titlebar-extras');
    btn.style.cssText = [
      'all: unset', 'cursor: pointer', 'font-size: 14px',
      'line-height: 1', 'color: #1f2328', 'padding: 0 6px',
      'pointer-events: all'
    ].join(';');
    return btn;
  }
}

customElements.define('lam2300-vr', Lam2300VR);
