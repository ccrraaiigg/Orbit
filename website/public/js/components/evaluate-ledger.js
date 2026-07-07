// <evaluate-ledger> Web Component
//
// An on-page table view of the evaluate-undo ledger
// (.orbit/toolLogs/evaluate-markers.jsonl). Modeled on the Keep
// viewer's table view, and like it, auto-opens on page load.
//
// Each row is one `evaluate` MCP call the agent recorded just before
// running it. An active row shows an "↩ Undo" button; clicking it asks
// the extension (via the /evaluate-ledger bridge) to signal the
// rollback over the tether and stamp the marker `undoneAt`. Undone rows
// show a dimmed "✓ undone HH:MM:SS" and can't be undone twice. Undos
// are independent and durable — out-of-order and long after the fact.
//
// Data flow (page → express proxy → extension loopback bridge → ledger):
//   GET  /evaluate-ledger        → { ok, markers: [record, …] }
//   POST /evaluate-ledger/undo   → { id } → { ok, record } | { ok:false, … }
//
// Usage:
//   window.OrbitEvaluateLedger.open();   // open (or focus) the window
//
// The component polls for fresh markers while mounted so new evaluate
// calls appear as the agent records them.

(function () {
  'use strict';

  var TAG = 'evaluate-ledger';
  var POLL_MS = 3000;

  function bearerHeaders() {
    var h = { 'accept': 'application/json' };
    var tok = window.__ORBIT_BRIDGE_BEARER__;
    if (tok) h['authorization'] = 'Bearer ' + tok;
    return h;
  }

  function shortTime(rec) {
    var t = rec && rec.at;
    if (typeof t === 'string') {
      var m = t.match(/T(\d{2}:\d{2}:\d{2})/);
      if (m) return m[1];
    }
    return (rec && rec.id) || '?';
  }

  function shortDate(rec) {
    var t = rec && rec.at;
    if (typeof t === 'string') {
      var m = t.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
    }
    return '';
  }

  class EvaluateLedger extends HTMLElement {

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._markers = [];
      this._filter = '';
      this._sortKey = 'at';
      this._sortAsc = false;
      this._error = null;
      this._loading = true;
      this._pollTimer = null;
      this._render();
    }

    connectedCallback() {
      var self = this;
      this._render();
      Promise.resolve().then(function () { self._setupHost(); });
      this.refresh();
      this._startPolling();
    }

    disconnectedCallback() {
      this._stopPolling();
      var host = this.closest('morphic-window');
      if (host && this._closeHandler) {
        host.removeEventListener('morphic-close', this._closeHandler);
      }
      if (this._docPointerdownHandler) {
        document.removeEventListener('pointerdown', this._docPointerdownHandler, true);
      }
      if (this._inertObserver) this._inertObserver.disconnect();
    }

    // ---- host (morphic-window) wiring ----
    // Mirror the essentials of keep-viewer's table-mode host wiring so
    // table buttons stay clickable (the window's occlusion guard would
    // otherwise raise-and-consume the first click, and the shielding
    // system would mark slotted children inert when occluded).
    _setupHost() {
      var self = this;
      var host = this.closest('morphic-window');
      if (!host || host.__evalLedgerWired) return;
      host.__evalLedgerWired = true;
      host.useCutout = false;

      this._closeHandler = function (e) {
        e.stopPropagation();
        e.preventDefault();
        host.remove();
      };
      host.addEventListener('morphic-close', this._closeHandler);

      // Let titlebar/resize interactions through; otherwise stop the
      // occlusion guard from consuming clicks aimed at the table.
      this._docPointerdownHandler = function (e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        var path = e.composedPath();
        var hitsHost = false, hitsTitlebar = false, hitsResize = false;
        for (var i = 0; i < path.length; i++) {
          if (path[i] === host) { hitsHost = true; break; }
          if (path[i].classList && path[i].classList.contains('titlebar')) hitsTitlebar = true;
          if (path[i].classList && path[i].classList.contains('resize-zone')) hitsResize = true;
        }
        if (!hitsHost) return;
        if (hitsTitlebar) {
          host.__allowRaise = true;
          requestAnimationFrame(function () { host.__allowRaise = false; });
          return;
        }
        if (hitsResize) return;
        e.stopPropagation();
      };
      document.addEventListener('pointerdown', this._docPointerdownHandler, true);

      if (!host.__origBringToFront) {
        host.__origBringToFront = host._bringToFront;
        host._bringToFront = function () {
          if (!host.__allowRaise) return;
          return host.__origBringToFront.apply(host, arguments);
        };
      }

      this._inertObserver = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          if (m.type === 'attributes' && m.attributeName === 'inert') {
            m.target.removeAttribute('inert');
          }
        });
      });
      var children = host.children;
      for (var i = 0; i < children.length; i++) {
        children[i].removeAttribute('inert');
        this._inertObserver.observe(children[i], { attributes: true, attributeFilter: ['inert'] });
      }
    }

    // ---- data ----

    _startPolling() {
      var self = this;
      this._stopPolling();
      this._pollTimer = setInterval(function () { self.refresh(); }, POLL_MS);
    }

    _stopPolling() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    }

    refresh() {
      var self = this;
      return fetch('/evaluate-ledger', { headers: bearerHeaders() })
        .then(function (r) {
          return r.json().then(function (body) { return { ok: r.ok, body: body }; });
        })
        .then(function (res) {
          if (!res.ok || !res.body || res.body.ok === false) {
            self._error = (res.body && res.body.error) || ('HTTP error');
            self._loading = false;
            self._render();
            return;
          }
          self._error = null;
          self._loading = false;
          self._markers = Array.isArray(res.body.markers) ? res.body.markers : [];
          self._render();
        })
        .catch(function (e) {
          self._error = String(e && e.message || e);
          self._loading = false;
          self._render();
        });
    }

    _clear() {
      var self = this;
      if (!this._markers.length) return;
      var headers = bearerHeaders();
      headers['content-type'] = 'application/json';
      var btn = this.shadowRoot.querySelector('.clear');
      if (btn) { btn.disabled = true; }
      return fetch('/evaluate-ledger/clear', { method: 'POST', headers: headers, body: '{}' })
        .then(function (r) {
          return r.json().then(function (b) { return { ok: r.ok, body: b }; });
        })
        .then(function () { return self.refresh(); })
        .catch(function (e) {
          self._error = String(e && e.message || e);
          self._render();
        });
    }

    _undo(id) {
      var self = this;
      var body = JSON.stringify({ id: id });
      var headers = bearerHeaders();
      headers['content-type'] = 'application/json';
      // Optimistic visual: disable the button immediately.
      var btn = this.shadowRoot.querySelector('button[data-undo="' + CSS.escape(id) + '"]');
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      return fetch('/evaluate-ledger/undo', { method: 'POST', headers: headers, body: body })
        .then(function (r) {
          return r.json().then(function (b) { return { ok: r.ok, body: b }; });
        })
        .then(function () { return self.refresh(); })
        .catch(function (e) {
          self._error = String(e && e.message || e);
          self._render();
        });
    }

    // ---- rendering ----

    _filtered() {
      var f = this._filter.trim().toLowerCase();
      var list = this._markers.slice();
      if (f) {
        list = list.filter(function (m) {
          return (String(m.id || '') + ' ' + String(m.backend || '') + ' ' +
            String(m.source || '') + ' ' + String(m.tool || ''))
            .toLowerCase().indexOf(f) >= 0;
        });
      }
      var key = this._sortKey, asc = this._sortAsc;
      list.sort(function (a, b) {
        var av = key === 'backend' ? (a.backend || '') : (a.at || a.id || '');
        var bv = key === 'backend' ? (b.backend || '') : (b.at || b.id || '');
        if (av < bv) return asc ? -1 : 1;
        if (av > bv) return asc ? 1 : -1;
        return 0;
      });
      return list;
    }

    _render() {
      var self = this;
      var rows = this._filtered();
      var active = this._markers.filter(function (m) { return !m.undoneAt; }).length;
      var sortArrow = function (key) {
        if (self._sortKey !== key) return '';
        return self._sortAsc ? ' \u25b2' : ' \u25bc';
      };

      var bodyHtml;
      if (this._error) {
        bodyHtml = '<div class="empty err">' + EvaluateLedger._esc(this._error) +
          '<br><span class="dim">Is VS Code running with the Orbit extension?</span></div>';
      } else if (this._loading && !this._markers.length) {
        bodyHtml = '<div class="empty dim">Loading\u2026</div>';
      } else if (!rows.length) {
        bodyHtml = '<div class="empty dim">' +
          (this._markers.length ? 'No markers match the filter.'
            : 'No evaluate markers yet.') + '</div>';
      } else {
        var trs = rows.map(function (m) {
          var undone = !!m.undoneAt;
          var src = String(m.source == null ? '' : m.source);
          var action = undone
            ? '<span class="undone">\u2713 undone ' +
                '<span class="date">' + EvaluateLedger._esc(shortDate({ at: m.undoneAt })) + '</span> ' +
                EvaluateLedger._esc(shortTime({ at: m.undoneAt })) + '</span>'
            : '<button class="undo-btn" data-undo="' + EvaluateLedger._esc(m.id) + '">\u21a9 Undo</button>';
          return '<tr class="' + (undone ? 'is-undone' : '') + '" data-id="' + EvaluateLedger._esc(m.id) + '">' +
            '<td class="time" title="' + EvaluateLedger._esc(m.at || m.id) + '">' +
              '<span class="date">' + EvaluateLedger._esc(shortDate(m)) + '</span> ' +
              EvaluateLedger._esc(shortTime(m)) + '</td>' +
            '<td class="backend">' + EvaluateLedger._esc(m.backend || '?') + '</td>' +
            '<td class="source" title="' + EvaluateLedger._esc(src) + '">' +
              EvaluateLedger._esc(src) + '</td>' +
            '<td class="action">' + action + '</td>' +
          '</tr>';
        }).join('');
        bodyHtml = '<table>' +
          '<thead><tr>' +
            '<th class="col-time" data-sort="at">time' + sortArrow('at') + '</th>' +
            '<th class="col-backend" data-sort="backend">backend' + sortArrow('backend') + '</th>' +
            '<th class="col-source">source</th>' +
            '<th class="col-action">action</th>' +
          '</tr></thead>' +
          '<tbody>' + trs + '</tbody></table>';
      }

      this.shadowRoot.innerHTML =
        '<style>' + EvaluateLedger._STYLES + '</style>' +
        '<div class="container">' +
          '<div class="toolbar">' +
            '<input type="text" class="filter" placeholder="Filter\u2026" value="' +
              EvaluateLedger._esc(this._filter) + '">' +
            '<span class="count">' + active + ' active / ' + this._markers.length + ' total</span>' +
            '<button class="clear" title="Clear all markers">clear</button>' +
            '<button class="refresh" title="Refresh">\u21bb</button>' +
          '</div>' +
          '<div class="content">' + bodyHtml + '</div>' +
        '</div>';

      this._attachEvents();
    }

    _attachEvents() {
      var self = this;
      var filter = this.shadowRoot.querySelector('.filter');
      if (filter) {
        filter.addEventListener('input', function (e) {
          self._filter = e.target.value;
          self._render();
          var f = self.shadowRoot.querySelector('.filter');
          if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
        });
      }
      var refresh = this.shadowRoot.querySelector('.refresh');
      if (refresh) refresh.addEventListener('click', function () { self.refresh(); });

      var clear = this.shadowRoot.querySelector('.clear');
      if (clear) clear.addEventListener('click', function () { self._clear(); });

      this.shadowRoot.querySelectorAll('th[data-sort]').forEach(function (th) {
        th.addEventListener('click', function () {
          var key = th.dataset.sort;
          if (self._sortKey === key) self._sortAsc = !self._sortAsc;
          else { self._sortKey = key; self._sortAsc = true; }
          self._render();
        });
      });

      this.shadowRoot.querySelectorAll('button[data-undo]').forEach(function (btn) {
        btn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          self._undo(btn.dataset.undo);
        });
      });
    }

    static _esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    static get _STYLES() {
      return '' +
        ':host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
          'font-size:12px;color:#e0e0e0;background:#1e1e2e;border-radius:6px;overflow:hidden;height:100%;}' +
        '.container{display:flex;flex-direction:column;height:100%;}' +
        '.toolbar{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#2a2a3e;' +
          'border-bottom:1px solid #3a3a5a;flex-shrink:0;}' +
        '.filter{background:#1a1a2a;border:1px solid #4a4a6a;color:#e0e0e0;padding:3px 8px;' +
          'border-radius:4px;font-size:11px;flex:1;max-width:220px;}' +
        '.filter:focus{outline:none;border-color:#6a6aaa;}' +
        '.count{color:#888;font-size:11px;margin-left:auto;}' +
        '.refresh{background:transparent;border:1px solid #4a4a6a;color:#aaa;padding:2px 8px;' +
          'border-radius:4px;cursor:pointer;font-size:14px;}' +
        '.refresh:hover{background:#3a3a5a;color:#fff;}' +
        '.clear{background:transparent;border:1px solid #6a4a4a;color:#e0a0a0;padding:2px 8px;' +
          'border-radius:4px;cursor:pointer;font-size:11px;}' +
        '.clear:hover{background:#5a3a3a;color:#fff;}' +
        '.clear:disabled{opacity:0.5;cursor:default;}' +
        '.content{flex:1;overflow:auto;padding:0;text-align:left;}' +
        '.empty{padding:24px 16px;text-align:center;font-size:12px;}' +
        '.empty.err{color:#ef9a9a;}' +
        '.dim{color:#888;}' +
        'table{width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed;}' +
        'thead{position:sticky;top:0;background:#2a2a3e;z-index:1;}' +
        'th{text-align:left;padding:5px 8px;color:#aaa;border-bottom:1px solid #3a3a5a;' +
          'cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        'th:hover{color:#fff;}' +
        'td{padding:4px 8px;border-bottom:1px solid #2a2a3e;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;}' +
        'th.col-time,td.time,th:nth-child(1),td:nth-child(1){width:150px;}' +
        'th.col-backend,td.backend,th:nth-child(2),td:nth-child(2){width:72px;}' +
        'th.col-action,td.action,th:nth-child(4),td:nth-child(4){width:178px;}' +
        'tr:hover{background:#2a2a3e;}' +
        'tr.is-undone{opacity:0.55;}' +
        '.time{color:#90a4ae;font-family:monospace;white-space:nowrap;}' +
        '.time .date{color:#5a6a72;}' +
        '.backend{color:#4fc3f7;}' +
        '.source{color:#ffffff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}' +
        '.action{text-align:left;white-space:nowrap;}' +
        '.undo-btn{background:#3a2a3e;border:1px solid #7a4a6a;color:#ffb3d9;padding:2px 8px;' +
          'border-radius:4px;cursor:pointer;font-size:11px;}' +
        '.undo-btn:hover{background:#5a3a5e;color:#fff;}' +
        '.undo-btn:disabled{opacity:0.5;cursor:default;}' +
        '.undone{color:#81c784;font-size:11px;}';
    }
  }

  if (!customElements.get(TAG)) customElements.define(TAG, EvaluateLedger);

  // ---- singleton opener ------------------------------------------------
  // window.OrbitEvaluateLedger.open() creates (or focuses) a
  // <morphic-window> hosting the ledger. Mirrors orbit-task-mirror's
  // window-building approach. Pass { collapsed: true } to have a freshly
  // created window come up collapsed (docked to the icon-manager); used
  // by the auto-open on page load so the ledger is available but not in
  // the way. Has no effect when an existing window is just refocused.
  function open(opts) {
    var existing = document.querySelector('morphic-window[data-evaluate-ledger]');
    if (existing) {
      // Restore the window if the icon-manager has collapsed it
      // (visibility:hidden + iconManagerPendingHidden), then raise it.
      if (existing.dataset) delete existing.dataset.iconManagerPendingHidden;
      if (existing.style && existing.style.visibility === 'hidden') {
        existing.style.visibility = 'visible';
        existing.style.opacity = '1';
      }
      if (typeof existing._bringToFront === 'function') {
        existing.__allowRaise = true;
        try { existing._bringToFront(); } catch (_) {}
        existing.__allowRaise = false;
      }
      var im = document.querySelector('icon-manager');
      if (im && typeof im.refresh === 'function') im.refresh();
      return existing.querySelector('evaluate-ledger');
    }
    var mw = document.createElement('morphic-window');
    mw.setAttribute('caption', 'evaluations');
    mw.setAttribute('data-evaluate-ledger', '1');
    if (opts && opts.collapsed) mw.setAttribute('collapsed', '');
    mw.useCutout = false;
    mw.style.width = '560px';
    mw.style.height = '360px';
    var mp = (typeof window.__pageMouse === 'function') ? window.__pageMouse() : null;
    if (mp && (mp.x || mp.y)) {
      mw.style.left = Math.max(0, Math.round(mp.x)) + 'px';
      mw.style.top = Math.max(0, Math.round(mp.y)) + 'px';
    } else {
      // No pointer yet (e.g. auto-open on page load): dock to the
      // lower-right so it doesn't cover the getting-started doc.
      var vw = window.innerWidth || 1200;
      var vh = window.innerHeight || 800;
      mw.style.left = Math.max(0, vw - 580) + 'px';
      mw.style.top = Math.max(0, vh - 420) + 'px';
    }
    var el = document.createElement('evaluate-ledger');
    mw.appendChild(el);
    document.body.appendChild(mw);
    return el;
  }

  window.OrbitEvaluateLedger = { open: open };

  // Open on page load, like the Keep viewer — but collapsed, so the
  // ledger is docked in the icon-manager rather than covering the page.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { open({ collapsed: true }); }, { once: true });
  } else {
    open({ collapsed: true });
  }
})();
