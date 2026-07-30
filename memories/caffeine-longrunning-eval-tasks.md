# Caffeine long-running `evaluate` tasks (adapted from 2300-ui)

Built 2026-06-19. Caffeine's `evaluate` MCP tool no longer blocks indefinitely
on slow evals: it mirrors the VisualWorks 2300-ui async-task approach
(register task → return `running`+`taskId` → poll for result).

## Failure mode: Delay-based evals hang to 30s `ERROR: Canceled` (2026-06-23)
Symptom: any `mcp_caffeine_evaluate` whose code (or whose 5s task-timeout)
touches a `Delay` hangs ~30000ms then returns `ERROR: Canceled`, while
fast non-Delay evals work. The 30s ceiling is the **MCP proxy** upstream
timeout (`website/src/mcp-proxy.js`: `upReq.setTimeout(30000,...)`), NOT a user
cancel and NOT a Caffeine fault.
Why it defeats the long-running-task feature: the "return running at 5s" path is
`resultAvailable waitTimeoutMSecs: 5000` → `DelayWaitTimeout>>wait` →
`self schedule` (schedules a Delay). If Delay scheduling is stuck, that wait
never wakes, so no `running` status is ever sent.
Root cause seen: **accumulated stuck processes** wedged the delay scheduler.
Each 30s-cancelled eval LEAKS two processes into the image — the responder
(blocked in `DelayWaitTimeout>>wait`) and the forked eval — and prior hangs had
piled up several frozen in `Delay>>schedule` / `Semaphore>>critical:`.
Diagnose with a process dump: `Process allInstances do: [:p | p suspendedContext
ifNotNil: [... p priority, (p suspendedContext method printString)]]` — look for
clusters stuck in `Delay>>schedule`, `Delay>>wait`, `DelayWaitTimeout>>wait`,
`Semaphore>>critical:`. (`Process>>stateString` DNU here; use priority + top
method.)
FIX: terminate the leaked/stuck processes (the user did this from the SqueakJS
process browser) → the feature immediately works again. Key discriminator: if
`(Delay forSeconds: 1) wait` works **from the SqueakJS UI** but Delay-based MCP
evals hang, the timer itself is fine — suspect leaked processes, NOT a dead
scheduler. (`Delay class>>AccessProtect excessSignals` reading >1 is a red
herring for *hangs*: surplus signals make a mutex fail to block, not hang.)
Each failed probe eval also opens a Debugger/SyntaxError notifier in the image
(`evaluate:given:` runs `exception defaultAction`); those add `Debugger
class>>morphicOpenOn:` / `SyntaxError class>>morphicOpen:` processes — clean
them up too.

## Cancelling a detached long-running eval (2026-06-23; semantics changed 2026-07-30)
Added an image-side cancellation primitive so a forked eval that's been
abandoned (returned `running` but won't be polled to completion) can be
terminated instead of leaking its process.
- `evaluate:given:` now captures the forked eval process via
  `newProcess`/`resume` (was `fork`) and records it on the task at
  registration: `OrbitEvalTasks task: taskId setProcess: evalProcess`.
- `OrbitEvalTasks class>>cancelTaskId:` — marks a *running* task `cancelled`
  and (AFTER releasing `taskMutex`) `process terminate`s the captured process
  so its unwind blocks run. Returns `{taskId, status, outcome}` where outcome
  ∈ `cancelled` / `notCancellable` (already finished/failed) / `notFound`
  (nil or unknown). Idempotent.
  SEMANTICS CHANGE (2026-07-30): the cancelled task now REMAINS in the
  registry with status `'cancelled'` (finished=true, result
  `{error:'Evaluation cancelled by request.'}`) instead of being removed
  immediately, so BOTH pollers (progress card + getTaskStatus) observe the
  cancellation and the normal dual-observer lifecycle removes it. Verified
  end-to-end: card shows "Evaluation cancelled.", getTaskStatus returns
  status `cancelled`, task then leaves the registry.
- `SmalltalkMCPServer>>cancelEvaluation:` (in `#tools`) is the MCP tool
  wrapper. It MUST answer the status Dictionary DIRECTLY: `^OrbitEvalTasks
  cancelTaskId: taskId` — do NOT wrap it in `json`.
  BUG fixed 2026-07-28: it used to be `^(OrbitEvalTasks cancelTaskId: taskId)
  json`, which made the tool always fail with `{"error":"Character>>key"}`.
  Root cause: the tool-dispatch response layer `AIToolCall>>response` does
  `PseudoJSObject withAll: output` → `PseudoJSObject>>addAll:` →
  `output associationsDo: [:assoc | ... assoc key ...]`. Every other tool returns
  a Dictionary / an array of Associations (e.g. `{#result -> value}`,
  `statusDict`), so `associationsDo:` yields real associations. `cancelEvaluation:`
  was the lone tool returning a `json` STRING; iterating a String's elements
  (Characters) as associations sends `#key` to a Character → `Character>>key`
  DNU. The framework serializes the returned Dictionary to JSON itself, so the
  extra `json` was both wrong and redundant. Note: `cancelTaskId:` (and thus the
  process `terminate`) had already run by the time `response` blew up, so the
  cancel side effect DID take — only the reply serialization failed.
  Durability: this was a LIVE in-image compile; bake it in with a Caffeine
  rebuild+snapshot.
GOTCHA: MCP tools are NOT auto-discovered from the `#tools` method category —
they're registered explicitly in `SmalltalkMCPServer class>>initializeTools`
(each entry: `[self registeredInstance] aiToolNamed:withDescription:forSelector:`).
A new tool method only becomes visible after adding an entry there AND re-running
`SmalltalkMCPServer initializeTools` (which rebuilds the class-side `tools` ivar
and calls `Webpage current tether notifyOfToolsListChange`).
Why agent/UI-triggered (NOT proxy/bridge-triggered): the bridge has **no
reliable abandonment signal** for a detached eval. A well-behaved long eval
returns `running` at 5s so the bridge's 30s `tether.sendMessage` timeout never
fires; a true scheduler wedge holds `Tether messageHandlingLock` forever so a
tether-delivered cancel can't acquire the lock anyway (`Tether>>handleEvent:`
forks but wraps dispatch in `messageHandlingLock critical:`, serializing all
incoming sends). So the only actor that knows to cancel is the agent (or a
future Evaluate-ledger ✕ button). NOTE: the Caffeine MCP path does NOT go
through `mcp-proxy.js` (that proxy skips non-TCP backends); it flows through
`caffeine-bridge.js`. All four methods are image-side (compiled via
`compileMethod`) — no extension rebuild needed.

## Wire tools (Caffeine SqueakJS MCP server, `mcp_caffeine_*`)
- `evaluate` — on timeout (5s) answers `{status:'running', taskId, message}`
  instead of a value.
- `cancelEvaluation` (`SmalltalkMCPServer>>cancelEvaluation:`, `taskId`) —
  cancel a detached running eval; terminates its forked process + forgets the
  task.
- `getTaskStatus` (`SmalltalkMCPServer>>getTaskStatus:`, optional `taskId`) —
  no-card poller; **delivers the result** and marks the `#agent` observer.
- `createTaskProgressApp` (`SmalltalkMCPServer>>createTaskProgressApp:`,
  optional `taskId`) — renders a progress card **in the conversation** (an MCP
  Apps card; see _meta below) AND mounts an on-page mirror window; returns the
  status and marks the `#card` observer when finished. Call once per long eval,
  then poll `getTaskStatus`.
After editing `SmalltalkMCPServer class>>initializeTools`, re-run
`SmalltalkMCPServer initializeTools` (rebuilds `tools` + notifies client).

## User-facing cancel: Cancel button on the progress cards (2026-07-30)
Both Caffeine card HTMLs — `SmalltalkMCPServer class>>progressAppHTML` (the
conversation MCP Apps card) and `OrbitTaskMirror class>>localProgressHTML`
(the on-page mirror card) — now render a red **Cancel** button while the
task is running. Clicking it sends `tools/call {name:'cancelEvaluation',
arguments:{taskId}}` to the card's host, shows "Cancelling the
evaluation...", and on the next terminal status renders "Evaluation
cancelled." (✗). `applyStatus` treats `status:'cancelled'` (or
`unknown` after a user cancel) as the cancelled state; `formatResult`
also unwraps `{error:...}`.
- Conversation card path: the App's tools/call goes through the real MCP
  host to the server's cancelEvaluation tool. VERIFIED 2026-07-30 on the
  2300-ui conversation card (task-102): VS Code's MCP Apps host DOES
  forward an App-originated tools/call to a different tool than the
  card's own — the user's click cancelled the remote eval.
- On-page mirror path (verified end-to-end, task-49): the mirror host
  (`orbit-task-mirror.js`) intercepts `tools/call cancelEvaluation`, sets
  `_cancelRequested`, replies `{outcome:'requested'}`; `setStatus()` then
  returns **'cancel' exactly once** and the Squeak poller
  (`OrbitTaskMirror class>>pollLocalLoopFor:reg:`) performs
  `OrbitEvalTasks cancelTaskId:` and keeps polling so the cancelled status
  reaches the card. Unknown-after-cancel synthesizes `'cancelled'` (not
  `'finished'`). Host file + live prototype patched in sync.
- These Caffeine changes are LIVE in-image compiles; bake them in with a
  Caffeine rebuild+snapshot when next asked to rebuild.

## VW parity (2300-ui AND 2300-backend, 2026-07-30)
Both VisualWorks images now match Caffeine's long-running-task tool set:
- `LamMCPEvaluateTool>>handleCall` captures the eval process
  (`newProcess`/`resume`) and records it at registration via new
  `LamMCPEvaluateTool class>>task:setProcess:`.
- New `LamMCPEvaluateTool class>>cancelTaskId:` — same
  mark-cancelled-and-keep semantics as Caffeine (uses `Timestamp now`).
- New tool class `LamMCPCancelEvaluationTool` (superclass `LamMCPOrbitTool`,
  package Snowglobe), wire name `cancelEvaluation`; requires `taskId`;
  `handleCall:with:` override resolves session defensively (no `_meta` OK,
  like `LamMCPTaskStatusTool`), since a card's Cancel button carries no
  conversationId. Registered live via `svc addTool:`.
- 2300-backend also got 2300-ui's fixed `LamMCPService class>>allToolClasses`
  (toolName-non-nil over `withAllSubclasses`, not leaf-only) — that leaf-only
  bug was why `getTaskStatus` (non-leaf `LamMCPTaskStatusTool`) was missing
  from backend's tool list. `LamMCPTaskStatusTool` registered live too.
- Verified on both images: long eval → cancelTaskId/tool call → status
  `cancelled`, captured process `isTerminated` true (termination is
  ASYNC in VW — isTerminated reads false immediately after, true a moment
  later). Test-harness gotcha: tool params wire shape is
  `{'arguments' -> {argDict}}` (`validatedArgumentsFrom:` reads
  `params at: 'arguments'`).
- VS Code needs a reconnect (window reload) before newly added wire tools
  (`cancelEvaluation` ×2, backend `getTaskStatus`) appear to agents.
  (Done 2026-07-30; all three verified over the wire end-to-end.)
- The VW progress card (`LamMCPProgressResource class>>progressHTML`) now
  HAS the Cancel button too (both images, 2026-07-30), same HTML as the
  Caffeine cards. Supporting plumbing:
  - VW `Tether>>cancelTaskId:` (both images) — single-round-trip delegate
    to `LamMCPEvaluateTool cancelTaskId:`, answers plain-JSON (mirrors
    `taskStatusJSON:`).
  - Caffeine `OrbitTaskMirror class>>pollLoopFor:reg:` handles the host's
    'cancel' reply by calling `tether cancelTaskId:` and keeps polling.
  - NEW `OrbitTaskMirror class>>tetherForTaskId:` — there are TWO window
    managers/tethers (backend + ui images) and `tether` (first WM) may hit
    the wrong image; task ids are only unique per image. It probes each
    tether's `taskStatusJSON:` and picks the first non-'unknown', falling
    back to the first tether. `pollLoopFor:reg:` resolves it once at start.
  - Verified end-to-end (task-100): mirror card Cancel → tether → VW
    cancelTaskId: → card renders "Evaluation cancelled."
  - DURABILITY: all of the 2026-07-30 Caffeine-side cancel work (including
    `pollLoopFor:reg:` + `tetherForTaskId:`) is baked into the v1.253.0
    extension build's snapshot. The VW-side changes live in the VW images.

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

## Stuck-"running" card after a CPU-bound eval (fixed 2026-07-24)
Symptom: a long **CPU-bound** eval (e.g. a whole-system `allClassesDo:` source
scan) leaves its on-page progress card stuck showing the spinner ("running")
forever, even though the task finished and was forgotten from the registry.
Two causes chained:
1. A tight non-yielding Smalltalk loop starves the cooperative SqueakJS
   scheduler, so the mirror's 1200ms poll loop and the card's self-poll can't
   run *during* the scan — the card freezes on its last state ("running").
2. The REAL bug: once the task is forgotten, `statusDictForTaskId:` returns
   `{finished:true, status:'unknown'}`, but the mirror **host**
   (`orbit-task-mirror.js` `setStatus`) had a branch `if (this._wasAlive && s
   === 'unknown') return 'done'` that returned WITHOUT updating `_statusJSON`.
   So the host kept serving the last *live* JSON to the card's
   `createTaskProgressApp` polls — and if the last live status the host ever
   saw was `running` (never a clean `finished`, because the scan starved it),
   the card was served `running` forever.
Fix (host is the authority): that same branch now, when the last stored
`_statusJSON` was `running` (or unparseable), REPLACES it with a synthesized
`{status:'finished', finished:true, result:''}` so the card renders "Evaluation
complete." (green ✓). If the last live status was already terminal
(`finished`/`failed`) it's kept. Still returns `'done'` (stop polling, KEEP the
window for the user to close). Belt-and-suspenders: the card HTML
(`OrbitTaskMirror class>>localProgressHTML` and `SmalltalkMCPServer
class>>progressAppHTML`) `applyStatus` now tracks `sawRunning` and treats
`unknown`+`finished`-after-running as completed instead of failed ("No matching
evaluation found"). Live-only: host patched on disk + live prototype
(`customElements.get('orbit-task-mirror').prototype.setStatus`); the two HTML
methods recompiled in the image.

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
