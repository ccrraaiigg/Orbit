// <system-browser> Web Component
//
// The content pane of a Squeak System Browser. Designed to be
// hosted inside a <morphic-window> element that provides titlebar,
// drag, resize, and z-order chrome.
//
// Layout:
//   * five list panes: namespaces, categories, classes, protocols, methods
//   * instance/class radio toggle + "?" button
//   * action button bar: browse, senders, implementors, versions,
//     inheritance, hierarchy, vars, source
//   * source code pane (monospace text editor)
//   * status bar
//
// Public API:
//
//   sb.packages = ['WebClient-Core', 'Snowglobe', ...]
//     (sets full category names; derives namespaces and subcategories)
//   sb.classes = ['Snowglobe', 'SnowglobeEvent', ...]
//   sb.protocols = ['-- all --', 'accessing', 'connection', ...]
//   sb.methods = ['mapWindow:', 'replaceCanvas:', ...]
//   sb.source = '...'
//   sb.statusText = 'crl 5/28/2026 ...'
//   sb.selectedNamespace / selectedCategory / selectedClass / selectedProtocol / selectedMethod
//   sb.side = 'instance' | 'class'
//
// Custom events:
//
//   'browser-select'   { detail: { pane, index, value } }
//   'browser-action'   { detail: { action } }
//   'browser-side'     { detail: { side: 'instance'|'class' } }
//   'browser-source-change' { detail: { text } }

const BROWSER_ACTIONS = [
  'browse', 'senders', 'implementors', 'versions',
  'inheritance', 'hierarchy', 'vars', 'source'
];

class SystemBrowser extends HTMLElement {

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._packages = [];
    this._namespaces = [];
    this._categories = [];
    this._classes = [];
    this._protocols = [];
    this._methods = [];
    this._selectedNamespace = -1;
    this._selectedCategory = -1;
    this._selectedClass = -1;
    this._selectedProtocol = -1;
    this._selectedMethod = -1;
    this._side = 'instance';
    this._source = '';
    this._statusText = '';
    this._commentActive = false;
  }

  // ---- lifecycle ----

  connectedCallback() {
    this._render();
    this._wire();
    this._renderLists();
  }

  // ---- public API ----

  get packages() { return this._packages.slice(); }
  set packages(arr) {
    this._packages = arr || [];
    this._deriveNamespaces();
    this._renderList('namespaces');
    // If a namespace was selected, re-derive categories
    if (this._selectedNamespace >= 0) {
      this._deriveCategories();
      this._renderList('categories');
    }
  }

  get namespaces() { return this._namespaces.slice(); }
  get categories() { return this._categories.slice(); }
  set categories(arr) { this._categories = arr || []; this._renderList('categories'); }

  get classes() { return this._classes.slice(); }
  set classes(arr) { this._classes = arr || []; this._renderList('classes'); }

  get protocols() { return this._protocols.slice(); }
  set protocols(arr) { this._protocols = arr || []; this._renderList('protocols'); }

  get methods() { return this._methods.slice(); }
  set methods(arr) { this._methods = arr || []; this._selectedMethod = -1; this._renderList('methods'); }

  get selectedNamespace() { return this._selectedNamespace; }
  set selectedNamespace(i) { this._selectedNamespace = i; this._highlightList('namespaces'); }

  get selectedCategory() { return this._selectedCategory; }
  set selectedCategory(i) { this._selectedCategory = i; this._highlightList('categories'); }

  get selectedClass() { return this._selectedClass; }
  set selectedClass(i) { this._selectedClass = i; this._highlightList('classes'); }

  get selectedProtocol() { return this._selectedProtocol; }
  set selectedProtocol(i) { this._selectedProtocol = i; this._highlightList('protocols'); }

  get selectedMethod() { return this._selectedMethod; }
  set selectedMethod(i) { this._selectedMethod = i; this._highlightList('methods'); }

  get side() { return this._side; }
  set side(v) {
    this._side = v === 'class' ? 'class' : 'instance';
    const inst = this.shadowRoot.querySelector('.side-instance');
    const cls = this.shadowRoot.querySelector('.side-class');
    if (inst) inst.classList.toggle('active', this._side === 'instance');
    if (cls) cls.classList.toggle('active', this._side === 'class');
  }

  get source() { return this._source; }
  set source(v) {
    this._source = v || '';
    const ta = this.shadowRoot.querySelector('.source-pane');
    const pre = this.shadowRoot.querySelector('.source-display');
    if (ta) {
      ta.value = this._source;
      ta.style.display = 'block';
      if (pre) pre.style.display = 'none';
      if (this._updateSourceScrollbar) this._updateSourceScrollbar();
    }
    this._setCommentActive(false);
  }

  get sourceHTML() { return this._sourceHTML; }
  set sourceHTML(v) {
    this._sourceHTML = v || '';
    const ta = this.shadowRoot.querySelector('.source-pane');
    const pre = this.shadowRoot.querySelector('.source-display');
    if (pre) {
      pre.innerHTML = this._sourceHTML;
      pre.style.display = 'block';
      if (ta) ta.style.display = 'none';
      if (this._updateSourceScrollbar) this._updateSourceScrollbar();
    }
    this._setCommentActive(false);
  }

  get statusText() { return this._statusText; }
  set statusText(v) {
    this._statusText = v || '';
    const el = this.shadowRoot.querySelector('.status-text');
    if (el) el.textContent = this._statusText;
  }

  set commentText(v) {
    this._source = v || '';
    const ta = this.shadowRoot.querySelector('.source-pane');
    const pre = this.shadowRoot.querySelector('.source-display');
    if (ta) {
      ta.value = this._source;
      ta.style.display = 'block';
      if (pre) pre.style.display = 'none';
      if (this._updateSourceScrollbar) this._updateSourceScrollbar();
    }
    this._setCommentActive(true);
  }

  _setCommentActive(active) {
    this._commentActive = active;
    const btn = this.shadowRoot.querySelector('.help-btn');
    if (btn) btn.classList.toggle('active', active);
  }

  // ---- rendering ----

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          background: #ece9d8;
          font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
          font-size: 12px;
          color: #1a1a1a;
          user-select: none;
          overflow: hidden;
        }

        .lists-area {
          flex: 1 1 140px;
          min-height: 0;
          display: flex;
          border-bottom: 1px solid #999;
        }
        .list-pane {
          flex: 1 1 20%;
          display: flex;
          flex-direction: column;
          border-right: 1px solid #999;
          min-width: 0;
          position: relative;
        }
        .list-pane:last-child { border-right: none; }
        .list-pane .list-scroll {
          flex: 1 1 auto;
          overflow-y: scroll;
          overflow-x: hidden;
          background: #e8e8e8;
          padding-right: 10px;
          scrollbar-width: none;
        }
        .list-pane .list-scroll::-webkit-scrollbar {
          display: none;
        }
        .custom-scrollbar {
          position: absolute;
          top: 0;
          right: 0;
          width: 10px;
          height: 100%;
          background: #f0f0f0;
          border-left: 1px solid #ddd;
          overflow: hidden;
        }
        .list-pane:not(:last-child) > .custom-scrollbar {
          cursor: ew-resize;
        }
        .custom-scrollbar .thumb {
          position: absolute;
          top: 0;
          left: 1px;
          width: 8px;
          background: #aaa;
          border-radius: 4px;
          min-height: 20px;
          cursor: default;
        }
        .custom-scrollbar .thumb:hover,
        .custom-scrollbar .thumb.dragging {
          background: #777;
        }
        .list-pane .list-item {
          padding: 1px 4px;
          text-align: left;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: default;
        }
        .list-pane .list-item:hover {
          background: #e0e8f8;
        }
        .list-pane .list-item.selected {
          background: #3366cc;
          color: #fff;
        }
        .list-pane .list-item .override-marker {
          color: #c00;
          font-weight: bold;
          margin-right: 2px;
        }

        .side-bar {
          flex: 0 0 20px;
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 4px;
          background: #f1ede0;
          border-top: 1px solid #b8b4a4;
          padding: 2px 4px;
        }
        .side-bar button {
          padding: 2px 10px;
          border: 1px solid #888;
          background: #e8e4d8;
          font-size: 11px;
          cursor: default;
          border-radius: 2px;
          pointer-events: auto;
        }
        .side-bar button.active {
          background: #fff;
          border-color: #333;
          font-weight: bold;
        }
        .side-bar button:hover { background: #d8e4f8; }
        .side-bar .help-btn {
          padding: 2px 6px;
          border: 1px solid #888;
          background: #e8e4d8;
          font-size: 11px;
          border-radius: 2px;
          cursor: default;
        }

        .action-bar {
          flex: 0 0 26px;
          display: flex;
          align-items: center;
          gap: 2px;
          padding: 2px 4px;
          background: #f6f3e7;
          border-bottom: 1px solid #b8b4a4;
          cursor: ns-resize;
        }
        .action-bar button {
          padding: 2px 6px;
          border: 1px solid #aaa;
          border-radius: 3px;
          background: #e8e4d8;
          font-size: 11px;
          cursor: default;
          white-space: nowrap;
          pointer-events: auto;
        }
        .action-bar button:hover {
          background: #d8e4f8;
          border-color: #7da2ce;
        }

        .source-area {
          flex: 1 1 auto;
          display: flex;
          min-height: 0;
          border-bottom: 1px solid #b8b4a4;
          position: relative;
        }
        .source-pane {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          box-sizing: border-box;
          border: none;
          outline: none;
          resize: none;
          font-family: inherit;
          font-size: 12px;
          padding: 4px 6px;
          padding-right: 16px;
          background: #e8e8e8;
          color: #111;
          user-select: text;
          tab-size: 4;
          overflow-y: scroll;
          overflow-x: hidden;
          scrollbar-width: none;
        }
        .source-pane::-webkit-scrollbar {
          display: none;
        }
        .source-display {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          box-sizing: border-box;
          border: none;
          font-family: inherit;
          font-size: 12px;
          line-height: 1.4;
          padding: 4px 6px;
          padding-right: 16px;
          background: #e8e8e8;
          color: #111;
          user-select: text;
          tab-size: 4;
          overflow-y: scroll;
          overflow-x: hidden;
          scrollbar-width: none;
          white-space: pre-wrap;
          word-wrap: break-word;
          text-align: left;
          margin: 0;
          display: none;
        }
        .source-display::-webkit-scrollbar {
          display: none;
        }
        .source-area .custom-scrollbar {
          position: absolute;
          top: 0;
          right: 0;
          width: 10px;
          height: 100%;
          background: #eaeaea;
          border-left: 1px solid #ccc;
          overflow: hidden;
        }
        .source-area .custom-scrollbar .thumb {
          position: absolute;
          top: 0;
          left: 1px;
          width: 8px;
          background: #aaa;
          border-radius: 4px;
          min-height: 20px;
          cursor: default;
        }
        .source-area .custom-scrollbar .thumb:hover,
        .source-area .custom-scrollbar .thumb.dragging {
          background: #777;
        }

        .statusbar {
          flex: 0 0 20px;
          display: flex;
          align-items: center;
          padding: 0 6px;
          background: #ece9d8;
          border-top: 1px solid #b8b4a4;
          font-size: 11px;
          color: #444;
          gap: 8px;
          overflow: hidden;
        }
        .status-text {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      </style>

      <div class="lists-area" part="lists">
        <div class="list-pane" data-pane="namespaces"><div class="list-scroll"></div></div>
        <div class="list-pane" data-pane="categories"><div class="list-scroll"></div></div>
        <div class="list-pane" data-pane="classes">
          <div class="list-scroll"></div>
          <div class="side-bar" part="sidebar">
            <button class="side-instance active">instance</button>
            <button class="side-class">class</button>
            <button class="help-btn" title="Comment">?</button>
          </div>
        </div>
        <div class="list-pane" data-pane="protocols"><div class="list-scroll"></div></div>
        <div class="list-pane" data-pane="methods"><div class="list-scroll"></div></div>
      </div>

      <div class="action-bar" part="actions">
        ${BROWSER_ACTIONS.map(a =>
          `<button data-action="${a}">${a}</button>`
        ).join('')}
      </div>

      <div class="source-area">
        <textarea class="source-pane" spellcheck="false"></textarea>
        <pre class="source-display"></pre>
        <div class="custom-scrollbar"><div class="thumb"></div></div>
      </div>

      <div class="statusbar" part="statusbar">
        <span class="status-text"></span>
      </div>
    `;
  }

  _wire() {
    // Side toggle
    this.shadowRoot.querySelector('.side-instance').addEventListener('click', () => {
      this.side = 'instance';
      this.dispatchEvent(new CustomEvent('browser-side', {
        bubbles: true, detail: { side: 'instance' }
      }));
    });
    this.shadowRoot.querySelector('.side-class').addEventListener('click', () => {
      this.side = 'class';
      this.dispatchEvent(new CustomEvent('browser-side', {
        bubbles: true, detail: { side: 'class' }
      }));
    });
    this.shadowRoot.querySelector('.help-btn').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('browser-comment', {
        bubbles: true
      }));
    });

    // Action buttons
    this.shadowRoot.querySelectorAll('.action-bar button').forEach(b => {
      b.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('browser-action', {
          bubbles: true, detail: { action: b.dataset.action }
        }));
      });
    });

    // List selection
    this.shadowRoot.querySelectorAll('.list-pane').forEach(pane => {
      pane.querySelector('.list-scroll').addEventListener('click', e => {
        const item = e.target.closest('.list-item');
        if (!item) return;
        const paneName = pane.dataset.pane;
        const index = parseInt(item.dataset.index, 10);
        this._selectInPane(paneName, index);
      });
    });

    // Source editing
    const textarea = this.shadowRoot.querySelector('.source-pane');
    textarea.addEventListener('input', () => {
      this._source = textarea.value;
      this.dispatchEvent(new CustomEvent('browser-source-change', {
        bubbles: true, detail: { text: textarea.value }
      }));
    });

    // Arrow key navigation in hovered pane
    this._wireArrowKeys();

    // Cmd+drag grab cursor on source pane
    this._wireSourceGrab();

    // Vertical resize between lists and source
    this._wireResize();

    // Custom scrollbars
    this._wireScrollbars();
    this._wireSourceScrollbar();

    // Horizontal pane resize
    this._wirePaneResize();
  }

  _wireScrollbars() {
    this.shadowRoot.querySelectorAll('.list-pane').forEach(pane => {
      const scroll = pane.querySelector('.list-scroll');

      const bar = document.createElement('div');
      bar.className = 'custom-scrollbar';
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      bar.appendChild(thumb);
      pane.appendChild(bar);

      const updateThumb = () => {
        const ratio = scroll.clientHeight / scroll.scrollHeight;
        if (ratio >= 1) { thumb.style.display = 'none'; return; }
        thumb.style.display = 'block';
        const thumbHeight = Math.max(20, ratio * scroll.clientHeight);
        thumb.style.height = thumbHeight + 'px';
        const maxScroll = scroll.scrollHeight - scroll.clientHeight;
        const maxThumbTop = scroll.clientHeight - thumbHeight;
        thumb.style.top = (maxScroll > 0 ? (scroll.scrollTop / maxScroll) * maxThumbTop : 0) + 'px';
      };

      scroll.addEventListener('scroll', updateThumb);

      let dragging = false, startY = 0, startScrollTop = 0;
      thumb.addEventListener('mousedown', (e) => {
        dragging = true;
        startY = e.clientY;
        startScrollTop = scroll.scrollTop;
        thumb.classList.add('dragging');
        e.preventDefault();
        e.stopPropagation();
        const onMove = (e) => {
          const dy = e.clientY - startY;
          const ratio = scroll.scrollHeight / scroll.clientHeight;
          scroll.scrollTop = startScrollTop + dy * ratio;
        };
        const onUp = () => {
          dragging = false;
          thumb.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      bar.addEventListener('click', (e) => {
        if (e.target === thumb) return;
        const rect = bar.getBoundingClientRect();
        const clickY = e.clientY - rect.top;
        scroll.scrollTop = (clickY / rect.height) * scroll.scrollHeight - scroll.clientHeight / 2;
      });

      // Observe content changes to update thumb
      pane._updateScrollbar = updateThumb;
      updateThumb();
    });
  }

  _wirePaneResize() {
    const panes = Array.from(this.shadowRoot.querySelectorAll('.lists-area > .list-pane'));
    const listsArea = this.shadowRoot.querySelector('.lists-area');

    // Initialize flex-basis from current widths
    const totalWidth = listsArea.getBoundingClientRect().width;
    panes.forEach(pane => {
      const w = pane.getBoundingClientRect().width;
      pane.style.flex = `0 0 ${(w / totalWidth) * 100}%`;
    });

    panes.forEach((pane, idx) => {
      if (idx === panes.length - 1) return; // last pane has no right neighbor

      const bar = pane.querySelector('.custom-scrollbar');
      if (!bar) return;

      let dragging = false;

      bar.addEventListener('mousedown', (e) => {
        // Only start resize if not clicking the thumb for scrolling
        if (e.target.classList.contains('thumb')) return;
        dragging = true;
        const startX = e.clientX;
        const leftPane = pane;
        const rightPane = panes[idx + 1];
        const startLeftWidth = leftPane.getBoundingClientRect().width;
        const startRightWidth = rightPane.getBoundingClientRect().width;

        e.preventDefault();
        e.stopPropagation();

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const newLeft = Math.max(30, startLeftWidth + dx);
          const newRight = Math.max(30, startRightWidth - dx);
          const tw = listsArea.getBoundingClientRect().width;
          leftPane.style.flex = `0 0 ${(newLeft / tw) * 100}%`;
          rightPane.style.flex = `0 0 ${(newRight / tw) * 100}%`;
          this._updateAllScrollbars();
        };

        const onUp = () => {
          dragging = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          this._updateAllScrollbars();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  _wireSourceScrollbar() {
    const area = this.shadowRoot.querySelector('.source-area');
    const ta = area.querySelector('.source-pane');
    const pre = area.querySelector('.source-display');
    const bar = area.querySelector('.custom-scrollbar');
    const thumb = bar.querySelector('.thumb');

    const getActiveEl = () => pre.style.display !== 'none' ? pre : ta;

    const updateThumb = () => {
      const el = getActiveEl();
      const ratio = el.clientHeight / el.scrollHeight;
      if (ratio >= 1) { thumb.style.display = 'none'; return; }
      thumb.style.display = 'block';
      const thumbHeight = Math.max(20, ratio * el.clientHeight);
      thumb.style.height = thumbHeight + 'px';
      const maxScroll = el.scrollHeight - el.clientHeight;
      const maxThumbTop = el.clientHeight - thumbHeight;
      thumb.style.top = (maxScroll > 0 ? (el.scrollTop / maxScroll) * maxThumbTop : 0) + 'px';
    };

    ta.addEventListener('scroll', updateThumb);
    ta.addEventListener('input', updateThumb);
    pre.addEventListener('scroll', updateThumb);

    let dragging = false, startY = 0, startScrollTop = 0;
    thumb.addEventListener('mousedown', (e) => {
      const el = getActiveEl();
      dragging = true;
      startY = e.clientY;
      startScrollTop = el.scrollTop;
      thumb.classList.add('dragging');
      e.preventDefault();
      e.stopPropagation();
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        const ratio = el.scrollHeight / el.clientHeight;
        el.scrollTop = startScrollTop + dy * ratio;
      };
      const onUp = () => {
        dragging = false;
        thumb.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    bar.addEventListener('click', (e) => {
      if (e.target === thumb) return;
      const el = getActiveEl();
      const rect = bar.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      el.scrollTop = (clickY / rect.height) * el.scrollHeight - el.clientHeight / 2;
    });

    this._updateSourceScrollbar = updateThumb;
    updateThumb();
  }

  _wireArrowKeys() {
    this.shadowRoot.querySelectorAll('.list-pane').forEach(pane => {
      pane.onmouseenter = () => { this._hoveredPane = pane.dataset.pane; this.focus(); };
      pane.onmouseleave = () => { if (this._hoveredPane === pane.dataset.pane) this._hoveredPane = null; };
    });

    const selMap = { namespaces: '_selectedNamespace', categories: '_selectedCategory', classes: '_selectedClass', protocols: '_selectedProtocol', methods: '_selectedMethod' };

    if (this._arrowKeyHandler) {
      this.removeEventListener('keydown', this._arrowKeyHandler, { capture: true });
    }
    this._arrowKeyHandler = (e) => {
      if (!this._hoveredPane) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const items = this['_' + this._hoveredPane];
      if (!items || items.length === 0) return;
      const prop = selMap[this._hoveredPane];
      let cur = this[prop];
      if (e.key === 'ArrowDown') {
        cur = (cur < items.length - 1) ? cur + 1 : cur;
      } else {
        cur = (cur > 0) ? cur - 1 : 0;
      }
      if (cur !== this[prop]) {
        this._selectInPane(this._hoveredPane, cur);
      }
    };
    this.addEventListener('keydown', this._arrowKeyHandler, { capture: true });

    // Make the host focusable so it receives key events
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    this.style.outline = 'none';
  }

  _wireSourceGrab() {
    const area = this.shadowRoot.querySelector('.source-area');
    const ta = area.querySelector('.source-pane');
    const pre = area.querySelector('.source-display');
    let cmdDown = false;
    let grabbing = false;

    const getActiveEl = () => pre.style.display !== 'none' ? pre : ta;

    const setCursor = (cursor) => {
      ta.style.cursor = cursor;
      pre.style.cursor = cursor;
      if (cursor === 'grabbing') {
        document.documentElement.style.cursor = 'grabbing';
      } else {
        document.documentElement.style.cursor = '';
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Meta' && !cmdDown) {
        cmdDown = true;
        if (!grabbing) setCursor('grab');
      }
    };

    const onKeyUp = (e) => {
      if (e.key === 'Meta') {
        cmdDown = false;
        if (!grabbing) setCursor('');
      }
    };

    const onMouseDown = (e) => {
      if (!cmdDown) return;
      grabbing = true;
      setCursor('grabbing');
      const el = getActiveEl();
      const startX = e.clientX;
      const startY = e.clientY;
      const startScrollLeft = el.scrollLeft;
      const startScrollTop = el.scrollTop;
      e.preventDefault();

      const onMove = (ev) => {
        el.scrollLeft = startScrollLeft - (ev.clientX - startX);
        el.scrollTop = startScrollTop - (ev.clientY - startY);
      };

      const onUp = () => {
        grabbing = false;
        setCursor(cmdDown ? 'grab' : '');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (this._updateSourceScrollbar) this._updateSourceScrollbar();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    area.addEventListener('mousedown', onMouseDown);

    // Reset on blur
    window.addEventListener('blur', () => { cmdDown = false; grabbing = false; setCursor(''); });
  }

  _wireResize() {
    const shadow = this.shadowRoot;
    const listsArea = shadow.querySelector('.lists-area');
    const sideBar = shadow.querySelector('.side-bar');
    const actionBar = shadow.querySelector('.action-bar');
    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    const onMouseDown = (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      startY = e.clientY;
      startHeight = listsArea.getBoundingClientRect().height;
      e.preventDefault();
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      const newHeight = Math.max(60, startHeight + dy);
      listsArea.style.flex = `0 0 ${newHeight}px`;
      this._updateAllScrollbars();
    };

    const onMouseUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      this._updateAllScrollbars();
    };

    sideBar.addEventListener('mousedown', onMouseDown);
    actionBar.addEventListener('mousedown', onMouseDown);

    // ResizeObserver catches all layout changes (drag, window resize, etc.)
    const ro = new ResizeObserver(() => this._updateAllScrollbars());
    ro.observe(listsArea);
    ro.observe(shadow.querySelector('.source-area'));
  }

  _updateAllScrollbars() {
    this.shadowRoot.querySelectorAll('.list-pane').forEach(pane => {
      if (pane._updateScrollbar) pane._updateScrollbar();
    });
    if (this._updateSourceScrollbar) this._updateSourceScrollbar();
  }

  _selectInPane(paneName, index) {
    const propMap = { namespaces: '_selectedNamespace', categories: '_selectedCategory', classes: '_selectedClass', protocols: '_selectedProtocol', methods: '_selectedMethod' };
    const prop = propMap[paneName];
    // Toggle: clicking an already-selected item deselects it
    if ((paneName === 'methods' || paneName === 'protocols') && this[prop] === index) {
      this[prop] = -1;
      this._highlightList(paneName);
      this.dispatchEvent(new CustomEvent('browser-select', {
        bubbles: true,
        detail: { pane: paneName, index: -1, value: null }
      }));
      return;
    }
    switch (paneName) {
      case 'namespaces':
        this._selectedNamespace = index;
        this._selectedCategory = -1;
        this._selectedClass = -1;
        this._selectedProtocol = -1;
        this._selectedMethod = -1;
        this._deriveCategories();
        this._renderList('categories');
        this._classes = []; this._renderList('classes');
        this._protocols = []; this._renderList('protocols');
        this._methods = []; this._renderList('methods');
        break;
      case 'categories': this._selectedCategory = index; break;
      case 'classes': this._selectedClass = index; break;
      case 'protocols': this._selectedProtocol = index; break;
      case 'methods': this._selectedMethod = index; break;
    }
    this._highlightList(paneName);
    const items = this['_' + paneName];
    let value = items[index];
    // For categories, emit the full category name (namespace-category)
    // Unless the category equals the namespace (package had no hyphen)
    if (paneName === 'categories' && this._selectedNamespace >= 0) {
      const ns = this._namespaces[this._selectedNamespace];
      value = (value === ns) ? ns : ns + '-' + value;
    }
    this.dispatchEvent(new CustomEvent('browser-select', {
      bubbles: true,
      detail: { pane: paneName, index, value }
    }));
  }

  _renderLists() {
    this._renderList('namespaces');
    this._renderList('categories');
    this._renderList('classes');
    this._renderList('protocols');
    this._renderList('methods');
  }

  _renderList(paneName) {
    const pane = this.shadowRoot.querySelector(`.list-pane[data-pane="${paneName}"]`);
    if (!pane) return;
    const scroll = pane.querySelector('.list-scroll');
    const items = this['_' + paneName];
    const selMap = { namespaces: '_selectedNamespace', categories: '_selectedCategory', classes: '_selectedClass', protocols: '_selectedProtocol', methods: '_selectedMethod' };
    const selectedIndex = this[selMap[paneName]];
    scroll.innerHTML = items.map((item, i) => {
      const text = typeof item === 'string' ? item : (item.label || '');
      const marker = (item && item.override) ? '<span class="override-marker">\u25A0</span>' : '';
      const sel = i === selectedIndex ? ' selected' : '';
      return `<div class="list-item${sel}" data-index="${i}">${marker}${this._escapeHtml(text)}</div>`;
    }).join('');
    if (pane._updateScrollbar) pane._updateScrollbar();
  }

  _highlightList(paneName) {
    const pane = this.shadowRoot.querySelector(`.list-pane[data-pane="${paneName}"]`);
    if (!pane) return;
    const items = pane.querySelectorAll('.list-item');
    const propMap = { namespaces: '_selectedNamespace', categories: '_selectedCategory', classes: '_selectedClass', protocols: '_selectedProtocol', methods: '_selectedMethod' };
    const sel = this[propMap[paneName]];
    items.forEach((el, i) => {
      el.classList.toggle('selected', i === sel);
    });
  }

  _deriveNamespaces() {
    const nsSet = new Set();
    for (const pkg of this._packages) {
      const idx = pkg.indexOf('-');
      nsSet.add(idx >= 0 ? pkg.substring(0, idx) : pkg);
    }
    this._namespaces = Array.from(nsSet).sort();
  }

  _deriveCategories() {
    if (this._selectedNamespace < 0) { this._categories = []; return; }
    const ns = this._namespaces[this._selectedNamespace];
    this._categories = this._packages
      .filter(pkg => {
        const idx = pkg.indexOf('-');
        return idx >= 0 ? pkg.substring(0, idx) === ns : pkg === ns;
      })
      .map(pkg => {
        const idx = pkg.indexOf('-');
        return idx >= 0 ? pkg.substring(idx + 1) : pkg;
      })
      .sort();
  }

  _escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

if (!customElements.get('system-browser')) {
  customElements.define('system-browser', SystemBrowser);
}
