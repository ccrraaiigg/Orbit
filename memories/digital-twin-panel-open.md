# Digital twin panel "open" button

The Orbit panel (`orbit.status` webview in `website/src/extension-impl.js`)
has a **digital twin** section with an **open** button, mirroring the
**memory → view** button that opens the Keep viewer.

Flow (extension → page, mirroring `openKeepViewer`):

1. Panel button posts `{type:'openDigitalTwin'}` to the extension.
2. Handler calls `openDigitalTwinOnPage()`, which POSTs a `tools/call`
   for the Caffeine MCP tool `openDigitalTwin` over the bridge
   endpoint (same shape as `openKeepViewerOnStartup`).
3. `SmalltalkMCPServer>>openDigitalTwin` (image, category `tools`) runs
   `JS window evaluate: 'window.parent.__orbitOpenDigitalTwin && window.parent.__orbitOpenDigitalTwin()'`.
4. `window.__orbitOpenDigitalTwin()` (page helper,
   `website/public/js/orbit-open-digital-twin.js`, included in
   `orbit.html`) mounts a `<lam2300-vr caption="Lam 2300 — Digital Twin">`
   window in the **outer** document at 160,120 / 900×560, or raises the
   existing one (`mw._bringToFront()`). Idempotent — never duplicates.

## Single-instance / dedup

Dedup lives entirely in the page helper (so it holds no matter how the
helper is invoked — button, image tool, or direct call): `findTwin()`
is `document.querySelector('lam2300-vr')`. The icon-manager collapses
windows via `visibility:hidden` (it never removes them from the DOM), so
a collapsed twin is still found and never duplicated. `bringToFront()`
also clears `dataset.iconManagerPendingHidden` + restores
`visibility/opacity` and calls `icon-manager.refresh()`, so re-pressing
"open" on a collapsed twin surfaces the one window instead of doing
nothing. Verified: visible re-press, collapsed re-press, and repeated
presses all keep exactly one `<lam2300-vr>`.

## Image-side persistence

`openDigitalTwin` + its registration in
`SmalltalkMCPServer class>>initializeTools` are **image-only** changes,
made live in-session via `compileMethod` + a string-patch of
`initializeTools` (insert the tool block before the closing `}` of the
`tools := {...}` array, then `SmalltalkMCPServer initializeTools`, which
rebuilds `tools` and fires `notifyOfToolsListChange`). They are lost on a
fresh image load unless the user snapshots (steering forbids the agent
snapshotting). To re-add manually, re-run the same compile + patch.

## Sibling sections: evaluations + Keep viewer (same pattern)

The panel also has an **evaluations** section (open button →
`openEvaluations` image tool → page-side
`window.parent.OrbitEvaluateLedger.open()`) and the existing
**memory → view** Keep viewer button. All three follow the same
single-instance + collapse-restore behavior:

- **evaluations**: dedup/restore live in
  `website/public/js/components/evaluate-ledger.js` `open()` (durable,
  served). Its `existing` branch clears `iconManagerPendingHidden`,
  restores `visibility/opacity`, calls `_bringToFront()` (guarded by
  `existing.__allowRaise = true`), and `icon-manager.refresh()`. The
  `openEvaluations` image tool is the only image-side (non-durable) bit.
- **Keep viewer**: `SmalltalkMCPServer>>openKeepViewer` was changed from
  remove+recreate to **reuse+restore**: it computes `data` up front,
  and when a `morphic-window[data-keep-viewer]` already exists it
  restores it (clear flag, visibility/opacity, `_bringToFront` with
  `__allowRaise`, `icon-manager.refresh()`), `setData(data)` on the
  existing `keep-viewer`, sets `window.parent.__keepViewer`, and
  returns — never destroying/recreating (preserves position, avoids
  flicker). This `openKeepViewer` edit is an image change and reverts on
  reload unless snapshotted.

`evaluate-ledger.js` is loaded from the served file, so syncing the live
page after editing `open()` means re-defining `window.OrbitEvaluateLedger`
in the live DOM (it won't re-fetch without a reload).

## Gotchas

- The class-side tool registry is the variable `tools`, built only in
  `initializeTools`. Calling `aiToolNamed:...forSelector:` alone returns
  a `FunctionAITool` but does **not** register it — you must rebuild
  `tools`.
- This SqueakJS image's `String` has no `includesSubstring:`; use
  `indexOfSubCollection:` for substring tests in patch code.
- `compileMethod`'s `class` param needs the actual class object
  reference, not the role reference.
- The `mcp_caffeine_evaluate` tool does **not** support non-local
  returns (`^`); use `ifTrue:/ifFalse:` to branch a result instead of
  early-returning.
