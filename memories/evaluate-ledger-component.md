# evaluate-ledger web component

In-webapp table view of the evaluate-undo ledger. This is now the **only**
undo UI: the earlier per-line editor CodeLens was retired in 1.198.0
(removed `evalCodeLensProvider`, `orbit.undoEvaluate`, `undoEvaluateCommand`,
`shortTime`, `evalLensChanged`; `setupEvalUndoCodeLens` → `setupEvalMarkers`,
which now only registers `orbit.appendEvaluateMarker` + ensures the file).
Undo is driven entirely by the eval bridge → `performEvaluateUndo`.

## Pieces

- **Component:** `website/public/js/components/evaluate-ledger.js`
  (`<evaluate-ledger>`, shadow DOM, keep-viewer dark theme). Columns:
  time / backend / source / action. Active rows show a `↩ Undo` button;
  undone rows show `✓ undone HH:MM:SS` and dim. Toolbar: filter, count
  (`N active / M total`), ↻ refresh. Auto-polls every 3s. Sortable
  time/backend headers.
  - Opener: `window.OrbitEvaluateLedger.open()` — singleton
    `<morphic-window caption="Evaluate ledger" data-evaluate-ledger="1">`.
  - Wired into `website/public/orbit.html` after `orbit-task-mirror.js`.
  - Table uses `table-layout:fixed` with column widths (time 150 /
    backend 72 / action 96, source flexes+ellipsis) so the Undo button
    stays visible. Widths target both `td.<class>` and `th/td:nth-child`.

- **Page → extension data path (proxied):**
  - `app-impl.js`: `GET /evaluate-ledger` → bridge `GET /eval/markers`;
    `POST /evaluate-ledger/undo {id}` → bridge `POST /eval/undo`. Both
    gated by `allowBridgeAccess`. Component sends `Authorization: Bearer
    window.__ORBIT_BRIDGE_BEARER__`.
  - `extension-impl.js`: `startEvalBridge()`/`stopEvalBridge()` loopback
    HTTP server (port in `os.tmpdir()/orbit-eval.port`). `GET
    /eval/markers` → `listEvaluateMarkers()`; `POST /eval/undo` →
    `performEvaluateUndo(id)` (200 ok / 409 alreadyUndone / 404 not-found).

- **Undo core:** `performEvaluateUndo(id)` signals the tether
  (`signalEvaluateUndo` → SqueakJS `Lam2300 class>>undo:`, placeholder
  `3 halt`) AND stamps `undoneAt` on disk via `persistMarker`
  (buffer-authoritative WorkspaceEdit when the logfile is open, else fs).

## Livecoding note

`website/public/` is served live by `express.static` from SOURCE, so
component JS changes are picked up on next page load WITHOUT a rebuild.
To update an already-open instance without reload: patch the live class
(`customElements.get('evaluate-ledger')`) — e.g. override the static
`_STYLES` getter via `Object.defineProperty` and call `el._render()`.
Custom elements can't be re-`define`d, so monkey-patch the loaded class
rather than re-evaluating the file. Changes to `extension-impl.js` /
`app-impl.js` need a window reload (rebuild via build-extension.js).

## Demo verified (1.197.0)

Append marker via `orbit.appendEvaluateMarker` → row appears →
click in-page `↩ Undo` → row flips to `✓ undone`, count decrements,
and `.orbit/toolLogs/evaluate-markers.jsonl` gets the `undoneAt` stamp.
