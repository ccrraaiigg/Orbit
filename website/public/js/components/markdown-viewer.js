// <markdown-viewer> Web Component
//
// A Markdown file viewer that uses <morphic-window> for its window chrome.
//
// Usage:
//
//   var mv = document.createElement('markdown-viewer');
//   mv.setAttribute('url', 'README.md');
//   mv.setAttribute('caption', 'README');
//   mv.style.top = '80px';
//   mv.style.left = '120px';
//   mv.style.width = '640px';
//   mv.style.height = '480px';
//   document.body.appendChild(mv);
//
// Properties / attributes:
//
//   url      — URL of the Markdown document to fetch and render.
//   caption  — Titlebar caption (defaults to the URL when unset).
//
// The host element uses `display: contents` so the inner morphic-window
// occupies the layout slot. Geometry styles set on the host
// (top/left/width/height/transform/zIndex) are mirrored onto the inner
// window. Custom events from the inner morphic-window (`morphic-close`,
// `morphic-send-to-back`, `morphic-maximize`, `morphic-collapse`) are
// re-dispatched from the host.

const FORWARDED_STYLES = ['top', 'left', 'right', 'bottom',
                          'width', 'height', 'transform', 'zIndex',
                          'position'];

const FORWARDED_EVENTS = ['morphic-close', 'morphic-send-to-back',
                          'morphic-maximize', 'morphic-collapse'];

class MarkdownViewer extends HTMLElement {

  static get observedAttributes() { return ['url', 'caption']; }

  constructor() {
    super();
    this._window = null;
    this._content = null;
    this._fetchToken = 0;
    this._markedPromise = null;
  }

  connectedCallback() {
    this.style.display = this.style.display || 'contents';
    this._build();
    this._forwardStyles();
    if (this.getAttribute('url')) {
      this._loadAndRender();
    }
  }

  disconnectedCallback() {
    if (this._window && this._window.parentNode === this) {
      this.removeChild(this._window);
    }
    this._window = null;
    this._content = null;
  }

  attributeChangedCallback(name, _oldVal, newVal) {
    if (!this._window) return;
    if (name === 'url') {
      this._loadAndRender();
      if (!this.getAttribute('caption')) {
        this._window.setAttribute('caption', newVal || '');
      }
    } else if (name === 'caption') {
      this._window.setAttribute('caption',
                                newVal != null ? newVal
                                : (this.getAttribute('url') || ''));
    }
  }

  // ---- public API ----

  get url() { return this.getAttribute('url') || ''; }
  set url(v) {
    if (v == null) this.removeAttribute('url');
    else this.setAttribute('url', String(v));
  }

  get caption() { return this.getAttribute('caption') || ''; }
  set caption(v) {
    if (v == null) this.removeAttribute('caption');
    else this.setAttribute('caption', String(v));
  }

  get window() { return this._window; }

  reload() { return this._loadAndRender(); }

  // ---- internals ----

  _build() {
    if (this._window) return;

    var mw = document.createElement('morphic-window');
    // HTML content reflows naturally — keep contents visible and live
    // during resize drags rather than swapping to the chrome-only
    // cutout that morphic-window uses for canvas-backed embeds.
    mw.useCutout = false;
    var caption = this.getAttribute('caption');
    if (caption == null) caption = this.getAttribute('url') || '';
    mw.setAttribute('caption', caption);

    // Reload button slotted into the titlebar, left of the right-side
    // traffic-light cluster.
    var reloadBtn = MarkdownViewer._buildReloadButton();
    var self = this;
    reloadBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      self.reload();
    });
    mw.appendChild(reloadBtn);

    var content = document.createElement('div');
    content.className = 'markdown-viewer-content';
    // The morphic-window content area is inset 25px (titlebar) + 5px borders.
    // Our host is `display: contents`, so the morphic-window itself owns
    // the geometry; the content div fills its slot.
    content.style.cssText = [
      'box-sizing: border-box',
      'width: 100%',
      'height: 100%',
      'overflow-y: scroll',
      'overflow-x: auto',
      'padding: 16px 20px',
      'background: #e8e8e8',
      'color: #1f2328',
      'text-align: left',
      'font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI",' +
        ' Helvetica, Arial, sans-serif',
      '-webkit-font-smoothing: antialiased'
    ].join(';');

    // Minimal in-document styles for rendered Markdown. These live on the
    // content div so they don't leak globally; we use a scoped class.
    if (!document.getElementById('markdown-viewer-stylesheet')) {
      var style = document.createElement('style');
      style.id = 'markdown-viewer-stylesheet';
      style.textContent = MarkdownViewer._stylesheet();
      document.head.appendChild(style);
    }

    mw.appendChild(content);
    this.appendChild(mw);

    this._window = mw;
    this._content = content;

    var self = this;
    FORWARDED_EVENTS.forEach(function(name) {
      mw.addEventListener(name, function(e) {
        self.dispatchEvent(new CustomEvent(name, {
          detail: e.detail, bubbles: true, composed: true
        }));
      });
    });
    mw.addEventListener('morphic-close', function() {
      if (self.parentNode) self.parentNode.removeChild(self);
    });
  }

  _forwardStyles() {
    if (!this._window) return;
    var self = this;
    FORWARDED_STYLES.forEach(function(prop) {
      var v = self.style[prop];
      if (v) self._window.style[prop] = v;
    });
  }

  _ensureMarked() {
    if (typeof window.marked !== 'undefined' && window.marked.parse) {
      return Promise.resolve(window.marked);
    }
    if (this._markedPromise) return this._markedPromise;
    this._markedPromise = import('https://esm.sh/marked@12')
      .then(function(mod) {
        var marked = mod.marked || mod.default || mod;
        window.marked = marked;
        return marked;
      })
      .catch(function(err) {
        // Fall back to a minimal renderer if the CDN is unavailable.
        console.warn('markdown-viewer: failed to load marked, using fallback',
                     err);
        return { parse: MarkdownViewer._fallbackRender };
      });
    return this._markedPromise;
  }

  _loadAndRender() {
    var url = this.getAttribute('url');
    if (!url || !this._content) return Promise.resolve();
    var self = this;
    var token = ++this._fetchToken;
    this._content.innerHTML =
      '<p style="color:#6a737d;">Loading <code>' +
      MarkdownViewer._escapeHtml(url) + '</code>\u2026</p>';

    return Promise.all([
      fetch(url, { credentials: 'same-origin' }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
        return r.text();
      }),
      this._ensureMarked()
    ]).then(function(results) {
      if (token !== self._fetchToken) return; // a newer request superseded us
      var text = results[0];
      var marked = results[1];
      var html;
      try {
        html = marked.parse(text, { gfm: true, breaks: false });
      } catch (e) {
        html = MarkdownViewer._fallbackRender(text);
      }
      self._content.innerHTML =
        '<div class="markdown-body">' + html + '</div>';
      // Resolve relative links and images against the document URL.
      self._rewriteRelativeUrls(url);
    }).catch(function(err) {
      if (token !== self._fetchToken) return;
      self._content.innerHTML =
        '<p style="color:#b00020;">Failed to load <code>' +
        MarkdownViewer._escapeHtml(url) + '</code>: ' +
        MarkdownViewer._escapeHtml(String(err && err.message || err)) +
        '</p>';
    });
  }

  _rewriteRelativeUrls(baseUrl) {
    if (!this._content) return;
    var base;
    try { base = new URL(baseUrl, document.baseURI); }
    catch (_) { return; }
    var nodes = this._content.querySelectorAll('a[href], img[src]');
    nodes.forEach(function(el) {
      var attr = el.tagName === 'A' ? 'href' : 'src';
      var v = el.getAttribute(attr);
      if (!v || /^[a-z]+:|^#|^\/\//i.test(v)) return;
      try { el.setAttribute(attr, new URL(v, base).toString()); }
      catch (_) { /* leave as-is */ }
    });
    // Open external links in a new tab.
    this._content.querySelectorAll('a[href]').forEach(function(a) {
      var href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  // ---- statics ----

  static _buildReloadButton() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('slot', 'titlebar-extras');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 15 15');
    svg.setAttribute('data-no-drag', '');
    svg.setAttribute('role', 'button');
    svg.setAttribute('aria-label', 'Reload');
    svg.style.cursor = 'pointer';
    svg.style.transition = 'filter 150ms';
    svg.addEventListener('mouseenter', function() {
      svg.style.filter = 'brightness(1.3)';
    });
    svg.addEventListener('mouseleave', function() {
      svg.style.filter = '';
    });
    // Stop drag/bring-to-front from firing.
    ['pointerdown', 'mousedown'].forEach(function(t) {
      svg.addEventListener(t, function(e) { e.stopPropagation(); });
    });
    var circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '7.5');
    circle.setAttribute('cy', '7.5');
    circle.setAttribute('r', '6.5');
    circle.setAttribute('fill', '#a0a0a0');
    circle.setAttribute('stroke', '#7a7a7a');
    circle.setAttribute('stroke-width', '0.5');
    svg.appendChild(circle);
    // Circular arrow: 3/4 arc + arrowhead.
    var arc = document.createElementNS(ns, 'path');
    arc.setAttribute('d',
      'M 11.0 7.5 A 3.5 3.5 0 1 1 7.5 4.0');
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'white');
    arc.setAttribute('stroke-width', '1.5');
    arc.setAttribute('stroke-linecap', 'round');
    svg.appendChild(arc);
    var head = document.createElementNS(ns, 'polyline');
    head.setAttribute('points', '6.0,2.5 7.5,4.0 6.0,5.5');
    head.setAttribute('fill', 'none');
    head.setAttribute('stroke', 'white');
    head.setAttribute('stroke-width', '1.5');
    head.setAttribute('stroke-linecap', 'round');
    head.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(head);
    return svg;
  }

  static _escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Tiny fallback renderer used only if the marked CDN load fails.
  // Handles a small useful subset: headings, code blocks, inline code,
  // bold, italic, links, and paragraphs.
  static _fallbackRender(src) {
    var esc = MarkdownViewer._escapeHtml;
    var lines = String(src).split(/\r?\n/);
    var out = [];
    var inCode = false, codeBuf = [];
    var paraBuf = [];
    function flushPara() {
      if (!paraBuf.length) return;
      var text = esc(paraBuf.join(' '))
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      out.push('<p>' + text + '</p>');
      paraBuf = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^```/.test(ln)) {
        if (inCode) {
          out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
          codeBuf = []; inCode = false;
        } else { flushPara(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(ln); continue; }
      var h = /^(#{1,6})\s+(.*)$/.exec(ln);
      if (h) { flushPara();
        out.push('<h' + h[1].length + '>' + esc(h[2]) +
                 '</h' + h[1].length + '>');
        continue;
      }
      if (/^\s*$/.test(ln)) { flushPara(); continue; }
      paraBuf.push(ln);
    }
    if (inCode) out.push('<pre><code>' + esc(codeBuf.join('\n')) +
                         '</code></pre>');
    flushPara();
    return out.join('\n');
  }

  static _stylesheet() {
    return [
      '.markdown-viewer-content { scrollbar-gutter: stable; }',
      '.markdown-viewer-content::-webkit-scrollbar {',
      '  width: 12px; height: 12px; }',
      '.markdown-viewer-content::-webkit-scrollbar-track {',
      '  background: rgba(0,0,0,0.06); }',
      '.markdown-viewer-content::-webkit-scrollbar-thumb {',
      '  background: rgba(0,0,0,0.35); border-radius: 6px;',
      '  border: 2px solid transparent; background-clip: padding-box; }',
      '.markdown-viewer-content::-webkit-scrollbar-thumb:hover {',
      '  background: rgba(0,0,0,0.5); background-clip: padding-box;',
      '  border: 2px solid transparent; }',
      '.markdown-body { max-width: 860px; }',
      '.markdown-body h1, .markdown-body h2, .markdown-body h3,',
      '.markdown-body h4, .markdown-body h5, .markdown-body h6 {',
      '  margin: 1.2em 0 0.5em; font-weight: 600; line-height: 1.25; }',
      '.markdown-body h1 { font-size: 1.8em; border-bottom: 1px solid #d0d7de;',
      '                    padding-bottom: 0.2em; }',
      '.markdown-body h2 { font-size: 1.4em; border-bottom: 1px solid #d0d7de;',
      '                    padding-bottom: 0.2em; }',
      '.markdown-body h3 { font-size: 1.2em; }',
      '.markdown-body p  { margin: 0.6em 0; }',
      '.markdown-body code { background: #f6f8fa; padding: 0.15em 0.35em;',
      '                      border-radius: 4px; font-size: 0.9em;',
      '                      font-family: ui-monospace, SFMono-Regular, Menlo,',
      '                      Consolas, monospace; }',
      '.markdown-body pre { background: #f6f8fa; padding: 12px 14px;',
      '                     border-radius: 6px; overflow: auto; }',
      '.markdown-body pre code { background: transparent; padding: 0;',
      '                          font-size: 0.9em; }',
      '.markdown-body blockquote { margin: 0.6em 0; padding: 0 1em;',
      '                            color: #57606a;',
      '                            border-left: 0.25em solid #d0d7de; }',
      '.markdown-body ul, .markdown-body ol { padding-left: 1.6em;',
      '                                       margin: 0.5em 0; }',
      '.markdown-body table { border-collapse: collapse; margin: 0.8em 0; }',
      '.markdown-body th, .markdown-body td {',
      '  border: 1px solid #d0d7de; padding: 6px 12px; }',
      '.markdown-body th { background: #f6f8fa; }',
      '.markdown-body img { max-width: 100%; }',
      '.markdown-body a { color: #0969da; text-decoration: none; }',
      '.markdown-body a:hover { text-decoration: underline; }',
      '.markdown-body hr { border: none; border-top: 1px solid #d0d7de;',
      '                    margin: 1.2em 0; }'
    ].join('\n');
  }

  static hotReload() {
    var ExistingClass = customElements.get('markdown-viewer');
    return fetch('js/components/markdown-viewer.js?' + Date.now())
      .then(function(r) { return r.text(); })
      .then(function(src) {
        src = src.replace(/customElements\.define\([^)]+\);?/, '');
        var NewClass = new Function(src + '\nreturn MarkdownViewer;')();
        Object.getOwnPropertyNames(NewClass.prototype).forEach(function(key) {
          if (key === 'constructor') return;
          var desc = Object.getOwnPropertyDescriptor(NewClass.prototype, key);
          Object.defineProperty(ExistingClass.prototype, key, desc);
        });
        Object.getOwnPropertyNames(NewClass).forEach(function(key) {
          if (key !== 'prototype' && key !== 'length' && key !== 'name') {
            var desc = Object.getOwnPropertyDescriptor(NewClass, key);
            Object.defineProperty(ExistingClass, key, desc);
          }
        });
        var sheet = document.getElementById('markdown-viewer-stylesheet');
        if (sheet) sheet.textContent = ExistingClass._stylesheet();
        document.querySelectorAll('markdown-viewer').forEach(function(mv) {
          var content = mv.querySelector('.markdown-viewer-content');
          if (content) content.style.textAlign = 'left';
          if (mv.getAttribute('url')) mv.reload();
        });
      });
  }
}

customElements.define('markdown-viewer', MarkdownViewer);
