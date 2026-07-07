# Orbit onboarding flow (agent-instigated)

Replaces the `@orbit` chat participant for serious use. Built 2026-06-27.
Offers to add Orbit's steering to the workspace's
`.github/copilot-instructions.md` so the *default* Copilot agent follows it.

## Instigation: the AGENT runs the tool (CORRECTED 2026-06-27)
The onboarding App is NOT auto-mounted on page connect. Instead:
- `Lam2300>>connect` issues Squeak's opening prompt via `orbitChat:` (fresh
  session). That prompt now ALSO tells the agent to **run the onboarding
  tool** (after the tab-share/read-page steps).
- ONBOARDED-GATE (2026-06-30): `connect` now gates that prompt on
  `self onboardingShouldShow`. That helper does a SYNCHRONOUS
  `XMLHttpRequest` GET `/onboarding/should-show` (via `JS evaluate:`,
  same-origin :8089, fail-open true) and returns the boolean. When
  `show=false` (the user already made a choice / `orbit.onboarding.suppressed`
  is set), the prompt instead tells the agent to **respond "Welcome to Orbit."
  and NOT invoke the onboarding tool** — so a reload after onboarding no
  longer drops a useless conversation card. When `show=true` the original
  "invoke the onboarding tool" prompt is used.
- The agent calls the `onboarding` MCP tool. From that ONE call the App
  appears on BOTH surfaces: the conversation surface renders automatically
  from the tool's `ui://orbit/onboarding` descriptor, and the instance
  handler mounts the on-page surface via `OrbitOnboarding instigate`
  (which honors the show-again gate, `mountIfAllowed`).
- Do NOT re-add any `[OrbitOnboarding instigate] fork` to `connect` — that
  was a wrong, page-auto-mount divergence and has been removed.

## JSObjectProxy call convention (CORRECTION — I had this backwards)
Caffeine `JSObjectProxy` (reaching JS objects from Squeak):
- **unary send `jsObj foo` CALLS the JS function `foo()`** (zero args). Verified:
  `reg shouldShow` returns a Promise (function invoked), not the function.
- keyword send `jsObj foo: a` → `foo(a)`; `foo: a with: b` → `foo(a, b)`
  (only the FIRST keyword names the JS method; later keywords ignored).
- **property GET (no call): `jsObj at: 'foo'`** — use this to get a function
  reference WITHOUT invoking it.
- Squeak `nil` → JS `null`.
So do NOT pass dummy `: nil` args to call a zero-arg JS function — just send it
unary.

## Pieces
1. **Component** `website/public/js/components/orbit-onboarding.js` —
   `<orbit-onboarding>` (loaded in orbit.html). Renders the App HTML inside a
   `<morphic-window caption="Welcome to Orbit">` + iframe `srcdoc`; acts as the
   App's MCP host (`ui/initialize`, size-changed, `tools/call`). The constant
   `ONBOARDING_APP_HTML` is the SINGLE SOURCE OF TRUTH for the markup, exposed
   as `window.__orbitOnboarding.appHtml`. Registry `window.__orbitOnboarding`:
   `mount(host,appHtml)`, `mountIfAllowed(host)` (gates on `shouldShow()`),
   `applyChoice(choice)` (POST `/onboarding/apply-steering`),
   `shouldShow()` (GET `/onboarding/should-show`, fail-open), `find`, `unmount`,
   `routeViaExtension` (default true). The component POSTs each choice to the
   extension itself; the image can opt out by setting `routeViaExtension=false`.
2. **Extension** `website/src/extension-impl.js` (NEEDS REBUILD to go live):
   - `orbit.applyOnboardingSteering` command — idempotent marker-delimited merge
     (`<!-- ORBIT:STEERING:BEGIN/END -->`) of bundled `agents/orbit.agent.md`
     into the workspace `.github/copilot-instructions.md` (create/append/update/
     unchanged). The App never edits files; this is the deterministic write.
   - Routes on `app.extensionRoutes` (same-origin :8089): `POST /onboarding/
     apply-steering` (`augment`→run command + clear suppress; `never`→workspaceState
     suppress; `later`→noted) and `GET /onboarding/should-show` (also fires
     `orbit.revealPanel` best-effort when show=true, so the panel is revealed
     at the moment the page decides to mount the onboarding App).
   - `orbit.revealPanel` (+ called in `orbit.start`) → `orbit.status.focus`.
3. **Caffeine driver** class `OrbitOnboarding` (category 'Orbit'):
   `registry` (`(Webpage current instVarNamed: 'window') parent at:
   '__orbitOnboarding'`), `instigate` (→ `reg mountIfAllowed`), `mount`/`unmount`.
   NOT hooked into `connect` anymore; called by the `onboarding` tool handler.
4. **Caffeine in-conversation MCP App** on `SmalltalkMCPServer`:
   - class-side `onboardingToolMeta` (`_meta.ui.resourceUri = ui://orbit/onboarding`,
     both nested + flat forms), `onboardingAppHTML` (fetches `OrbitOnboarding
     registry appHtml` — same single source of truth, with a fallback notice).
   - `resourcesRead:` ui:// branch now dispatches by uri (onboarding vs progress);
     `resourcesList` lists the onboarding resource.
   - `initializeTools` registers tools `onboarding` (selector `#onboarding`,
     attaches `onboardingToolMeta`) and `orbitOnboardingChoice` (selector
     `#orbitOnboardingChoice:`). Instance handlers: `onboarding` → mounts the
     on-page App (`OrbitOnboarding instigate`) AND returns `{status:shown,
     page}` (the conversation App renders from the tool descriptor);
     `orbitOnboardingChoice: choice` → routes via `OrbitOnboarding registry
     applyChoice:` (same extension route) → `{ok,choice,routed}`.
   - Tool registration is CLASS-side (`initializeTools`/`resourcesRead:`/etc.);
     tool HANDLER methods are INSTANCE-side (registered on
     `[self registeredInstance]`). Re-run `SmalltalkMCPServer initializeTools`
     after edits (it rebuilds `tools` + `notifyOfToolsListChange`).

## Routing (both surfaces funnel through one extension route)
- On-page App: component `_handleMessage` `tools/call` → `applyChoice` → POST.
- In-conversation App: button → VS Code MCP host → image `orbitOnboardingChoice`
  tool → handler → `registry applyChoice` → POST.

## "Don't ask again" persistence (where the choice is stored)
- The `never` choice POSTs `/onboarding/apply-steering` → extension sets
  `context.workspaceState['orbit.onboarding.suppressed'] = true` (VS Code
  workspace-scoped storage, survives reloads). `augment` clears it; `later`
  is a no-op note.
- On a later page load the on-page App's `mountIfAllowed` → `shouldShow()` →
  GET `/onboarding/should-show` reads that key, so the PAGE window is gated
  (won't mount when suppressed). The IN-CONVERSATION card is NOT gated: it
  renders from the `onboarding` tool descriptor whenever the agent runs the
  tool, regardless of suppression. So "no page App but a conversation card on
  reload" is expected after choosing "don't ask again".

## Close-on-choice (2026-06-30)
- A choice on EITHER surface now closes the on-page window:
  - page choice → component `_handleMessage` `tools/call` calls `this.teardown()`
    after routing (replaced earlier buggy `this._window.getElementById(
    'close-button')…` which threw — morphic-window has no `getElementById`).
  - conversation choice → image `orbitOnboardingChoice:` handler now also calls
    `reg unmount` after `reg applyChoice:`, dismissing the page surface.

## App layout / theme (2026-06-27)
- The App uses the SAME theme tokens as the progress App (the other MCP App):
  `background: transparent`, `color: var(--vscode-foreground, #cccccc)`, the
  `-apple-system,...` font stack, and `--vscode-button-{background,foreground,
  hoverBackground,secondary*}` for buttons. On the page (no `--vscode-*` vars)
  the fallbacks apply, matching the progress App's look inside a dark
  morphic-window.
- The three choice buttons are forced onto ONE row: `.actions { flex-wrap:
  nowrap }`, buttons `white-space: nowrap; flex: 0 0 auto`.
- morphic-window is CONTENT-DRIVEN: a `width:100%` iframe has no intrinsic
  width, so the window collapses to the titlebar's min width unless you set
  `mw.style.width` (we use 560px). Also DON'T open it at the mouse point near
  the right edge — `_clampIntoViewport` SHRINKS width (not just moves) to fit,
  re-collapsing it. The onboarding window is therefore CENTERED near the top
  (`left=(vw-560)/2`, `top=0.12*vh`), not mouse-positioned like the task mirror.
- LIVE-SYNC GOTCHA: re-running the component IIFE does NOT redefine the
  already-registered custom element (guarded by `customElements.get(TAG)`), so
  changes to `_build`/constructor do NOT reach the live page that way — only the
  unconditional `api.appHtml` / `api.mount` reassignments do. To apply `_build`
  changes live without a reload, patch `customElements.get('orbit-onboarding').
  prototype._build` directly, then unmount+remount. `api.mount` now falls back
  to `api.appHtml` so driver mounts (mount() with no args) pick up live markup.

## Pending
- Extension REBUILD (routes + write command + panel reveal are in `website/src/`).
  Until then `applyChoice`/`shouldShow` 404 → fail-soft (null / fail-open true).
- Image changes (OrbitOnboarding class, MCP tool/resource/handlers, patched
  `Lam2300>>connect`) are LIVE in the running image; persist into the VSIX at the
  next rebuild's Caffeine snapshot. `connect` re-runs on next page load.
- Wording review of the App copy + tool descriptions: deferred (do LAST).
- Orchestration: whether the startup `orbitChat` prompt should also surface the
  in-conversation `onboarding` tool (the on-page surface already auto-instigates
  on connect).
