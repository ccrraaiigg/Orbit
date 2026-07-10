# Presentation slides panel "start" button

The Orbit panel (`orbit.status` webview in `website/src/extension-impl.js`)
has a **presentation slides** section with a **start** button, placed
just above the **Start Orbit** footer button. Mirrors the digital-twin
/ evaluations sections exactly.

Flow (extension → page, mirroring openDigitalTwin/openEvaluations):

1. Panel button posts `{type:'startPresentation'}` to the extension.
2. Handler calls `startPresentationOnPage()`, which POSTs a `tools/call`
   for the Caffeine MCP tool `openPresentation` over the bridge endpoint
   (same shape as openEvaluationsOnPage).
3. `SmalltalkMCPServer>>openPresentation` (image, instance-side, category
   `tools`) runs
   `JS window evaluate: 'window.parent.__orbitOpenPresentation && window.parent.__orbitOpenPresentation()'`.
4. `window.__orbitOpenPresentation()` (page helper,
   `website/public/js/orbit-open-presentation.js`, included in
   orbit.html) mounts (or raises) a `<morphic-window id="orbitTalk">`
   wrapping an `<iframe src="presentation/deck.html">` in the OUTER
   orbit.html document. Single-instance dedup via
   `document.getElementById('orbitTalk')`; collapse-restore like the twin.

Previously the deck window was hardwired into orbit.html (auto-created on
every page load). That inline `<script>` was removed; orbit.html now just
`<script src="js/orbit-open-presentation.js">` (defines the helper, does
NOT open the window). The deck appears only when the button is pressed.

## render() gating

The section (`#hr-presentation`, `#presentation-section-label`,
`#presentation-view-row`) is shown only when `state.orbitRunning`, like
the eval section.

## Image-side persistence (same caveat as digital twin)

`openPresentation` + its registration in `SmalltalkMCPServer class>>initializeTools`
are image-only. Made live via: compile the instance method
(`server compile: src classified: 'tools'`), then string-patch
`initializeTools` (insert an `aiToolNamed: #openPresentation …
forSelector: #openPresentation.` block before the openEvaluations block,
using `copyReplaceAll:`), then `SmalltalkMCPServer initializeTools`
(rebuilds the `tools` class-INSTANCE-var and fires
`notifyOfToolsListChange`). Lost on a fresh image load unless the user
snapshots. Confirmed 2026-07-07: after a user snapshot + window reload,
`openPresentation` survived (registered + method present) and invoking
`server registeredInstance openPresentation` mounted the deck window.

## Image gotchas hit
- The evaluate tool rejects ANY literal `^` in source (even inside a
  string) with "Non-local returns are not supported" — build a caret with
  `(Character value: 94)`.
- This image: `CompiledMethod` has no `#category`; get a method's category
  via `aClass organization categoryOfElement: #selector`.
- `tools` is a class-INSTANCE variable: read it with
  `server instVarNamed: 'tools'` (NOT `server class instVarNamed:` and NOT
  classPool).
- getSource here uses LF line endings + tab indentation.

## Livecoding note

`orbit-open-presentation.js` (like `orbit-open-digital-twin.js`) is NOT in
symlink-extension.js's symlink list — these on-demand openers ship via
VSIX packaging (vsce includes all of public/). A window reload that also
reloads the page picks up the new orbit.html + helper from the served
files automatically.
