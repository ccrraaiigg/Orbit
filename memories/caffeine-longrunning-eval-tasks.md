# Caffeine long-running `evaluate` tasks (adapted from 2300-ui)

Built 2026-06-19. Caffeine's `evaluate` MCP tool no longer blocks indefinitely
on slow evals: it mirrors the VisualWorks 2300-ui async-task approach
(register task → return `running`+`taskId` → poll for result).

## Wire tools (Caffeine SqueakJS MCP server, `mcp_caffeine_*`)
- `evaluate` — on timeout (5s) answers `{status:'running', taskId, message}`
  instead of a value.
- `getTaskStatus` (`SmalltalkMCPServer>>getTaskStatus:`, optional `taskId`) —
  no-card poller; **delivers the result** and marks the `#agent` observer.
- `createTaskProgressApp` (`SmalltalkMCPServer>>createTaskProgressApp:`,
  optional `taskId`) — renders a progress card **in the conversation** (an MCP
  Apps card; see _meta below) AND mounts an on-page mirror window; returns the
  status and marks the `#card` observer when finished. Call once per long eval,
  then poll `getTaskStatus`.
After editing `SmalltalkMCPServer class>>initializeTools`, re-run
`SmalltalkMCPServer initializeTools` (rebuilds `tools` + notifies client).

## Registry: class `OrbitEvalTasks` (category 'Orbit')
Class vars `Tasks TaskMutex TaskSequence`. Parallels VW
`LamMCPEvaluateTool` task-tracking class side:
`registerTaskForSession:[startedAt:]`, `task:didFinishWith:`,
`task:didFailWith:`, `statusDictForTaskId:`, `statusJSONForTaskId:` (passive,
uses `aDict json`), `latestTaskIdForSession:`,
`noteCompletionObservedBy:ofTaskId:` (dual-observer), `forgetTaskId:`,
`resetTasks`. Status dict shape = VW's:
`{taskId,status,finished,startedAt,finishedAt,result}`.

## `SmalltalkMCPServer>>evaluate:given:` change
Forks the eval (as before) but now `waitTimeoutMSecs: 5000` instead of
unconditional `wait`. A `mutex`+`finished` flag closes the race between the
deadline and completion. On timeout-while-unfinished it registers the task and
returns the running status; the forked process records completion into
`OrbitEvalTasks` if a `taskId` was assigned.
**Squeak gotcha:** `Semaphore>>waitTimeoutMSecs:` returns **true = timed out**,
false = signalled (OPPOSITE of VW `waitWithTimeoutMs:`).

## Dual-observer lifecycle
Task removed only after BOTH observe completion: `#agent` (getTaskStatus) and
`#card` (the **conversation MCP Apps card**, which self-polls
`createTaskProgressApp`). `createTaskProgressApp:` marks `#card` when it reports
finished. The on-page mirror is now **passive** again (matches VW): its poller
(`pollLocalLoopFor:reg:`) displays status and stops on finished, but never
marks an observation or gates removal. Proof the conversation card works:
after a long eval completes and `getTaskStatus` runs, the task gets *removed*
from `OrbitEvalTasks tasks` — which can only happen if the card also observed
completion.

## Conversation App card via `_meta` (2026-06-19 — supersedes earlier note)
`_meta` IS now implemented for Caffeine, so VS Code renders an MCP Apps
progress card in the conversation (in addition to the on-page mirror).
Mechanism (mirrors VW `LamMCPCreateTaskProgressAppTool`):
- `FunctionAITool` gained a `metadata` ivar + `metadata:`/`metadata` accessors;
  `printJSONOn:` now appends `'_meta' -> metadata` to the descriptor when set.
- `SmalltalkMCPServer class>>progressToolMeta` returns
  `{#ui -> {#resourceUri -> 'ui://orbit/progress'}. 'ui/resourceUri' ->
  'ui://orbit/progress'}` (both nested + flat forms, as VW does).
  `initializeTools` sets it on the `createTaskProgressApp` tool only (so a card
  appears only for an in-progress eval, never fast evals).
- The `ui://orbit/progress` resource is served over the MCP channel:
  `resourcesList` advertises it (`mimeType text/html`); `resourcesRead:`
  returns `{#contents -> {{#uri. #mimeType 'text/html'. #text ->
  self progressAppHTML}}}`. `progressAppHTML` is the canonical MCP Apps card
  HTML (postMessage host protocol; self-polls `tools/call
  createTaskProgressApp`).
- **Bridge passes everything through unchanged.** `caffeine-bridge.js`
  `initialize` already advertises the `resources` capability; `tools/list`,
  `resources/list`, `resources/read` all forward to the page and return its
  JSON. So no extension changes were needed.
- **GOTCHA (caused "UI resource not found on server"):** the page dispatcher
  `Tether>>serviceExternalMessage:` passes the JSON-RPC **params object** (a
  `PseudoJSObject`, e.g. `{uri: ...}`) — NOT a bare string — as the argument to
  `resourcesRead:`/`toolsCall:`. `resourcesRead:` must coerce:
  `uri := arg isString ifTrue: [arg] ifFalse: [arg at: 'uri']`. (The old
  `file:///` reads had the same latent bug but were never exercised by VS Code.)

## On-page mirror = OrbitTaskMirror (secondary passive display)
The `<orbit-task-mirror>` page component still mounts (so progress shows on the
page too). `OrbitTaskMirror class` methods (category 'local tasks'):
`mountLocalForTaskId:`, `startLocalPollerFor:reg:`, `pollLocalLoopFor:reg:`
(passive), `localProgressHTML`. The poller reads Caffeine-local
`OrbitEvalTasks statusDictForTaskId:`; `localProgressHTML` talks only to the
mirror host (orbit-task-mirror.js), decoupled from the remote VW image.

## Class creation in this SqueakJS image
`Object subclass:instanceVariableNames:classVariableNames:package:` and
`...category:` (4-arg) both DNU. Use the **5-arg**
`subclass:instanceVariableNames:classVariableNames:poolDictionaries:category:`.

## Persistence
All of the above lives ONLY in the running SqueakJS image and is lost on page
reload unless snapshotted (snapshotting is a steering prohibition for the
agent — the user must do it).
