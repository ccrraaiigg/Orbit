/*
 * <orbit-onboarding>
 *
 * The on-page presentation of Orbit's onboarding MCP App. It embeds the
 * onboarding App HTML (the same markup the image serves for the
 * in-conversation App at ui://orbit/onboarding) inside a
 * <morphic-window>, and acts as the App's MCP host: it answers the App
 * iframe's JSON-RPC postMessages (ui/initialize, size-changed) and turns
 * the user's choice — sent by the App as a `tools/call` — into a
 * bubbling `orbit-onboarding-choice` event for the rest of the flow.
 *
 * Modelled on <orbit-task-mirror>. Unlike that mirror (which is fed a
 * status string over the Snowglobe tether), this App is interactive: the
 * three onboarding choices travel guest -> host as a single `tools/call`.
 *
 * The component is the *presentation and consent surface* only. It does
 * NOT write any steering itself; it merely reports the choice. The
 * deterministic write (for the "augment" choice) is performed by the
 * Orbit extension, downstream of this event — so the same write path is
 * used whether the choice came from this on-page App or from the
 * in-conversation App / chat fallback.
 *
 * API:
 *   el.appHtml = "<...App HTML...>";   // override the default markup
 *   el.teardown();                      // remove the window
 *
 * Events dispatched (bubbling, composed):
 *   orbit-onboarding-choice { choice }  — one of 'augment' | 'later' | 'never'
 *   orbit-onboarding-closed { }         — the user closed the window
 */
(function () {
  'use strict';

  var TAG = 'orbit-onboarding';

  // The canonical onboarding App markup. This is a complete standalone
  // document so it can be used both as an iframe `srcdoc` here and as the
  // `ui://orbit/onboarding` resource the image serves to the
  // in-conversation MCP App. Keep the two in sync; this string is the
  // single source of truth and is exposed on window.__orbitOnboarding.
  var ONBOARDING_APP_HTML = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>',
    '  :root { color-scheme: light dark; }',
    '  * { box-sizing: border-box; }',
    '  body {',
    '    margin: 0; padding: 14px 18px;',
    '    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;',
    '    font-size: 13px; line-height: 1.5;',
    '    background: transparent;',
    '    color: var(--vscode-foreground, #cccccc);',
    '  }',
    '  .card { padding: 0; }',
    '  h1 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }',
    '  p { margin: 0 0 10px; }',
    '  ul { margin: 0 0 12px; padding-left: 18px; }',
    '  li { margin: 2px 0; }',
    '  code {',
    '    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.18));',
    '    border-radius: 3px; padding: 0 4px; font-size: 12px;',
    '    font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);',
    '  }',
    '  .actions { display: flex; flex-wrap: nowrap; gap: 8px; margin-top: 14px; }',
    '  button {',
    '    font: inherit; padding: 6px 12px; border-radius: 4px; cursor: pointer;',
    '    white-space: nowrap; flex: 0 0 auto;',
    '    border: 1px solid var(--vscode-button-border, transparent);',
    '  }',
    '  button.primary {',
    '    background: var(--vscode-button-background, #0e639c);',
    '    color: var(--vscode-button-foreground, #ffffff);',
    '  }',
    '  button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }',
    '  button.secondary {',
    '    background: var(--vscode-button-secondaryBackground, transparent);',
    '    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground, #cccccc));',
    '    border-color: var(--vscode-button-border, rgba(127,127,127,0.4));',
    '  }',
    '  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.12)); }',
    '  .done { font-weight: 600; }',
    '  .muted { opacity: 0.75; font-size: 12px; }',
    '</style>',
    '</head>',
    '<body>',
    '  <div class="card" id="root">',
    '    <h1>Welcome to Orbit</h1>',
    '    <p>Orbit is running. Its controls live in the <strong>Orbit panel</strong>',
    '       in the Activity Bar (just opened for you):</p>',
    '    <ul>',
    '      <li><strong>Start / Stop Orbit</strong></li>',
    '      <li><strong>WebDAV mount</strong> &mdash; browse the Smalltalk image as files</li>',
    '      <li><strong>Keep sync</strong> &mdash; shared agentic memory</li>',
    '      <li><strong>Backends</strong> &mdash; enable the Smalltalk MCP servers</li>',
    '    </ul>',
    '    <p>Orbit works best when its steering is part of your workspace, so the',
    '       <strong>default Copilot agent</strong> follows it (with checkpoints, edit',
    '       review and approvals). Add Orbit&rsquo;s steering to',
    '       <code>.github/copilot-instructions.md</code> in this workspace now?</p>',
    '    <p class="muted">This merges with any steering you already have; you can',
    '       review and undo the change.</p>',
    '    <div class="actions">',
    '      <button class="primary" data-choice="augment">Add it now</button>',
    '      <button class="secondary" data-choice="later">Not now</button>',
    '      <button class="secondary" data-choice="never">Don&rsquo;t ask again</button>',
    '    </div>',
    '  </div>',
    '  <script>',
    '  (function () {',
    '    var seq = 1;',
    '    function send(method, params, wantsReply) {',
    '      var id = wantsReply ? (seq++) : undefined;',
    '      var msg = { jsonrpc: "2.0", method: method };',
    '      if (params !== undefined) msg.params = params;',
    '      if (id !== undefined) msg.id = id;',
    '      parent.postMessage(msg, "*");',
    '      return id;',
    '    }',
    '    function reportSize() {',
    '      var h = document.documentElement.scrollHeight;',
    '      send("ui/notifications/size-changed", { height: h }, false);',
    '    }',
    '    function render(html) {',
    '      document.getElementById("root").innerHTML = html;',
    '      reportSize();',
    '    }',
    '    var MESSAGES = {',
    '      augment: "<h1>Steering added</h1><p class=\\"done\\">Orbit&rsquo;s steering is now part of this workspace.</p><p>Continue with the <strong>default Copilot agent</strong> &mdash; it will follow it automatically. You can close this window.</p>",',
    '      later: "<h1>Maybe later</h1><p>No problem. You can add Orbit&rsquo;s steering at any time from the Orbit panel. You can close this window.</p>",',
    '      never: "<h1>Understood</h1><p>Orbit won&rsquo;t ask again in this workspace. You can still add its steering from the Orbit panel later. You can close this window.</p>"',
    '    };',
    '    function choose(choice) {',
    '      send("tools/call", { name: "orbitOnboardingChoice", arguments: { choice: choice } }, true);',
    '      render(MESSAGES[choice] || MESSAGES.later);',
    '    }',
    '    document.addEventListener("click", function (e) {',
    '      var b = e.target.closest("button[data-choice]");',
    '      if (b) choose(b.getAttribute("data-choice"));',
    '    });',
    '    window.addEventListener("load", function () {',
    '      send("ui/initialize", {}, true);',
    '      reportSize();',
    '    });',
    '    window.addEventListener("resize", reportSize);',
    '  })();',
    '  <\/script>',
    '</body>',
    '</html>'
  ].join('\n');

  function clampHeight(h) {
    h = Number(h) || 0;
    if (h < 80) return 80;
    if (h > 2000) return 2000;
    return h;
  }

  var OrbitOnboarding = class extends HTMLElement {
    constructor() {
      super();
      this._window = null;    // the <morphic-window>
      this._iframe = null;    // the App iframe
      this._appHtml = ONBOARDING_APP_HTML;
      this._choice = null;    // the choice the user made, if any
      this._tornDown = false;
      this._onMessage = this._handleMessage.bind(this);
    }

    get appHtml() { return this._appHtml; }
    set appHtml(html) {
      this._appHtml = html == null ? ONBOARDING_APP_HTML : String(html);
      if (this.isConnected && !this._window) {
        this._build();
      } else if (this._iframe) {
        this._iframe.srcdoc = this._appHtml;
      }
    }

    get choice() { return this._choice; }

    connectedCallback() {
      window.addEventListener('message', this._onMessage);
      if (!this._window) this._build();
    }

    disconnectedCallback() {
      window.removeEventListener('message', this._onMessage);
    }

    teardown() {
      if (this._tornDown) return;
      this._tornDown = true;
      window.removeEventListener('message', this._onMessage);
      try { if (this._window && this._window.parentNode) this._window.remove(); } catch (_) {}
      try { if (this.parentNode) this.remove(); } catch (_) {}
      this.dispatchEvent(new CustomEvent('orbit-onboarding-closed', {
        detail: {}, bubbles: true, composed: true
      }));
    }

    // ---- internals ----

    _build() {
      if (this._window) return;

      var mw = document.createElement('morphic-window');
      mw.setAttribute('caption', 'Welcome to Orbit');
      // HTML/iframe content that reflows on resize — no cutout.
      mw.useCutout = false;
      // Give the window an explicit intrinsic width: its slotted content
      // (a width:100% iframe) has no natural width, so without this the
      // window would collapse to the titlebar's min width. 560px keeps the
      // three onboarding buttons comfortably on one row.
      var winW = 560;
      mw.style.width = winW + 'px';

      // Onboarding is a one-time welcome dialog: center it near the top of
      // the viewport rather than dropping it at the mouse point, so it
      // never opens against the right edge (where the viewport clamp would
      // shrink its width and wrap the buttons).
      var vw = window.innerWidth || 1200;
      var vh = window.innerHeight || 800;
      mw.style.left = Math.max(8, Math.round((vw - winW) / 2)) + 'px';
      mw.style.top = Math.max(8, Math.round(vh * 0.12)) + 'px';

      var center = document.createElement('center');
      center.style.cssText = 'width:100%;height:100%;margin:0;';

      var iframe = document.createElement('iframe');
      iframe.setAttribute('marginheight', '0');
      iframe.setAttribute('marginwidth', '0');
      iframe.setAttribute('frameborder', '0');
      iframe.setAttribute('scrolling', 'auto');
      iframe.setAttribute('width', '540');
      iframe.setAttribute('height', '360');
      iframe.style.cssText =
        'overflow:hidden;border:0;display:block;width:100%;height:100%;';
      iframe.srcdoc = this._appHtml;

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
          // The App reports the user's choice as a single tools/call.
          var args = (msg.params && msg.params.arguments) || {};
          var choice = args.choice;
          var valid = (choice === 'augment' || choice === 'later' || choice === 'never');
          if (valid) {
            this._choice = choice;
            this.dispatchEvent(new CustomEvent('orbit-onboarding-choice', {
              detail: { choice: choice }, bubbles: true, composed: true
            }));
            // Route the choice to the extension for the deterministic
            // write/persistence, unless the image has opted to own
            // routing itself (api.routeViaExtension === false).
            var reg = window.__orbitOnboarding;
            if (reg && reg.routeViaExtension !== false &&
                typeof reg.applyChoice === 'function') {
              reg.applyChoice(choice);
            }
          }
          reply({ content: [{ type: 'text', text: 'ok' }] });
          // Once a choice has been made, dismiss the on-page onboarding
          // window. The App iframe also renders a brief confirmation, but
          // the page surface is closed immediately so it doesn't linger.
          if (valid) this.teardown();
          break;
        }
        default:
          reply({});
      }
    }
  };

  if (!customElements.get(TAG)) {
    customElements.define(TAG, OrbitOnboarding);
  }

  // Registry so the Squeak driver can mount/find the App without holding
  // raw element handles across GC. Mirrors window.__orbitTaskMirror.
  var api = window.__orbitOnboarding || (window.__orbitOnboarding = {});
  api.tag = TAG;
  api.appHtml = ONBOARDING_APP_HTML; // single source of truth for the markup

  // When true (default), the component POSTs each choice to the Orbit
  // extension's same-origin route so the steering write/persistence
  // happens deterministically in the extension. Set to false if the
  // image (Squeak driver) wants to own routing via its own channel.
  if (api.routeViaExtension === undefined) api.routeViaExtension = true;

  // POST a choice to the extension. Resolves with the parsed JSON result
  // ({ ok, action, path? } for 'augment'; { ok, action } otherwise), or
  // null on transport failure. Same-origin loopback POST on :8089.
  api.applyChoice = function (choice) {
    return fetch('/onboarding/apply-steering', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: choice })
    }).then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  };

  // Ask the extension whether onboarding should be shown in this
  // workspace (honours the remembered "don't ask again"). Resolves true
  // unless suppressed; resolves true on transport failure (fail-open).
  api.shouldShow = function () {
    return fetch('/onboarding/should-show')
      .then(function (r) { return r.ok ? r.json() : { show: true }; })
      .then(function (j) { return !!(j && j.show); })
      .catch(function () { return true; });
  };

  api.find = function () {
    return document.querySelector(TAG);
  };
  api.mount = function (host, appHtml) {
    var existing = api.find();
    if (existing) return existing;
    var el = document.createElement(TAG);
    // Fall back to the registry's appHtml (the single source of truth)
    // so a live-updated markup takes effect on driver-initiated mounts,
    // which call mount() with no explicit html.
    if (appHtml == null) appHtml = api.appHtml;
    if (appHtml != null) el.appHtml = appHtml;
    (host || document.body).appendChild(el);
    return el;
  };
  // Mount only if the extension says onboarding should be shown in this
  // workspace (honours the remembered "don't ask again"). This keeps the
  // async gate entirely in JS so the Squeak driver can fire-and-forget.
  // Resolves with the element if mounted, else null.
  api.mountIfAllowed = function (host, appHtml) {
    return api.shouldShow().then(function (show) {
      return show ? api.mount(host, appHtml) : null;
    });
  };
  api.unmount = function () {
    var el = api.find();
    if (el) el.teardown();
    return !!el;
  };
})();
