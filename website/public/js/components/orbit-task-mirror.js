/*
 * <orbit-task-mirror taskid="task-N">
 *
 * An on-page mirror of the VS Code "task progress" MCP App. It embeds
 * the *same* App HTML (served by VisualWorks'
 * Snowglobe.LamMCPProgressResource>>progressHTML) inside a
 * <morphic-window>, and acts as the App's MCP host: it answers the
 * App iframe's JSON-RPC postMessages from a status string that is
 * pushed in from the outside.
 *
 * Unlike the VS Code card (which speaks JSON-RPC to the VS Code MCP
 * host), this mirror is fed over the Snowglobe *tether*: the inner
 * SqueakJS image polls the remote VisualWorks image
 * (LamMCPEvaluateTool statusJSONForTaskId:) and pushes each status
 * JSON string into this element via setStatus(). The read is PASSIVE
 * — it never marks #cardObserved, so it does not affect the remote
 * dual-observer task lifecycle (that's the VS Code card's job).
 *
 * API (driven from Squeak):
 *   el.progressHtml = "<...App HTML...>";  // build the iframe
 *   el.setStatus(jsonString);              // push latest status
 *   el.teardown();                         // remove the window
 *
 * User cancellation: when the embedded card's Cancel button sends a
 * tools/call for "cancelEvaluation", the host records the request and
 * setStatus() returns 'cancel' exactly once, telling the Squeak poller
 * to perform the actual cancellation (it owns the image/tether access).
 *
 * Events dispatched (bubbling, composed):
 *   orbit-mirror-closed { taskId }  — the user closed the window. The
 *                                     mirror does NOT auto-close when the
 *                                     task leaves the registry; it stops
 *                                     polling and waits for the user.
 */
(function () {
  'use strict';

  var TAG = 'orbit-task-mirror';

  // The placeholder status answered to the App before Squeak has
  // pushed a real one. Keeps the App in its "running" state so it
  // keeps polling us.
  var RUNNING_PLACEHOLDER = JSON.stringify({
    finished: false,
    failed: false,
    status: 'running',
    message: 'Waiting for the first status from the tether…'
  });

  function clampHeight(h) {
    h = Number(h) || 0;
    if (h < 60) return 60;
    if (h > 2000) return 2000;
    return h;
  }

  var OrbitTaskMirror = class extends HTMLElement {
    constructor() {
      super();
      this._window = null;       // the <morphic-window>
      this._iframe = null;       // the App iframe
      this._progressHtml = null; // srcdoc for the iframe
      this._statusJSON = RUNNING_PLACEHOLDER;
      this._wasAlive = false;    // saw a non-unknown status at least once
      this._tornDown = false;
      this._cancelRequested = false; // the user clicked the card's Cancel button
      this._cancelDelivered = false; // 'cancel' already returned to the poller
      this._onMessage = this._handleMessage.bind(this);
    }

    static get observedAttributes() { return ['taskid']; }

    get taskId() { return this.getAttribute('taskid') || ''; }
    set taskId(v) { this.setAttribute('taskid', v == null ? '' : String(v)); }

    get progressHtml() { return this._progressHtml; }
    set progressHtml(html) {
      this._progressHtml = html == null ? null : String(html);
      if (this.isConnected && this._progressHtml && !this._window) {
        this._build();
      } else if (this._iframe && this._progressHtml) {
        this._iframe.srcdoc = this._progressHtml;
      }
    }

    connectedCallback() {
      window.addEventListener('message', this._onMessage);
      if (this._progressHtml && !this._window) this._build();
    }

    disconnectedCallback() {
      window.removeEventListener('message', this._onMessage);
    }

    // ---- public, called from Squeak over the bridge ----

    // Push the latest status JSON (a String). Returns one of:
    //   'ok'       keep polling
    //   'cancel'   the user asked to cancel the task; the poller should
    //              perform the cancellation, then keep polling
    //   'done'     task left the registry; stop polling but KEEP the
    //              window — the user closes it when ready
    //   'tornDown' the user already closed the window
    setStatus(json) {
      if (this._tornDown) return 'tornDown';

      var incoming = json == null ? this._statusJSON : String(json);
      var status = null;
      try { status = JSON.parse(incoming); } catch (_) { status = null; }
      var s = status && (status.status || (status.finished ? 'finished' : 'running'));

      // The task has left the remote registry (both observers saw it,
      // so the conversation card is gone). Do NOT tear down — leave the
      // window for the user to close, and stop polling. Normally we keep
      // displaying the last live status (typically "Evaluation complete").
      // But if the only live status we ever observed was "running" (e.g. a
      // CPU-bound eval starved this poller so it never saw a clean terminal
      // status before the dual-observer lifecycle forgot the task), replace
      // the stale "running" with a synthesized completed status so the card
      // renders "Evaluation complete." rather than a stuck spinner.
      if (this._wasAlive && s === 'unknown') {
        var last = null;
        try { last = JSON.parse(this._statusJSON); } catch (_) { last = null; }
        var lastS = last && (last.status || (last.finished ? 'finished' : 'running'));
        if (!last || lastS == null || lastS === 'running') {
          // A cancel-requested task that vanished was cancelled, not completed.
          this._statusJSON = JSON.stringify(this._cancelRequested
            ? { taskId: this.taskId, status: 'cancelled', finished: true, result: '' }
            : { taskId: this.taskId, status: 'finished', finished: true, result: '' });
        }
        return 'done';
      }

      this._statusJSON = incoming;
      if (s && s !== 'unknown') this._wasAlive = true;
      if (this._cancelRequested && !this._cancelDelivered) {
        this._cancelDelivered = true;
        return 'cancel';
      }
      return 'ok';
    }

    teardown() {
      if (this._tornDown) return;
      this._tornDown = true;
      window.removeEventListener('message', this._onMessage);
      var taskId = this.taskId;
      try { if (this._window && this._window.parentNode) this._window.remove(); } catch (_) {}
      try { if (this.parentNode) this.remove(); } catch (_) {}
      this.dispatchEvent(new CustomEvent('orbit-mirror-closed', {
        detail: { taskId: taskId }, bubbles: true, composed: true
      }));
    }

    // ---- internals ----

    _build() {
      if (this._window || !this._progressHtml) return;

      var mw = document.createElement('morphic-window');
      var caption = 'Task progress — ' + (this.taskId || '?');
      mw.setAttribute('caption', caption);
      // HTML/iframe content that reflows on resize — no cutout.
      mw.useCutout = false;

      // Open with the window origin (top-left) near the current mouse
      // point. __pageMouse tracks the outer page's pointer (clientX/Y).
      // Cap the origin so the window's declared content box (the iframe's
      // 420x240) still fits within the viewport: otherwise a mouse near the
      // right/bottom edge would pin the top-left corner there with no room,
      // and since _clampToViewport measures the window on connect (before
      // the iframe's srcdoc has laid out) it would lock in that crushed
      // width instead of re-expanding once the content arrives.
      var mp = (typeof window.__pageMouse === 'function') ? window.__pageMouse() : null;
      if (mp && (mp.x || mp.y)) {
        var EXPECTED_W = 420, EXPECTED_H = 240;
        var maxLeft = Math.max(0, window.innerWidth - EXPECTED_W);
        var maxTop = Math.max(0, window.innerHeight - EXPECTED_H);
        var left = Math.min(Math.max(0, Math.round(mp.x)), maxLeft);
        var top = Math.min(Math.max(0, Math.round(mp.y)), maxTop);
        mw.style.left = left + 'px';
        mw.style.top = top + 'px';
      }

      var center = document.createElement('center');
      center.style.cssText = 'width:100%;height:100%;margin:0;';

      var iframe = document.createElement('iframe');
      iframe.setAttribute('marginheight', '0');
      iframe.setAttribute('marginwidth', '0');
      iframe.setAttribute('frameborder', '0');
      iframe.setAttribute('scrolling', 'auto');
      iframe.setAttribute('width', '420');
      iframe.setAttribute('height', '240');
      iframe.style.cssText =
        'overflow:hidden;border:0;display:block;width:100%;height:100%;';
      iframe.srcdoc = this._progressHtml;

      center.appendChild(iframe);
      mw.appendChild(center);
      this.appendChild(mw);

      this._window = mw;
      this._iframe = iframe;

      var self = this;
      mw.addEventListener('morphic-close', function () { self.teardown(); });
    }

    _handleMessage(event) {
      var iframe = this._iframe;
      if (!iframe || event.source !== iframe.contentWindow) return;

      var msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      var method = msg.method;
      var id = msg.id;

      var reply = function (result) {
        if (id == null) return; // notification, no reply expected
        try {
          iframe.contentWindow.postMessage(
            { jsonrpc: '2.0', id: id, result: result }, '*');
        } catch (_) {}
      };

      switch (method) {
        case 'ui/initialize':
          reply({});
          break;
        case 'ui/notifications/size-changed': {
          var h = msg.params && msg.params.height;
          if (h != null && this._iframe) {
            this._iframe.style.height = clampHeight(h) + 'px';
            this._iframe.setAttribute('height', String(clampHeight(h)));
          }
          reply({});
          break;
        }
        case 'tools/call': {
          var toolName = msg.params && msg.params.name;
          if (toolName === 'cancelEvaluation') {
            // The card's Cancel button. Flag the request; the Squeak
            // poller sees setStatus() answer 'cancel' and performs the
            // actual cancellation.
            this._cancelRequested = true;
            reply({ content: [{ type: 'text', text: JSON.stringify(
              { taskId: this.taskId, outcome: 'requested' }) }] });
            break;
          }
          // The App polls createTaskProgressApp; answer with our
          // tether-fed status, shaped like an MCP tool result.
          reply({ content: [{ type: 'text', text: this._statusJSON }] });
          break;
        }
        default:
          reply({});
      }
    }
  };

  if (!customElements.get(TAG)) {
    customElements.define(TAG, OrbitTaskMirror);
  }

  // Expose a tiny registry so the Squeak bridge can find/mount mirrors
  // by taskId without holding raw element handles across GC.
  var api = window.__orbitTaskMirror || (window.__orbitTaskMirror = {});
  api.tag = TAG;
  api.find = function (taskId) {
    var els = document.querySelectorAll(TAG);
    for (var i = 0; i < els.length; i++) {
      if (els[i].taskId === String(taskId)) return els[i];
    }
    return null;
  };
  api.mount = function (taskId, progressHtml, host) {
    var existing = api.find(taskId);
    if (existing) return existing;
    var el = document.createElement(TAG);
    el.taskId = taskId;
    (host || document.body).appendChild(el);
    el.progressHtml = progressHtml; // triggers _build
    return el;
  };
  api.setStatus = function (taskId, json) {
    var el = api.find(taskId);
    return el ? el.setStatus(json) : 'noMirror';
  };
  api.unmount = function (taskId) {
    var el = api.find(taskId);
    if (el) { el.teardown(); return 'ok'; }
    return 'noMirror';
  };
})();
