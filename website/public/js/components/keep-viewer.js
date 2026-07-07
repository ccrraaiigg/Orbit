// <keep-viewer> Web Component
//
// Visualizes the Keep store contents in three views:
//   1. Table — filterable, sortable list of notes
//   2. 3D — 3D force-directed graph (WebGL) showing note relationships
//   3. 2D — 2D force-directed graph (canvas) showing note relationships
//
// Usage:
//   var kv = document.createElement('keep-viewer');
//   document.body.appendChild(kv);
//   kv.setData({ notes: [...], edges: [...], edgeTags: [...] });
//
// The component dispatches 'keep-refresh' when the user clicks Refresh.

class KeepViewer extends HTMLElement {

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._notes = [];
    this._edges = [];
    this._edgeTags = [];
    this._activeTab = 'table';
    this._filter = '';
    this._sortKey = 'id';
    this._sortAsc = true;
    this._graphNodes = [];
    this._collapsedGroups = new Set();
    this._graphLayout = 'force';
    this._render();
  }

  connectedCallback() {
    this._render();
    var self = this;
    // Defer host setup to next microtask so the DOM tree is fully assembled
    // (the element may be connected before being parented inside a morphic-window)
    Promise.resolve().then(function() { self._setupHost(); });
  }

  _setupHost() {
    var self = this;
    // When hosted in a morphic-window, intercept the close event
    this._closeHandler = function(e) {
      e.stopPropagation();
      e.preventDefault();
      var mw = self.closest('morphic-window');
      if (mw) mw.remove();
    };
    var host = this.closest('morphic-window');
    if (host) {
      host.addEventListener('morphic-close', this._closeHandler);
      host.useCutout = false;
      // Suppress _bringToFront on the host in table mode, except when
      // the pointerdown was on the titlebar (allow titlebar drag/raise).
      if (!host.__origBringToFront) {
        host.__origBringToFront = host._bringToFront;
        host._bringToFront = function() {
          if (self._activeTab === 'table' && !host.__allowRaise) return;
          return host.__origBringToFront.apply(host, arguments);
        };
      }
      // Intercept pointerdown at document capture phase to prevent
      // the morphic-window occlusion guard from raising AND consuming
      // the event. Let titlebar clicks through for drag/raise.
      this._docPointerdownHandler = function(e) {
        if (self._activeTab !== 'table') return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        var path = e.composedPath();
        var hitsHost = false;
        var hitsTitlebar = false;
        for (var i = 0; i < path.length; i++) {
          if (path[i] === host) { hitsHost = true; break; }
          if (path[i].classList && path[i].classList.contains('titlebar')) hitsTitlebar = true;
        }
        if (!hitsHost) return;
        // Allow titlebar interactions (drag, raise)
        if (hitsTitlebar) {
          host.__allowRaise = true;
          requestAnimationFrame(function() { host.__allowRaise = false; });
          return;
        }
        // Allow resize zone interactions
        var hitsResizeZone = false;
        for (var i = 0; i < path.length; i++) {
          if (path[i] === host) break;
          if (path[i].classList && path[i].classList.contains('resize-zone')) { hitsResizeZone = true; break; }
        }
        if (hitsResizeZone) return;
        e.stopPropagation();
      };
      document.addEventListener('pointerdown', this._docPointerdownHandler, true);
      // Keep slotted content non-inert in table mode. The occlusion
      // shield system sets children inert when occluded — override that
      // with a MutationObserver so clicks always reach the table.
      this._inertObserver = new MutationObserver(function(mutations) {
        if (self._activeTab !== 'table') return;
        mutations.forEach(function(m) {
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
      // Mirror cmd-held/cmd-dragging classes from host morphic-window
      // onto this element so shadow CSS can react to grab cursor state.
      // Also set a cooldown flag when dragging ends to suppress the
      // spurious click that fires after a cmd-drag gesture.
      this._cmdClassObserver = new MutationObserver(function() {
        var wasDragging = self.classList.contains('cmd-dragging');
        var nowDragging = host.classList.contains('cmd-dragging');
        self.classList.toggle('cmd-held', host.classList.contains('cmd-held'));
        self.classList.toggle('cmd-dragging', nowDragging);
        if (wasDragging && !nowDragging) {
          self._dragCooldown = true;
          requestAnimationFrame(function() { self._dragCooldown = false; });
        }
      });
      this._cmdClassObserver.observe(host, { attributes: true, attributeFilter: ['class'] });
    }
  }

  disconnectedCallback() {
    this._destroyForceGraph();
    var host = this.closest('morphic-window');
    if (host) {
      host.removeEventListener('morphic-close', this._closeHandler);
    }
    if (this._docPointerdownHandler) {
      document.removeEventListener('pointerdown', this._docPointerdownHandler, true);
    }
    if (this._inertObserver) {
      this._inertObserver.disconnect();
    }
    if (this._cmdClassObserver) {
      this._cmdClassObserver.disconnect();
    }
  }

  // --- Public API ---

  setData(data) {
    this._notes = data.notes || [];
    this._edges = data.edges || [];
    this._edgeTags = data.edgeTags || [];
    if (!this._collapsedGroups) this._collapsedGroups = new Set();
    if (!this._graphLayout) this._graphLayout = 'force';
    this._setupHost();
    this._buildGraph();
    this._applyDefaultCollapse();
    this._render();
  }

  // On first data load, collapse every section except the one with the
  // most nodes, so the graph opens focused on the largest group rather
  // than showing all groups expanded side-by-side. User toggles
  // afterward are preserved (this runs only once).
  _applyDefaultCollapse() {
    if (this._defaultCollapseApplied) return;
    var self = this;
    var sizes = {};
    Object.keys(this._groups).forEach(function(gid) {
      sizes[gid] = self._groups[gid].length;
    });
    var ungroupedCount = this._notes.filter(function(n) {
      return !self._childToGroup[n.id] && !(n.tags && n.tags.type === 'group');
    }).length;
    if (ungroupedCount > 0) sizes['__ungrouped__'] = ungroupedCount;

    var sectionIds = Object.keys(sizes);
    if (sectionIds.length === 0) { this._defaultCollapseApplied = true; return; }

    var largest = sectionIds.reduce(function(best, id) {
      return sizes[id] > sizes[best] ? id : best;
    }, sectionIds[0]);

    sectionIds.forEach(function(id) {
      if (id !== largest) self._collapsedGroups.add(id);
    });
    this._defaultCollapseApplied = true;
  }

  // --- Internal ---

  _isGraphTab() {
    return this._activeTab === 'graph' || this._activeTab === 'graph2d';
  }

  _render() {
    const self = this;
    this._destroyForceGraph();
    this.shadowRoot.innerHTML = `
      <style>${KeepViewer._STYLES}</style>
      <div class="container">
        <div class="toolbar">
          <button class="tab ${this._activeTab === 'table' ? 'active' : ''}" data-tab="table">Table</button>
          <button class="tab ${this._activeTab === 'graph2d' ? 'active' : ''}" data-tab="graph2d">2D</button>
          <button class="tab ${this._activeTab === 'graph' ? 'active' : ''}" data-tab="graph">3D</button>
          <input type="text" class="filter" placeholder="Filter…" value="${this._escHtml(this._filter)}">
          ${this._isGraphTab() ? `<button class="home-btn">home</button><select class="layout-select">
            <option value="force"${this._graphLayout === 'force' ? ' selected' : ''}>Force</option>
            <option value="td"${this._graphLayout === 'td' ? ' selected' : ''}>Top-Down</option>
            <option value="lr"${this._graphLayout === 'lr' ? ' selected' : ''}>Left-Right</option>
            <option value="radialout"${this._graphLayout === 'radialout' ? ' selected' : ''}>Radial</option>
          </select>` : ''}
          <span class="count">${this._notes.length} notes</span>
          <button class="refresh">↻</button>
        </div>
        <div class="content">
          ${this._activeTab === 'table' ? this._renderTable() : this._renderGraph()}
        </div>
      </div>
    `;
    this._attachEvents();
    this._syncHighlightsFromDetails();
  }

  // Highlight rows or graph nodes for any currently-open detail windows.
  _syncHighlightsFromDetails() {
    var self = this;
    var openDetails = document.querySelectorAll('morphic-window[data-keep-detail]');
    if (!openDetails.length) return;
    var openIds = [];
    openDetails.forEach(function(mw) { openIds.push(mw.getAttribute('data-keep-detail')); });

    if (this._activeTab === 'table') {
      openIds.forEach(function(id) {
        var row = self.shadowRoot.querySelector('tr[data-note-id="' + id + '"]');
        if (row) row.classList.add('detail-open');
      });
    } else if (this._isGraphTab()) {
      // Send highlight messages to graph iframes once they signal ready
      var frames = this.shadowRoot.querySelectorAll('.graph-frame');
      var pending = frames.length;
      if (!pending) return;
      var onReady = function(e) {
        if (e.data && e.data.type === 'keep-graph-ready') {
          pending--;
          // Send highlights to all iframes that have loaded
          frames.forEach(function(iframe) {
            openIds.forEach(function(id) {
              if (iframe.contentWindow) {
                iframe.contentWindow.postMessage({ type: 'keep-highlight-node', id: id }, '*');
              }
            });
          });
          if (pending <= 0) {
            window.removeEventListener('message', onReady);
          }
        }
      };
      window.addEventListener('message', onReady);
    }
  }

  _attachEvents() {
    const self = this;
    this.shadowRoot.querySelectorAll('.tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        self._activeTab = btn.dataset.tab;
        self._render();
      });
    });
    var filterInput = this.shadowRoot.querySelector('.filter');
    if (filterInput) {
      filterInput.addEventListener('input', function(e) {
        self._filter = e.target.value;
        self._render();
      });
    }
    var refreshBtn = this.shadowRoot.querySelector('.refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function() {
        if (self._refreshBlock) {
          // Invoke asynchronously so SqueakJS can execute the block
          // without re-entrant callback timeout
          setTimeout(function() { self._refreshBlock(); }, 0);
        }
        self.dispatchEvent(new CustomEvent('keep-refresh', { bubbles: true }));
      });
    }
    this.shadowRoot.querySelectorAll('th[data-sort]').forEach(function(th) {
      th.addEventListener('click', function() {
        var key = th.dataset.sort;
        if (self._sortKey === key) {
          self._sortAsc = !self._sortAsc;
        } else {
          self._sortKey = key;
          self._sortAsc = true;
        }
        self._render();
      });
    });
    // Table row click — suppress clicks that follow a drag gesture
    // (e.g. cmd-drag to move the window leaves the mouse over a row).
    var lastPointerDown = null;
    this.shadowRoot.querySelectorAll('tr[data-note-id]').forEach(function(tr) {
      tr.addEventListener('pointerdown', function(e) {
        lastPointerDown = { x: e.clientX, y: e.clientY };
        if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
      });
      tr.addEventListener('click', function(e) {
        // Suppress clicks after a cmd-drag gesture
        if (self._dragCooldown) return;
        // If pointerdown was recorded and the click is far from it,
        // it's a post-drag click — suppress it.
        if (lastPointerDown) {
          var dx = e.clientX - lastPointerDown.x;
          var dy = e.clientY - lastPointerDown.y;
          if (dx * dx + dy * dy > 25) { lastPointerDown = null; return; }
        }
        lastPointerDown = null;
        var noteId = tr.dataset.noteId;
        // Close if already open
        var existing = document.querySelector('morphic-window[data-keep-detail="' + noteId + '"]');
        if (existing) {
          existing.remove();
          tr.classList.remove('detail-open');
          self.shadowRoot.querySelectorAll('.graph-frame').forEach(function(iframe) {
            if (iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'keep-highlight-node', id: null }, '*');
          });
        } else {
          self._openNoteDetail(noteId);
          tr.classList.add('detail-open');
        }
      });
    });
    // Graph interactivity
    if (this._isGraphTab()) {
      this._initForceGraph();
      // Layout selector
      var layoutSelect = this.shadowRoot.querySelector('.layout-select');
      if (layoutSelect) {
        layoutSelect.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        layoutSelect.addEventListener('change', function() {
          self._graphLayout = layoutSelect.value;
          self._render();
        });
      }
      // Home button
      var homeBtn = this.shadowRoot.querySelector('.home-btn');
      if (homeBtn) {
        homeBtn.addEventListener('click', function() {
          self.shadowRoot.querySelectorAll('.graph-frame').forEach(function(iframe) {
            if (iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'keep-home' }, '*');
          });
        });
      }
      // Collapse buttons
      this.shadowRoot.querySelectorAll('.graph-collapse-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var gid = btn.dataset.gid;
          if (self._collapsedGroups.has(gid)) {
            self._collapsedGroups.delete(gid);
          } else {
            self._collapsedGroups.add(gid);
          }
          self._render();
        });
      });
    }
  }

  _openNoteDetail(noteId) {
    var self = this;
    var note = this._notes.find(function(n) { return n.id === noteId; });
    if (!note) return;
    // Build a morphic-window with the note content
    var MorphicWindow = customElements.get('morphic-window');
    if (!MorphicWindow) return;
    var mw = document.createElement('morphic-window');
    mw.setAttribute('caption', note.id);
    mw.setAttribute('data-keep-detail', noteId);
    // Position to avoid overlapping other detail windows
    var detailW = 440, detailH = 360;
    var vw = window.innerWidth, vh = window.innerHeight;
    var pos = KeepViewer._findNonOverlappingPosition(detailW, detailH, vw, vh);
    mw.style.position = 'absolute';
    mw.style.left = pos.x + 'px';
    mw.style.top = pos.y + 'px';
    mw.style.width = detailW + 'px';
    mw.style.height = detailH + 'px';
    // Suppress _bringToFront only during the initial connectedCallback
    // so it doesn't reshuffle z-indexes. Restore after connect so the
    // detail can be raised normally later.
    mw.__suppressInitialRaise = true;
    var origBTF = MorphicWindow.prototype._bringToFront;
    mw._bringToFront = function() {
      if (mw.__suppressInitialRaise) return;
      return origBTF.apply(mw, arguments);
    };
    mw.style.zIndex = '4999';

    // Build content
    var tags = note.tags || {};
    var tagLines = Object.keys(tags).map(function(k) {
      return '<span style="display:inline-block;background:#e8e8ee;border-radius:3px;padding:1px 5px;font-size:10px;color:#333;"><b style="color:#1565c0;">' + KeepViewer._esc(k) + '</b>: ' + KeepViewer._esc(tags[k]) + '</span>';
    }).join(' ');

    var detail = document.createElement('div');
    detail.style.cssText = 'padding:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;color:#1a1a1a;overflow-y:scroll;scrollbar-gutter:stable;height:100%;box-sizing:border-box;background:#e8e8e8;text-align:left;';
    detail.className = 'keep-detail';
    detail.innerHTML = `
      <div style="margin-bottom:8px;font-size:14px;font-weight:600;color:#2e7d32;">${KeepViewer._esc(note.id)}</div>
      <div style="margin-bottom:6px;color:#555;font-size:11px;font-style:italic;">${KeepViewer._esc(note.summary || '')}</div>
      <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:4px;">${tagLines}</div>
      <div style="margin-bottom:6px;font-size:10px;color:#777;">agent: ${KeepViewer._esc(note.agent || '')} | ver: ${note.versionCount || 0} | created: ${KeepViewer._esc((note.createdAt || '').slice(0, 16))}</div>
      <hr style="border:none;border-top:1px solid #ddd;margin:8px 0;">
      <div class="keep-md">${KeepViewer._renderMarkdown(note.content || '(no content)')}</div>
    `;
    // Force persistent scrollbar on macOS via document-level style
    if (!document.getElementById('keep-detail-scrollbar-style')) {
      var scrollStyle = document.createElement('style');
      scrollStyle.id = 'keep-detail-scrollbar-style';
      scrollStyle.textContent = `
        .keep-detail::-webkit-scrollbar { width: 10px; }
        .keep-detail::-webkit-scrollbar-track { background: #d0d0d0; border-radius: 4px; }
        .keep-detail::-webkit-scrollbar-thumb { background: #666; border-radius: 4px; min-height: 30px; }
        .keep-detail::-webkit-scrollbar-thumb:hover { background: #444; }
      `;
      document.head.appendChild(scrollStyle);
    }
    mw.appendChild(detail);

    // Close handler
    mw.addEventListener('morphic-close', function(e) {
      e.stopPropagation();
      e.preventDefault();
      mw.remove();
      // Clear row highlight
      var row = self.shadowRoot.querySelector('tr[data-note-id="' + noteId + '"]');
      if (row) row.classList.remove('detail-open');
      // Clear node highlight in graph iframes
      self.shadowRoot.querySelectorAll('.graph-frame').forEach(function(iframe) {
        if (iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'keep-highlight-node', id: null }, '*');
      });
    });

    // Highlight this node in graph iframes
    this.shadowRoot.querySelectorAll('.graph-frame').forEach(function(iframe) {
      if (iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'keep-highlight-node', id: noteId }, '*');
    });

    document.body.appendChild(mw);
    // Allow raising after the initial connect is complete
    mw.__suppressInitialRaise = false;

    // Render any Mermaid diagrams in the detail
    KeepViewer._renderMermaidBlocks(detail);
  }

  _filteredNotes() {
    var f = this._filter.toLowerCase();
    var notes = this._notes;
    if (f) {
      notes = notes.filter(function(n) {
        return (n.id || '').toLowerCase().includes(f) ||
               (n.summary || '').toLowerCase().includes(f) ||
               (n.agent || '').toLowerCase().includes(f) ||
               (n.tags && n.tags.topic || '').toLowerCase().includes(f) ||
               (n.tags && n.tags.type || '').toLowerCase().includes(f) ||
               (n.tags && n.tags.domain || '').toLowerCase().includes(f);
      });
    }
    var key = this._sortKey;
    var asc = this._sortAsc;
    notes = notes.slice().sort(function(a, b) {
      var av = key === 'topic' ? (a.tags && a.tags.topic || '') :
               key === 'type' ? (a.tags && a.tags.type || '') :
               key === 'agent' ? (a.agent || (a.tags && a.tags.agent) || '') :
               key === 'created' ? (a.createdAt || '') :
               (a[key] || '');
      var bv = key === 'topic' ? (b.tags && b.tags.topic || '') :
               key === 'type' ? (b.tags && b.tags.type || '') :
               key === 'agent' ? (b.agent || (b.tags && b.tags.agent) || '') :
               key === 'created' ? (b.createdAt || '') :
               (b[key] || '');
      if (av < bv) return asc ? -1 : 1;
      if (av > bv) return asc ? 1 : -1;
      return 0;
    });
    return notes;
  }

  _renderTable() {
    var notes = this._filteredNotes();
    var sortArrow = (key) => {
      if (this._sortKey !== key) return '';
      return this._sortAsc ? ' ▲' : ' ▼';
    };
    var childToGroup = this._childToGroup || {};
    var rows = notes.map(function(n) {
      var topic = n.tags && n.tags.topic || '';
      var type = n.tags && n.tags.type || '';
      var created = (n.createdAt || '').slice(0, 16).replace('T', ' ');
      var isChild = !!childToGroup[n.id];
      var indent = isChild ? 'padding-left:18px;' : '';
      var groupBadge = type === 'group' ? '<span class="group-badge">▶</span> ' : '';
      return `<tr class="${isChild ? 'child-row' : ''}${type === 'group' ? ' group-row' : ''}" data-note-id="${KeepViewer._esc(n.id)}">
        <td class="id" style="${indent}">${groupBadge}${KeepViewer._esc(n.id)}</td>
        <td class="agent">${KeepViewer._esc(n.agent || (n.tags && n.tags.agent) || '')}</td>
        <td class="topic">${KeepViewer._esc(topic)}</td>
        <td class="type">${KeepViewer._esc(type)}</td>
        <td class="summary" title="${KeepViewer._esc(n.summary || '')}">${KeepViewer._esc(n.summary || n.id)}</td>
        <td class="created">${KeepViewer._esc(created)}</td>
        <td class="ver">${n.versionCount || 0}</td>
      </tr>`;
    }).join('');

    return `<table>
      <thead><tr>
        <th data-sort="id">id${sortArrow('id')}</th>
        <th data-sort="agent">agent${sortArrow('agent')}</th>
        <th data-sort="topic">topic${sortArrow('topic')}</th>
        <th data-sort="type">type${sortArrow('type')}</th>
        <th>summary</th>
        <th data-sort="created">created${sortArrow('created')}</th>
        <th>ver</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // --- Graph (3d-force-graph) ---

  _buildGraph() {
    // Identify groups and children for coloring
    this._groups = {};
    this._childToGroup = {};
    this._notes.forEach(function(n) {
      if (n.tags && n.tags.type === 'group') {
        if (!this._groups[n.id]) this._groups[n.id] = [];
      }
      if (n.tags && n.tags.contained_by) {
        var parent = n.tags.contained_by;
        if (!this._groups[parent]) this._groups[parent] = [];
        this._groups[parent].push(n.id);
        this._childToGroup[n.id] = parent;
      }
    }.bind(this));
  }

  _renderGraph() {
    var self = this;
    var GROUP_BG = ['#1a2a3e', '#1e2e1e', '#2e1e2e', '#2e2a1a', '#1a2e2e'];

    // Collect all sections (groups + ungrouped)
    var sections = [];
    var groupIds = Object.keys(this._groups);
    var idx = 0;
    groupIds.forEach(function(gid) {
      var groupNote = self._notes.find(function(n) { return n.id === gid; });
      sections.push({ id: gid, label: groupNote ? (groupNote.summary || gid) : gid, bg: GROUP_BG[idx % GROUP_BG.length] });
      idx++;
    });
    var ungrouped = self._notes.filter(function(n) {
      return !self._childToGroup[n.id] && !(n.tags && n.tags.type === 'group');
    });
    if (ungrouped.length > 0) {
      sections.push({ id: '__ungrouped__', label: 'Ungrouped', bg: GROUP_BG[idx % GROUP_BG.length] });
    }

    // Split into collapsed (top bars) and expanded (bottom panels)
    var collapsedSections = sections.filter(function(s) { return self._collapsedGroups.has(s.id); });
    var expandedSections = sections.filter(function(s) { return !self._collapsedGroups.has(s.id); });

    var html = '<div class="graph-layout">';

    // Collapsed bars at top
    collapsedSections.forEach(function(s) {
      html += '<div class="graph-collapsed-bar" style="background:' + s.bg + ';">';
      html += '<button class="graph-collapse-btn" data-gid="' + KeepViewer._esc(s.id) + '">\u25b6</button>';
      html += '<span class="graph-bar-text">' + KeepViewer._esc(s.label) + '</span>';
      html += '</div>';
    });

    // Expanded panels side-by-side
    if (expandedSections.length > 0) {
      html += '<div class="graph-panels">';
      expandedSections.forEach(function(s) {
        html += '<div class="graph-section" style="background:' + s.bg + ';">';
        html += '<div class="graph-section-label"><button class="graph-collapse-btn" data-gid="' + KeepViewer._esc(s.id) + '">\u25bc</button><span class="graph-label-text">' + KeepViewer._esc(s.label) + '</span></div>';
        html += '<iframe class="graph-frame" data-group="' + KeepViewer._esc(s.id) + '" frameborder="0"></iframe>';
        html += '</div>';
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  _initForceGraph() {
    var self = this;
    var frames = this.shadowRoot.querySelectorAll('.graph-frame');
    if (!frames.length) return;

    // Color palette by topic
    var topics = [];
    this._notes.forEach(function(n) {
      var topic = n.tags && n.tags.topic || '';
      if (topic && topics.indexOf(topic) === -1) topics.push(topic);
    });
    var COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8',
                  '#4dd0e1', '#aed581', '#ff8a65', '#f06292', '#7986cb'];

    frames.forEach(function(iframe) {
      var gid = iframe.dataset.group;
      var memberIds;
      if (gid === '__ungrouped__') {
        memberIds = self._notes.filter(function(n) {
          return !self._childToGroup[n.id] && !(n.tags && n.tags.type === 'group');
        }).map(function(n) { return n.id; });
      } else {
        memberIds = (self._groups[gid] || []).slice();
      }

      var memberSet = {};
      memberIds.forEach(function(id) { memberSet[id] = true; });

      // Build nodes for this group
      var nodes = [];
      self._notes.forEach(function(n) {
        if (!memberSet[n.id]) return;
        var topicIdx = topics.indexOf(n.tags && n.tags.topic || '');
        nodes.push({
          id: n.id,
          name: n.id,
          summary: n.summary || n.id,
          topic: n.tags && n.tags.topic || '',
          color: topicIdx >= 0 ? COLORS[topicIdx % COLORS.length] : '#888'
        });
      });

      // Build links (only edges where BOTH endpoints are in this group)
      var links = [];
      self._edges.forEach(function(e) {
        var from = e.from || e.source;
        var to = e.to || e.target;
        var via = e.via || e.tag;
        if (via === 'contains' || via === 'contained_by') return;
        if (memberSet[from] && memberSet[to]) {
          links.push({ source: from, target: to, via: via });
        }
      });

      var graphData = JSON.stringify({ nodes: nodes, links: links });
      var topicLegend = JSON.stringify(topics.map(function(t, i) { return { topic: t, color: COLORS[i % COLORS.length] }; }));
      var layoutMode = JSON.stringify(self._graphLayout || 'force');

      var html;
      if (self._activeTab === 'graph2d') {
        html = self._build2DGraphHtml(graphData, topicLegend, layoutMode);
      } else {
        html = '<!DOCTYPE html>\n<html><head>\n' +
        '<style>\n' +
        '* { margin: 0; padding: 0; }\n' +
        'html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }\n' +
        '#graph { width: 100%; height: 100%; }\n' +
        '#legend { position: absolute; bottom: 4px; left: 4px; right: 4px; display: flex; flex-wrap: wrap; gap: 6px; padding: 3px 6px; background: rgba(0,0,0,0.5); border-radius: 3px; }\n' +
        '.legend-item { display: flex; align-items: center; gap: 3px; font: 10px -apple-system, sans-serif; color: #ccc; cursor: pointer; pointer-events: auto; user-select: none; }\n' +
        '.legend-item:hover { color: #fff; }\n' +
        '.legend-item.active { color: #fff; text-decoration: underline; }\n' +
        '.legend-swatch { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }\n' +
        '</style>\n' +
        '</head><body>\n<div id="graph"></div>\n' +
        '<div id="legend"></div>\n' +
        '<script type="module">\n' +
        'var legendData = ' + topicLegend + ';\n' +
        'var legendEl = document.getElementById("legend");\n' +
        'var highlightTopics = new Set();\n' +
        'var highlightNodeId = null;\n' +
        'window.addEventListener("message", function(e) {\n' +
        '  if (e.data && e.data.type === "keep-highlight-node") {\n' +
        '    highlightNodeId = e.data.id || null;\n' +
        '    graph.nodeThreeObject(graph.nodeThreeObject());\n' +
        '  }\n' +
        '  if (e.data && e.data.type === "keep-home") {\n' +
        '    if (homePos) graph.cameraPosition(homePos, homeLookAt, 800);\n' +
        '  }\n' +
        '});\n' +
        'legendData.forEach(function(item, idx) {\n' +
        '  var el = document.createElement("div");\n' +
        '  el.className = "legend-item";\n' +
        '  el.dataset.topic = item.topic;\n' +
        '  el.innerHTML = \'<div class="legend-swatch" style="background:\' + item.color + \'"></div>\' + item.topic;\n' +
        '  el.addEventListener("click", function() {\n' +
        '    if (highlightTopics.has(item.topic)) { highlightTopics.delete(item.topic); } else { highlightTopics.add(item.topic); }\n' +
        '    el.classList.toggle("active", highlightTopics.has(item.topic));\n' +
        '    graph.nodeThreeObject(graph.nodeThreeObject());\n' +
        '    if (highlightTopics.has(item.topic)) {\n' +
        '      var target = data.nodes.find(function(n) { return n.topic === item.topic; });\n' +
        '      if (target) {\n' +
        '        var dist = 160;\n' +
        '        var pos = graph.cameraPosition();\n' +
        '        var angle = Math.atan2(pos.x - target.x, pos.z - target.z);\n' +
        '        graph.cameraPosition({ x: target.x + dist * Math.sin(angle), y: target.y + dist * 0.3, z: target.z + dist * Math.cos(angle) }, { x: target.x, y: target.y, z: target.z }, 1000);\n' +
        '      }\n' +
        '    }\n' +
        '  });\n' +
        '  legendEl.appendChild(el);\n' +
        '});\n' +
        'if (!legendData.length) legendEl.style.display = "none";\n' +
        // Load 3d-force-graph and three-spritetext from esm.sh pinned to a
        // single shared three instance (?deps=three@…). jsdelivr's /+esm
        // bundles a separate three copy into each package, producing two
        // THREE instances; the graph's raycaster (one copy) then cannot
        // intersect the label sprites (the other copy), silently breaking
        // node hover/tooltips. Sharing one three fixes raycasting.
        'import ForceGraph3D from "https://esm.sh/3d-force-graph?deps=three@0.180.0";\n' +
        'import SpriteText from "https://esm.sh/three-spritetext?deps=three@0.180.0";\n' +
        'import {forceCollide, forceRadial} from "https://cdn.jsdelivr.net/npm/d3-force-3d/+esm";\n' +
        'var data = ' + graphData + ';\n' +
        'var layout = ' + layoutMode + ';\n' +
        'var graph = ForceGraph3D()(document.getElementById("graph"))\n' +
        '  .backgroundColor("rgba(0,0,0,0)")\n' +
        '  .showNavInfo(false)\n' +
        '  .enableNodeDrag(true)\n' +
        '  .nodeThreeObject(function(node) {\n' +
        '    var isHighlighted = (highlightTopics.size > 0 && highlightTopics.has(node.topic)) || node.id === highlightNodeId;\n' +
        '    var txt = new SpriteText(node.id, 3.5, "#ffffff");\n' +
        '    txt.backgroundColor = node.color;\n' +
        '    txt.padding = isHighlighted ? 2.5 : 1.5;\n' +
        '    txt.borderRadius = 2;\n' +
        '    txt.borderWidth = isHighlighted ? 1.5 : 0;\n' +
        '    txt.borderColor = isHighlighted ? "#ff0000" : "transparent";\n' +
        '    txt.material.depthWrite = false;\n' +
        '    return txt;\n' +
        '  })\n' +
        '  .nodeThreeObjectExtend(false)\n' +
        '  .nodeLabel(function(n) {\n' +
        '    return "<div style=\\"color:#fff;background:#333;padding:4px 8px;border-radius:4px;font-size:11px;\\"><b>" + n.id + "</b><br/>" + (n.summary || "") + "</div>";\n' +
        '  })\n' +
        '  .linkColor(function() { return "#5a5a7a"; })\n' +
        '  .linkOpacity(0.6)\n' +
        '  .linkWidth(1.5)\n' +
        '  .linkDirectionalArrowLength(3.5)\n' +
        '  .linkDirectionalArrowRelPos(1)\n' +
        '  .linkThreeObjectExtend(true)\n' +
        '  .linkThreeObject(function(link) {\n' +
        '    var txt = new SpriteText(link.via || "", 2.5, "#aaaaaa");\n' +
        '    txt.material.depthWrite = false;\n' +
        '    return txt;\n' +
        '  })\n' +
        '  .linkPositionUpdate(function(sprite, coords) {\n' +
        '    var mc = { x: (coords.start.x + coords.end.x) / 2, y: (coords.start.y + coords.end.y) / 2, z: (coords.start.z + coords.end.z) / 2 };\n' +
        '    Object.assign(sprite.position, mc);\n' +
        '  })\n' +
        '  .cooldownTicks(layout === "radialout" ? 0 : 60)\n' +
        '  .warmupTicks(layout === "radialout" ? 200 : 0)\n' +
        '  .onNodeClick(function(node) {\n' +
        '    window.parent.postMessage({ type: "keep-node-click", id: node.id }, "*");\n' +
        '  })\n' +
        '  .onNodeDragEnd(function(node) {\n' +
        '    node.fx = node.x; node.fy = node.y; node.fz = node.z;\n' +
        '  });\n' +
        'if (layout !== "force" && layout !== "radialout") graph.dagMode(layout);\n' +
        'if (layout === "radialout") {\n' +
        '  var degreeMap = {};\n' +
        '  data.links.forEach(function(l) {\n' +
        '    var s = typeof l.source === "object" ? l.source.id : l.source;\n' +
        '    var t = typeof l.target === "object" ? l.target.id : l.target;\n' +
        '    degreeMap[s] = (degreeMap[s] || 0) + 1;\n' +
        '    degreeMap[t] = (degreeMap[t] || 0) + 1;\n' +
        '  });\n' +
        '  var maxDeg = Math.max.apply(null, Object.values(degreeMap).concat([1]));\n' +
        '  data.nodes.forEach(function(n) { n._degree = degreeMap[n.id] || 0; });\n' +
        '  graph.d3Force("charge").strength(-600);\n' +
        '  graph.d3Force("link").distance(60);\n' +
        '  graph.d3Force("collision", forceCollide(35));\n' +
        '  graph.d3Force("radial", forceRadial(function(n) {\n' +
        '    return (1 - n._degree / maxDeg) * 250 + 20;\n' +
        '  }).strength(0.8));\n' +
        '  graph.d3Force("center", null);\n' +
        '}\n' +
        'else { graph.d3Force("charge").strength(-150); }\n' +
        'graph.graphData(data);\n' +
        'var zoomPad = layout === "radialout" ? -100 : -200;\n' +
        'var homePos = null, homeLookAt = null;\n' +
        'function saveHome() {\n' +
        '  homePos = Object.assign({}, graph.cameraPosition());\n' +
        '  var ctrl = graph.controls();\n' +
        '  homeLookAt = ctrl && ctrl.target ? { x: ctrl.target.x, y: ctrl.target.y, z: ctrl.target.z } : { x: 0, y: 0, z: 0 };\n' +
        '}\n' +
        'if (layout === "radialout") {\n' +
        '  window.setTimeout(function() { graph.zoomToFit(800, zoomPad); window.setTimeout(saveHome, 900); }, 100);\n' +
        '} else {\n' +
        '  var firstStop = true; graph.onEngineStop(function() {\n' +
        '    if (firstStop) {\n' +
        '      firstStop = false;\n' +
        '      graph.zoomToFit(800, zoomPad);\n' +
        '      window.setTimeout(saveHome, 900);\n' +
        '    }\n' +
        '  });\n' +
        '}\n' +
        'window.addEventListener("resize", function() {\n' +
        '  graph.width(window.innerWidth).height(window.innerHeight);\n' +
        '});\n' +
        'window.parent.postMessage({ type: "keep-graph-ready" }, "*");\n' +
        '<\/script>\n</body></html>';
      }

      iframe.srcdoc = html;

      // Register this graph iframe with the host morphic-window's
      // modifier-click system so cmd-drag moves the window even when the
      // gesture starts over the 3D graph. The iframe lives in this
      // component's shadow DOM, so the window's own light-DOM iframe scan
      // never sees it — we must opt it in explicitly.
      var MW = window.customElements && customElements.get('morphic-window');
      if (MW && typeof MW._attachModifierClickToIframe === 'function') {
        MW._attachModifierClickToIframe(iframe);
      }
    });

    // Listen for click messages from iframes
    this._iframeMessageHandler = function(e) {
      if (e.data && e.data.type === 'keep-node-click') {
        self._openNoteDetail(e.data.id);
      }
    };
    window.addEventListener('message', this._iframeMessageHandler);
  }

  // Build the 2D force-graph iframe document. Mirrors the 3D variant but
  // renders each node as a labeled rounded rect on a 2D canvas (force-graph)
  // instead of a WebGL SpriteText. Shares the layout selector, legend
  // topic-highlight, node-click, and home/highlight postMessage protocol.
  _build2DGraphHtml(graphData, topicLegend, layoutMode) {
    return '<!DOCTYPE html>\n<html><head>\n' +
      '<style>\n' +
      '* { margin: 0; padding: 0; }\n' +
      'html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }\n' +
      '#graph { width: 100%; height: 100%; }\n' +
      '#legend { position: absolute; bottom: 4px; left: 4px; right: 4px; display: flex; flex-wrap: wrap; gap: 6px; padding: 3px 6px; background: rgba(0,0,0,0.5); border-radius: 3px; }\n' +
      '.legend-item { display: flex; align-items: center; gap: 3px; font: 10px -apple-system, sans-serif; color: #ccc; cursor: pointer; pointer-events: auto; user-select: none; }\n' +
      '.legend-item:hover { color: #fff; }\n' +
      '.legend-item.active { color: #fff; text-decoration: underline; }\n' +
      '.legend-swatch { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }\n' +
      '</style>\n' +
      '</head><body>\n<div id="graph"></div>\n' +
      '<div id="legend"></div>\n' +
      '<script type="module">\n' +
      'var legendData = ' + topicLegend + ';\n' +
      'var legendEl = document.getElementById("legend");\n' +
      'var highlightTopics = new Set();\n' +
      'var highlightNodeId = null;\n' +
      'window.addEventListener("message", function(e) {\n' +
      '  if (e.data && e.data.type === "keep-highlight-node") {\n' +
      '    highlightNodeId = e.data.id || null;\n' +
      '    if (graph) graph.nodeCanvasObject(graph.nodeCanvasObject());\n' +
      '  }\n' +
      '  if (e.data && e.data.type === "keep-home") {\n' +
      '    if (graph) graph.zoomToFit(800, 30);\n' +
      '  }\n' +
      '});\n' +
      'legendData.forEach(function(item, idx) {\n' +
      '  var el = document.createElement("div");\n' +
      '  el.className = "legend-item";\n' +
      '  el.dataset.topic = item.topic;\n' +
      '  el.innerHTML = \'<div class="legend-swatch" style="background:\' + item.color + \'"></div>\' + item.topic;\n' +
      '  el.addEventListener("click", function() {\n' +
      '    if (highlightTopics.has(item.topic)) { highlightTopics.delete(item.topic); } else { highlightTopics.add(item.topic); }\n' +
      '    el.classList.toggle("active", highlightTopics.has(item.topic));\n' +
      '    graph.nodeCanvasObject(graph.nodeCanvasObject());\n' +
      '    if (highlightTopics.has(item.topic)) {\n' +
      '      var target = data.nodes.find(function(n) { return n.topic === item.topic; });\n' +
      '      if (target && target.x != null) { graph.centerAt(target.x, target.y, 1000); graph.zoom(3, 1000); }\n' +
      '    }\n' +
      '  });\n' +
      '  legendEl.appendChild(el);\n' +
      '});\n' +
      'if (!legendData.length) legendEl.style.display = "none";\n' +
      'import ForceGraph from "https://esm.sh/force-graph";\n' +
      'import {forceCollide} from "https://cdn.jsdelivr.net/npm/d3-force/+esm";\n' +
      'var data = ' + graphData + ';\n' +
      'var layout = ' + layoutMode + ';\n' +
      'var graph = ForceGraph()(document.getElementById("graph"))\n' +
      '  .backgroundColor("rgba(0,0,0,0)")\n' +
      '  .nodeRelSize(4)\n' +
      '  .nodeLabel(function(n) {\n' +
      '    return "<div style=\\"color:#fff;background:#333;padding:4px 8px;border-radius:4px;font-size:11px;\\"><b>" + n.id + "</b><br/>" + (n.summary || "") + "</div>";\n' +
      '  })\n' +
      '  .nodeCanvasObject(function(node, ctx, globalScale) {\n' +
      '    var label = node.id;\n' +
      '    var fontSize = 12 / globalScale;\n' +
      '    ctx.font = fontSize + "px -apple-system, sans-serif";\n' +
      '    var textWidth = ctx.measureText(label).width;\n' +
      '    var padH = 4 / globalScale, padV = 2 / globalScale;\n' +
      '    var w = textWidth + padH * 2, h = fontSize + padV * 2;\n' +
      '    var isHighlighted = (highlightTopics.size > 0 && highlightTopics.has(node.topic)) || node.id === highlightNodeId;\n' +
      '    var r = 2 / globalScale;\n' +
      '    var x = node.x - w / 2, y = node.y - h / 2;\n' +
      '    ctx.beginPath();\n' +
      '    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); } else { ctx.rect(x, y, w, h); }\n' +
      '    ctx.fillStyle = node.color;\n' +
      '    ctx.fill();\n' +
      '    if (isHighlighted) { ctx.strokeStyle = "#ff0000"; ctx.lineWidth = 1.5 / globalScale; ctx.stroke(); }\n' +
      '    ctx.textAlign = "center"; ctx.textBaseline = "middle";\n' +
      '    ctx.fillStyle = "#ffffff";\n' +
      '    ctx.fillText(label, node.x, node.y);\n' +
      '    node.__bckgDimensions = [w, h];\n' +
      '  })\n' +
      '  .nodePointerAreaPaint(function(node, color, ctx) {\n' +
      '    var d = node.__bckgDimensions;\n' +
      '    if (d) { ctx.fillStyle = color; ctx.fillRect(node.x - d[0] / 2, node.y - d[1] / 2, d[0], d[1]); }\n' +
      '  })\n' +
      '  .linkColor(function() { return "#5a5a7a"; })\n' +
      '  .linkWidth(1.5)\n' +
      '  .linkDirectionalArrowLength(3.5)\n' +
      '  .linkDirectionalArrowRelPos(1)\n' +
      '  .linkCanvasObjectMode(function() { return "after"; })\n' +
      '  .linkCanvasObject(function(link, ctx, globalScale) {\n' +
      '    var label = link.via || "";\n' +
      '    if (!label) return;\n' +
      '    var start = link.source, end = link.target;\n' +
      '    if (typeof start !== "object" || typeof end !== "object") return;\n' +
      '    var midX = (start.x + end.x) / 2, midY = (start.y + end.y) / 2;\n' +
      '    var fontSize = 9 / globalScale;\n' +
      '    ctx.font = fontSize + "px -apple-system, sans-serif";\n' +
      '    ctx.textAlign = "center"; ctx.textBaseline = "middle";\n' +
      '    ctx.fillStyle = "#aaaaaa";\n' +
      '    ctx.fillText(label, midX, midY);\n' +
      '  })\n' +
      '  .onNodeClick(function(node) {\n' +
      '    window.parent.postMessage({ type: "keep-node-click", id: node.id }, "*");\n' +
      '  })\n' +
      '  .onNodeDragEnd(function(node) {\n' +
      '    node.fx = node.x; node.fy = node.y;\n' +
      '  });\n' +
      'if (layout === "td" || layout === "lr" || layout === "radialout") {\n' +
      '  graph.dagMode(layout);\n' +
      '  graph.dagLevelDistance(60);\n' +
      '}\n' +
      'graph.d3Force("charge").strength(-200);\n' +
      'graph.d3Force("collide", forceCollide(14));\n' +
      'graph.graphData(data);\n' +
      'var firstStop = true;\n' +
      'graph.onEngineStop(function() {\n' +
      '  if (firstStop) { firstStop = false; graph.zoomToFit(800, 30); }\n' +
      '});\n' +
      'window.addEventListener("resize", function() {\n' +
      '  graph.width(window.innerWidth).height(window.innerHeight);\n' +
      '});\n' +
      'window.parent.postMessage({ type: "keep-graph-ready" }, "*");\n' +
      '<\/script>\n</body></html>';
  }

  _destroyForceGraph() {
    if (this._iframeMessageHandler) {
      window.removeEventListener('message', this._iframeMessageHandler);
      this._iframeMessageHandler = null;
    }
  }

  // --- Utilities ---

  _escHtml(s) { return KeepViewer._esc(s); }

  static _esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Lightweight Markdown to HTML (supports headings, bold, italic, code blocks,
  // inline code, links, lists, tables, horizontal rules).
  static _renderMarkdown(src) {
    if (!src) return '';
    // Normalize Smalltalk encoding artifacts to Unicode
    src = src.replace(/\x92/g, '\u2192')   // → (right arrow)
             .replace(/\x14/g, '\u2014');   // — (em dash)
    var esc = KeepViewer._esc;
    var lines = src.split('\n');
    var html = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      // Fenced code block
      if (/^```/.test(line)) {
        var lang = line.slice(3).trim();
        var code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++; // skip closing ```
        if (lang === 'mermaid') {
          var mermaidId = 'mermaid-' + Math.random().toString(36).slice(2, 10);
          html.push('<div class="keep-mermaid" data-mermaid-id="' + mermaidId + '">' + esc(code.join('\n')) + '</div>');
        } else {
          html.push('<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px 10px;border-radius:4px;font-size:11px;line-height:1.4;overflow-x:auto;margin:6px 0;">' + code.map(esc).join('\n') + '</pre>');
        }
        continue;
      }
      // Table (line with |)
      if (/^\|/.test(line) && line.indexOf('|', 1) > 0) {
        var rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) {
          var cells = lines[i].split('|').slice(1, -1).map(function(c) { return c.trim(); });
          rows.push(cells);
          i++;
        }
        // Check if row[1] is a separator row
        var hasHeader = rows.length > 1 && rows[1].every(function(c) { return /^[-:]+$/.test(c); });
        var thtml = '<table style="border-collapse:collapse;font-size:11px;margin:6px 0;width:100%;">';
        for (var r = 0; r < rows.length; r++) {
          if (hasHeader && r === 1) continue; // skip separator
          var tag = (hasHeader && r === 0) ? 'th' : 'td';
          var style = tag === 'th'
            ? 'border:1px solid #ccc;padding:3px 6px;background:#eee;font-weight:600;text-align:left;'
            : 'border:1px solid #ddd;padding:3px 6px;';
          thtml += '<tr>' + rows[r].map(function(c) {
            return '<' + tag + ' style="' + style + '">' + KeepViewer._inlineMarkdown(esc(c)) + '</' + tag + '>';
          }).join('') + '</tr>';
        }
        thtml += '</table>';
        html.push(thtml);
        continue;
      }
      // Heading
      var hm = line.match(/^(#{1,6})\s+(.*)/);
      if (hm) {
        var level = hm[1].length;
        var sizes = { 1: '16px', 2: '14px', 3: '13px', 4: '12px', 5: '11px', 6: '11px' };
        html.push('<div style="font-weight:700;font-size:' + sizes[level] + ';margin:10px 0 4px;color:#1a237e;">' + KeepViewer._inlineMarkdown(esc(hm[2])) + '</div>');
        i++;
        continue;
      }
      // Horizontal rule
      if (/^(---|\*\*\*|___)\s*$/.test(line)) {
        html.push('<hr style="border:none;border-top:1px solid #ccc;margin:8px 0;">');
        i++;
        continue;
      }
      // Unordered list
      if (/^[-*]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(KeepViewer._inlineMarkdown(esc(lines[i].replace(/^[-*]\s+/, ''))));
          i++;
        }
        html.push('<ul style="margin:4px 0;padding-left:18px;font-size:11px;line-height:1.5;">' + items.map(function(it) { return '<li>' + it + '</li>'; }).join('') + '</ul>');
        continue;
      }
      // Empty line → paragraph break
      if (!line.trim()) {
        html.push('<div style="height:6px;"></div>');
        i++;
        continue;
      }
      // Normal paragraph
      html.push('<p style="margin:3px 0;font-size:11px;line-height:1.5;color:#222;">' + KeepViewer._inlineMarkdown(esc(line)) + '</p>');
      i++;
    }
    return html.join('');
  }

  // Inline markdown: bold, italic, inline code, links
  static _inlineMarkdown(s) {
    // inline code
    s = s.replace(/`([^`]+)`/g, '<code style="background:#e8e8ee;padding:1px 4px;border-radius:3px;font-size:10px;">$1</code>');
    // bold+italic
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
    // bold
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // italic
    s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
    // links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#1565c0;">$1</a>');
    return s;
  }

  // Load Mermaid library (once) and render all .keep-mermaid blocks in a container.
  static _renderMermaidBlocks(container) {
    var blocks = container.querySelectorAll('.keep-mermaid');
    if (!blocks.length) return;
    KeepViewer._ensureMermaid().then(function(mermaid) {
      blocks.forEach(function(el) {
        var src = el.textContent;
        var id = el.getAttribute('data-mermaid-id');
        mermaid.render(id, src).then(function(result) {
          el.innerHTML = result.svg;
          el.style.cssText = 'margin:8px 0;text-align:center;overflow-x:auto;';
        }).catch(function(err) {
          // Fall back to showing source as code
          el.innerHTML = '<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px 10px;border-radius:4px;font-size:11px;">' + KeepViewer._esc(src) + '</pre><div style="color:#e57373;font-size:10px;">Mermaid error: ' + KeepViewer._esc(err.message || String(err)) + '</div>';
        });
      });
    });
  }

  // Lazy-load Mermaid from CDN (cached promise)
  static _ensureMermaid() {
    if (KeepViewer._mermaidPromise) return KeepViewer._mermaidPromise;
    KeepViewer._mermaidPromise = new Promise(function(resolve, reject) {
      if (window.mermaid) {
        window.mermaid.initialize({ startOnLoad: false, theme: 'default' });
        return resolve(window.mermaid);
      }
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
      script.onload = function() {
        window.mermaid.initialize({ startOnLoad: false, theme: 'default' });
        resolve(window.mermaid);
      };
      script.onerror = function() { reject(new Error('Failed to load Mermaid library')); };
      document.head.appendChild(script);
    });
    return KeepViewer._mermaidPromise;
  }

  // Find a position for a new detail window that doesn't overlap existing ones.
  static _findNonOverlappingPosition(w, h, vw, vh) {
    var existing = [];
    document.querySelectorAll('morphic-window[data-keep-detail]').forEach(function(mw) {
      var r = mw.getBoundingClientRect();
      if (r.width > 0) existing.push(r);
    });

    var centerX = Math.round(vw / 2 - w / 2);
    var centerY = Math.round(vh / 2 - h / 2);

    if (existing.length === 0) return { x: centerX, y: centerY };

    // Place 50px southeast of the last detail window
    var last = existing[existing.length - 1];
    var x = Math.round(last.left) + 50;
    var y = Math.round(last.top) + 50;

    // Wrap if it would go off-screen
    if (x + w > vw - 10) x = 10;
    if (y + h > vh - 10) y = 10;

    return { x: x, y: y };
  }

  static get _STYLES() { return `
    :host {
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      color: #e0e0e0;
      background: #1e1e2e;
      border-radius: 6px;
      overflow: hidden;
      height: 100%;
    }
    .container {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: #2a2a3e;
      border-bottom: 1px solid #3a3a5a;
      flex-shrink: 0;
    }
    .tab {
      background: transparent;
      border: 1px solid #4a4a6a;
      color: #aaa;
      padding: 3px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .tab.active {
      background: #4a4a6a;
      color: #fff;
    }
    .tab:hover { background: #3a3a5a; color: #fff; }
    .filter {
      background: #1a1a2a;
      border: 1px solid #4a4a6a;
      color: #e0e0e0;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      flex: 1;
      max-width: 180px;
    }
    .filter:focus { outline: none; border-color: #6a6aaa; }
    .count {
      color: #888;
      font-size: 11px;
      margin-left: auto;
    }
    .refresh {
      background: transparent;
      border: 1px solid #4a4a6a;
      color: #aaa;
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .refresh:hover { background: #3a3a5a; color: #fff; }
    .home-btn {
      background: #1a1a2a;
      border: 1px solid #4a4a6a;
      color: #e0e0e0;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    .home-btn:hover { background: #2a2a4a; }
    .layout-select {
      background: #1a1a2a;
      border: 1px solid #4a4a6a;
      color: #e0e0e0;
      padding: 2px 4px;
      border-radius: 4px;
      font-size: 11px;
      position: relative;
      z-index: 10;
    }
    .content {
      flex: 1;
      overflow: auto;
      padding: 0;
      text-align: left;
    }
    /* Table */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    thead {
      position: sticky;
      top: 0;
      background: #2a2a3e;
      z-index: 1;
    }
    th {
      text-align: left;
      padding: 5px 8px;
      color: #aaa;
      border-bottom: 1px solid #3a3a5a;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    th:hover { color: #fff; }
    td {
      padding: 4px 8px;
      border-bottom: 1px solid #2a2a3e;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    tr:hover { background: #2a2a3e; cursor: pointer; }
    :host(.cmd-held) tr:hover,
    :host(.cmd-dragging) tr:hover { cursor: inherit; }
    :host(.cmd-held) *,
    :host(.cmd-dragging) * { cursor: inherit; }
    tr.detail-open { background: #1a2a2a; }
    .group-row { background: #252540; }
    .group-row .id { font-weight: 600; }
    .child-row { opacity: 0.9; }
    .group-badge { color: #ba68c8; font-size: 10px; }
    .id { color: #81c784; font-family: monospace; }
    .agent { color: #4fc3f7; }
    .topic { color: #ffb74d; }
    .type { color: #ba68c8; }
    .created { color: #90a4ae; font-size: 11px; }
    .summary { color: #ffffff; }
    .ver { color: #888; text-align: center; }
    /* Graph */
    .graph-layout {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }
    .graph-collapsed-bar {
      display: flex;
      align-items: center;
      padding: 3px 8px;
      gap: 6px;
      border-bottom: 1px solid #3a3a5a;
      flex-shrink: 0;
    }
    .graph-bar-text {
      font-size: 11px;
      font-weight: 600;
      color: #ccc;
      text-align: left;
    }
    .graph-panels {
      display: flex;
      flex-direction: row;
      flex: 1;
      min-height: 0;
      gap: 2px;
    }
    .graph-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      border-radius: 4px;
      overflow: hidden;
    }
    .graph-section-label {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 600;
      color: #ccc;
      background: rgba(0,0,0,0.3);
      border-bottom: 1px solid #3a3a5a;
      flex-shrink: 0;
    }
    .graph-label-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
    }
    .graph-collapse-btn {
      background: transparent;
      border: none;
      color: #aaa;
      cursor: pointer;
      font-size: 11px;
      padding: 0;
      width: 12px;
      text-align: center;
      flex-shrink: 0;
    }
    .graph-collapse-btn:hover {
      color: #fff;
    }
    .graph-frame {
      flex: 1;
      width: 100%;
      border: none;
      min-height: 0;
    }
  `; }
}

if (!customElements.get('keep-viewer')) {
  customElements.define('keep-viewer', KeepViewer);
}
