// <workbook-window> Web Component
//
// A local reverse-engineering of the VisualWorks Workbook window
// (Workbook class>>windowSpec). Faithfully reproduces:
//
//   * titlebar (label)
//   * menu bar:  Page  Edit  Smalltalk  Options  Help
//   * tool bar:  New  Open  Save | Cut  Copy  Paste | Do-it  Print-it
//                Inspect-it  Debug-it
//   * tab control (named #pages, model #pageHolder)
//   * a text editor area per page
//   * a wide read-only "page explanation" field at the bottom-left
//     (named #pageExplanation, model #pageExplanationHolder)
//   * a narrow read-only "import summary" field at the bottom-right
//     (named #importSummary, model #importSummaryHolder)
//
// Layout proportions follow the original LayoutFrame offsets:
//   - tab control fills, except 25px reserved at the bottom
//   - bottom row is 24px tall; right field is 40px wide; left field
//     fills the remaining width minus a 1px gap
//
// Public API:
//
//   wb.caption = 'Workspace ...'           // string
//   wb.addPage({ label, text, explanation, imports }) -> index
//   wb.removePage(index)
//   wb.currentPageIndex                    // number
//   wb.pages                               // [{label,text,explanation,imports}]
//
// Custom events:
//
//   'workbook-menu'    { detail: { menu: 'Page' } }
//   'workbook-action'  { detail: { action: 'fileNew' | 'fileOpen' | ...
//                                  | 'cut' | 'copy' | 'paste' | 'doIt'
//                                  | 'printIt' | 'inspectIt' | 'debugIt' } }
//   'workbook-page-change' { detail: { index } }
//   'workbook-text-change' { detail: { index, text } }

const TOOLBAR_ITEMS = [
  { id: 'fileNew',    label: 'New',         glyph: '\u{1F5CB}' }, // empty document
  { id: 'fileOpen',   label: 'Open',        glyph: '\u{1F4C2}' }, // open folder
  { id: 'fileSave',   label: 'Save',        glyph: '\u{1F4BE}' }, // floppy
  '-',
  { id: 'cut',        label: 'Cut',         glyph: '\u2702' },
  { id: 'copy',       label: 'Copy',        glyph: '\u29C9' },
  { id: 'paste',      label: 'Paste',       glyph: '\u{1F4CB}' },
  '-',
  { id: 'doIt',       label: 'Do it',       glyph: '\u25B7' },
  { id: 'printIt',    label: 'Print it',    glyph: '\u2399' },
  { id: 'inspectIt',  label: 'Inspect it',  glyph: '\u{1F50D}' },
  { id: 'debugIt',    label: 'Debug it',    glyph: '\u{1F41E}' }
];

const MENU_LABELS = ['Page', 'Edit', 'Smalltalk', 'Options', 'Help'];

class WorkbookWindow extends HTMLElement {

  static get observedAttributes() { return ['caption', 'no-titlebar']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._pages = [];
    this._currentIndex = -1;
    this._dragging = false;
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
  }

  // ---- lifecycle ----

  connectedCallback() {
    if (!this.style.position) this.style.position = 'absolute';
    this._render();
    this._wire();
    if (this._pages.length === 0) {
      this.addPage({ label: 'Page 1',
                     text: '"a fresh workspace page"\n',
                     explanation: 'Default page.',
                     imports: '' });
    }
  }

  attributeChangedCallback(name) {
    if (!this.shadowRoot) return;
    if (name === 'caption' && this._titleEl) {
      this._titleEl.textContent = this.getAttribute('caption') || '';
    }
    if (name === 'no-titlebar') {
      const tb = this.shadowRoot.querySelector('.titlebar');
      if (tb) tb.style.display = this.hasAttribute('no-titlebar') ? 'none' : '';
    }
  }

  // ---- public API ----

  get caption() { return this.getAttribute('caption') || ''; }
  set caption(v) { this.setAttribute('caption', v == null ? '' : String(v)); }

  get pages() { return this._pages.slice(); }
  get currentPageIndex() { return this._currentIndex; }

  addPage(spec) {
    const page = {
      label: (spec && spec.label) || ('Page ' + (this._pages.length + 1)),
      text: (spec && spec.text) || '',
      explanation: (spec && spec.explanation) || '',
      imports: (spec && spec.imports) || ''
    };
    this._pages.push(page);
    this._renderTabs();
    this._selectPage(this._pages.length - 1);
    return this._pages.length - 1;
  }

  removePage(index) {
    if (index < 0 || index >= this._pages.length) return;
    this._pages.splice(index, 1);
    if (this._currentIndex >= this._pages.length) {
      this._currentIndex = this._pages.length - 1;
    }
    this._renderTabs();
    this._renderCurrent();
  }

  // ---- rendering ----

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: absolute;
          display: flex;
          flex-direction: column;
          width: 550px;
          height: 400px;
          min-width: 250px;
          min-height: 100px;
          background: #ece9d8;
          border: 1px solid #4a4a4a;
          box-shadow: 2px 2px 6px rgba(0,0,0,0.35);
          font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
          font-size: 12px;
          color: #1a1a1a;
          user-select: none;
          isolation: isolate;
          overflow: hidden;
        }
        .titlebar {
          flex: 0 0 22px;
          background: linear-gradient(to bottom, #0a64c8 0%, #084a96 100%);
          color: #fff;
          font-weight: bold;
          padding: 0 8px;
          display: flex;
          align-items: center;
          cursor: grab;
        }
        .titlebar.dragging { cursor: grabbing; }
        .menubar {
          flex: 0 0 22px;
          background: #f1ede0;
          border-bottom: 1px solid #b8b4a4;
          display: flex;
          align-items: stretch;
        }
        .menubar .menu {
          padding: 0 10px;
          display: flex;
          align-items: center;
          cursor: default;
        }
        .menubar .menu:hover { background: #d8e4f8; }
        .toolbar {
          flex: 0 0 30px;
          background: #f6f3e7;
          border-bottom: 1px solid #b8b4a4;
          display: flex;
          align-items: center;
          padding: 2px 4px;
          gap: 2px;
        }
        .toolbar button {
          width: 26px;
          height: 26px;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 2px;
          font-size: 14px;
          line-height: 1;
          cursor: default;
          color: #333;
        }
        .toolbar button:hover {
          background: #e1ecfb;
          border-color: #7da2ce;
        }
        .toolbar .sep {
          width: 1px;
          height: 20px;
          background: #b8b4a4;
          margin: 0 4px;
        }
        .body {
          flex: 1 1 auto;
          display: flex;
          flex-direction: column;
          min-height: 0;
          padding: 0;
          position: relative;
        }
        .pages-area {
          position: absolute;
          left: 0; top: 0; right: 0; bottom: 25px;
          display: flex;
          flex-direction: column;
        }
        .tabstrip {
          flex: 0 0 22px;
          display: flex;
          align-items: flex-end;
          background: #ece9d8;
          padding: 2px 4px 0 4px;
          border-bottom: 1px solid #8a8676;
          overflow-x: auto;
        }
        .tab {
          padding: 3px 12px;
          margin-right: 2px;
          background: #d6d2c0;
          border: 1px solid #8a8676;
          border-bottom: none;
          border-top-left-radius: 3px;
          border-top-right-radius: 3px;
          cursor: default;
          white-space: nowrap;
        }
        .tab.active {
          background: #ffffff;
          position: relative;
          top: 1px;
          padding-bottom: 4px;
        }
        .page-host {
          flex: 1 1 auto;
          background: #ffffff;
          border-top: 1px solid #ffffff;
        }
        .page-host textarea {
          width: 100%;
          height: 100%;
          box-sizing: border-box;
          border: none;
          outline: none;
          resize: none;
          font-family: Menlo, Consolas, "Courier New", monospace;
          font-size: 12px;
          padding: 4px 6px;
          background: #ffffff;
          color: #111;
          user-select: text;
        }
        .statusbar {
          position: absolute;
          left: 0; right: 0; bottom: 0;
          height: 24px;
          display: flex;
          gap: 1px;
          padding: 1px 0;
          background: #ece9d8;
          border-top: 1px solid #b8b4a4;
        }
        .statusbar input {
          font-family: inherit;
          font-size: 11px;
          padding: 2px 4px;
          background: #f8f6ec;
          border: 1px solid #b8b4a4;
          color: #333;
          box-sizing: border-box;
          height: 22px;
        }
        .statusbar .explanation { flex: 1 1 auto; }
        .statusbar .imports { flex: 0 0 40px; text-align: center; }
        .resize-grip {
          position: absolute;
          right: 0; bottom: 0;
          width: 14px; height: 14px;
          cursor: nwse-resize;
          background:
            linear-gradient(135deg,
              transparent 0%, transparent 40%,
              #888 40%, #888 50%,
              transparent 50%, transparent 65%,
              #888 65%, #888 75%,
              transparent 75%);
          z-index: 2;
        }
      </style>
      <div class="titlebar" part="titlebar">
        <span class="title-text"></span>
      </div>
      <div class="menubar" part="menubar">
        ${MENU_LABELS.map(m => `<div class="menu" data-menu="${m}">${m}</div>`).join('')}
      </div>
      <div class="toolbar" part="toolbar">
        ${TOOLBAR_ITEMS.map(it =>
          it === '-'
            ? `<div class="sep"></div>`
            : `<button type="button" data-action="${it.id}" title="${it.label}">${it.glyph}</button>`
        ).join('')}
      </div>
      <div class="body">
        <div class="pages-area">
          <div class="tabstrip" part="tabstrip"></div>
          <div class="page-host"><textarea spellcheck="false"></textarea></div>
        </div>
        <div class="statusbar">
          <input class="explanation" type="text" readonly
                 title="Explanation of the current page" />
          <input class="imports" type="text" readonly
                 title="Namespaces imported by this workspace" />
        </div>
        <div class="resize-grip"></div>
      </div>
    `;

    this._titleEl = this.shadowRoot.querySelector('.title-text');
    this._titleEl.textContent = this.getAttribute('caption') || 'Workspace';
    if (this.hasAttribute('no-titlebar')) {
      this.shadowRoot.querySelector('.titlebar').style.display = 'none';
    }
    this._tabstrip = this.shadowRoot.querySelector('.tabstrip');
    this._textarea = this.shadowRoot.querySelector('textarea');
    this._explanation = this.shadowRoot.querySelector('.explanation');
    this._imports = this.shadowRoot.querySelector('.imports');
  }

  _wire() {
    const titlebar = this.shadowRoot.querySelector('.titlebar');
    titlebar.addEventListener('pointerdown', e => this._startDrag(e));

    this.shadowRoot.querySelectorAll('.menubar .menu').forEach(el => {
      el.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('workbook-menu', {
          bubbles: true,
          detail: { menu: el.dataset.menu }
        }));
      });
    });

    this.shadowRoot.querySelectorAll('.toolbar button').forEach(b => {
      b.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('workbook-action', {
          bubbles: true,
          detail: { action: b.dataset.action }
        }));
      });
    });

    this._textarea.addEventListener('input', () => {
      const i = this._currentIndex;
      if (i < 0) return;
      this._pages[i].text = this._textarea.value;
      this.dispatchEvent(new CustomEvent('workbook-text-change', {
        bubbles: true,
        detail: { index: i, text: this._textarea.value }
      }));
    });

    const grip = this.shadowRoot.querySelector('.resize-grip');
    grip.addEventListener('pointerdown', e => this._startResize(e));

    this.addEventListener('pointerdown', () => this._bringToFront(), true);
  }

  _renderTabs() {
    this._tabstrip.innerHTML = '';
    this._pages.forEach((p, i) => {
      const t = document.createElement('div');
      t.className = 'tab' + (i === this._currentIndex ? ' active' : '');
      t.textContent = p.label;
      t.addEventListener('click', () => this._selectPage(i));
      this._tabstrip.appendChild(t);
    });
  }

  _selectPage(i) {
    if (i < 0 || i >= this._pages.length) return;
    this._currentIndex = i;
    this._renderTabs();
    this._renderCurrent();
    this.dispatchEvent(new CustomEvent('workbook-page-change', {
      bubbles: true,
      detail: { index: i }
    }));
  }

  _renderCurrent() {
    const p = this._pages[this._currentIndex];
    if (!p) {
      this._textarea.value = '';
      this._explanation.value = '';
      this._imports.value = '';
      return;
    }
    this._textarea.value = p.text || '';
    this._explanation.value = p.explanation || '';
    this._imports.value = p.imports || '';
  }

  // ---- drag ----

  _startDrag(e) {
    if (e.button !== 0) return;
    const rect = this.getBoundingClientRect();
    this._dragOffsetX = e.clientX - rect.left;
    this._dragOffsetY = e.clientY - rect.top;
    this._dragging = true;
    this.shadowRoot.querySelector('.titlebar').classList.add('dragging');
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    e.preventDefault();
  }

  _onPointerMove(e) {
    if (!this._dragging) return;
    const parent = this.offsetParent || document.body;
    const pr = parent.getBoundingClientRect();
    this.style.left = (e.clientX - pr.left - this._dragOffsetX) + 'px';
    this.style.top  = (e.clientY - pr.top  - this._dragOffsetY) + 'px';
  }

  _onPointerUp() {
    this._dragging = false;
    this.shadowRoot.querySelector('.titlebar').classList.remove('dragging');
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
  }

  // ---- resize ----

  _startResize(e) {
    if (e.button !== 0) return;
    const rect = this.getBoundingClientRect();
    const startW = rect.width, startH = rect.height;
    const startX = e.clientX, startY = e.clientY;
    const move = ev => {
      this.style.width  = Math.max(250, startW + (ev.clientX - startX)) + 'px';
      this.style.height = Math.max(100, startH + (ev.clientY - startY)) + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
    e.stopPropagation();
  }

  // ---- z-order ----

  _bringToFront() {
    const peers = Array.from(document.querySelectorAll(
      'workbook-window, morphic-window, transient-window'));
    let max = 0;
    for (const w of peers) {
      const z = parseInt(w.style.zIndex, 10) || 0;
      if (w !== this && z > max) max = z;
    }
    this.style.zIndex = max + 1;
  }
}

if (!customElements.get('workbook-window')) {
  customElements.define('workbook-window', WorkbookWindow);
}
