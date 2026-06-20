# On-page MCP App mirror (task progress) over the Snowglobe tether

The VS Code "task progress" MCP App (`ui://orbit/progress`) is mirrored on the
Orbit page, fed over the Snowglobe **tether** instead of the VS Code JSON-RPC
MCP host. Built + validated end-to-end 2026-06-18.

## Inner vs outer document (CRITICAL)
- `mcp_caffeine_evaluate` runs in the INNER SqueakJS image (inside the
  `#embeddedSqueak iframe`). `Webpage current document` = that inner iframe doc
  (body is just `CANVAS#squeak`; NO morphic-window elements).
- The OUTER orbit.html document (the `<morphic-window>` elements, `#dashboard`,
  `#embeddedSqueak`) is reached from inner Squeak via
  `(Webpage current instVarNamed: 'window') parent document` (same-origin
  localhost:8089, so cross-frame DOM access works).
- Squeak↔JS bridge conventions (Caffeine `JSObjectProxy`):
  - property GET: `jsObj at: 'propName'`
  - method call, 1 arg: `jsObj method: a`
  - method call, N args: `jsObj method: a with: b with: c` → `method(a,b,c)`
    (only the FIRST keyword is the JS method name; later keywords are ignored).
  - Squeak `nil` → JS `null`.

## Page component
`website/public/js/components/orbit-task-mirror.js` — `<orbit-task-mirror taskid>`
(loaded in `website/public/orbit.html`, served live from disk — a fetch of a
new file under website/public returns 200 without a rebuild). It:
- builds a `<morphic-window caption="Task progress — <taskid>">` (useCutout=false)
  wrapping `<center>`+`<iframe srcdoc=progressHTML>` (model: lam2300-vr `_build`).
- acts as the App's MCP HOST: a window 'message' listener filtered to its
  iframe's contentWindow answers the App's JSON-RPC:
  `ui/initialize`→`{}`, `ui/notifications/size-changed`→resize iframe,
  `tools/call`→`{content:[{type:"text",text:<statusJSON>}]}` (matches the App's
  `parseStatus`). Reply via `iframe.contentWindow.postMessage({jsonrpc,id,result})`.
- `setStatus(json)` stores the latest status. Once it has been alive and then
  sees `status:"unknown"` (task gone from the remote registry) it returns
  `'done'` and KEEPS the last live status displayed — it does NOT auto-close.
  The window persists until the USER closes it (morphic close button →
  `teardown()` → `orbit-mirror-closed`). The Squeak poller stops on
  `'done'`/`'tornDown'`/`'noMirror'`.
- `window.__orbitTaskMirror` registry: `mount(taskId, html, host)`, `find`,
  `setStatus(taskId,json)`, `unmount(taskId)`.

## Squeak driver (Caffeine class `OrbitTaskMirror`, category 'Orbit')
Class-side, agent-callable:
- `mountForTaskId: taskId` — fetch App HTML over the tether (`progressAppHTML` →
  `(tether classNamed: 'LamMCPProgressResource') progressHTML`), mount via the
  registry, fork a low-priority poller.
- `unmountForTaskId: taskId` — terminate poller + `registry unmount:`.
- `pollLoopFor:reg:` — every 1.2s: `tether taskStatusJSON: taskId` →
  `reg setStatus: taskId with: json`; stop on `'done'`/`'tornDown'`/`'noMirror'`
  or error; removes itself from `pollers` (taskId→Process map). On `'done'`
  (task left registry) the window stays for the user to close.
- helpers: `tether`, `registry`, `progressAppHTML`, `pollers`.

## VW side (remote, package Snowglobe)
- `LamMCPEvaluateTool class>>statusJSONForTaskId:` — PASSIVE plain-JSON read
  (uses `JSONEncoder`, NOT the MOSS-typed `JSON` class). Never marks observation.
- `Tether>>taskStatusJSON: taskId` — single-round-trip delegate to it. A missing
  task answers `{"taskId":...,"finished":true,"status":"unknown"}`.
- Dual-observer removal: task removed only after BOTH the VS Code card
  (`createTaskProgressApp`→`#cardObserved`) and the agent
  (`getTaskStatus`→`#agentObserved`) observe finished/failed.

## Agent usage (mirroring a conversation card)
When you start a long evaluate and create the VS Code card with
`createTaskProgressApp`, ALSO mount the on-page mirror:
`OrbitTaskMirror mountForTaskId: 'task-N'` via `mcp_caffeine_evaluate`.
The mirror feeds itself over the tether; once both observers complete and the
task leaves the registry, the mirror stops polling but STAYS on the page
showing the final result — the user closes the window when ready.

## E2E proof (task-91, 6*7 after 14s delay)
running → "Evaluation complete. Evaluating that code yielded 42." → after both
observers, remote status went `unknown`, mirror torn down, poller self-terminated.
