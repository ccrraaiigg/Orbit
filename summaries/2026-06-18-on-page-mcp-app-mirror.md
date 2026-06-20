# On-page MCP App mirror (task progress) over the Snowglobe tether

## Objectives
- (Done) Task removed only after BOTH the card and the agent poll post finish/fail.
- (In progress) Render the VS Code "task progress" MCP App on the Orbit page,
  fed over the Snowglobe tether instead of the VS Code JSON-RPC MCP host.

## User clarifications
1. Rendering: reuse existing `ui://orbit/progress` App HTML, embedded into a
   morphic-window web component.
2. Trigger/taskId: agent-driven, mirroring cards created in the conversation.
3. Observer semantics: passive; when the conversation card is removed, the
   on-page mirror is removed too (mirror does NOT mark #cardObserved).

## Foundation (validated)
- VW `LamMCPEvaluateTool class>>statusJSONForTaskId:` — passive plain-JSON read
  (uses `JSONEncoder`, NOT the MOSS-typed `JSON` class). Never marks observation.
- VW `Tether>>taskStatusJSON:` — single-round-trip convenience delegating to it.
- Tether round-trip PROVEN synchronously from Squeak:
  `((Webpage current instVarNamed: 'windowManagers') first instVarNamed: 'tether')
   taskStatusJSON: 'task-N'` → returns plain JSON String.
- Dual-observer removal (`noteCompletionObservedBy:ofTaskId:`) validated.

## Inner/outer document split (KEY)
- `mcp_caffeine_evaluate` talks to the INNER SqueakJS image (inside
  `#embeddedSqueak iframe`). `Webpage current document` = inner iframe document
  (body = `CANVAS#squeak`); has NO morphic-window elements.
- The OUTER orbit.html document is reachable via
  `Webpage current window parent document` (same-origin localhost:8089).
  It holds the 6 `<morphic-window>` elements, `#embeddedSqueak`, `#dashboard`.
- The `<morphic-window>` custom element is defined in the OUTER page.
- Inner Squeak↔JS bridge works on the outer doc too: createElement, call
  methods, pass String args, read properties.
- => The mirror is an OUTER-page morphic-window; inner Squeak (which owns the
  tether) creates and feeds it via the parent-document proxy.

## Component (written, not yet injected/tested)
`website/public/js/components/orbit-task-mirror.js` — `<orbit-task-mirror taskid>`:
- Builds a `<morphic-window caption="Task progress — task-N">` (useCutout=false)
  wrapping a `<center>`+`<iframe srcdoc=progressHTML>` (model: lam2300-vr `_build`).
- Acts as the App's MCP host: window 'message' listener filtered to its iframe's
  contentWindow answers JSON-RPC: `ui/initialize`→{}, `tools/call`→
  `{content:[{type:text,text:<statusJSON>}]}`, `ui/notifications/size-changed`→resize.
- `setStatus(json)` stores latest status; on status 'unknown' AFTER having been
  alive → teardown (mirror the card removal). `teardown()` removes mw+self,
  dispatches `orbit-mirror-closed`.
- `window.__orbitTaskMirror` registry: `mount(taskId, html, host)`, `find`,
  `setStatus(taskId,json)`, `unmount(taskId)`.

## Remaining plan
- Todo 4 (in progress): inject component into OUTER orbit.html head (Playwright,
  + write file done). Needs the page SHARED.
- Todo 5: Squeak driver class (e.g. `OrbitTaskMirror`, commented) that fetches
  progressHTML over the tether, mounts the mirror in the outer doc, and forks a
  ~1s poller pushing `tether taskStatusJSON: taskId` → element.setStatus; tears
  down on 'unknown'.
- Todo 6: single Squeak entry point the agent calls when creating a card
  (agent-driven mount), + end-to-end test (long evaluate → card → mirror shows
  progress→complete → tears down when task removed).

## Reminders
- Object refs (stable this session): LamMCPEvaluateTool class=1701561041,
  instance=1619829655; LamMCPTaskStatusTool=1698940409, class=1865497841;
  LamMCPCreateTaskProgressAppTool=1811768273, class=1815032881; Tether=1824701473.
- VW code in "Snowglobe"; comment every class. Squeak strings:
  `indexOfSubCollection:` not `includesSubstring:`. JSONEncoder for plain JSON.
- Never reload page / stop server without consent. Never remove
  `#embeddedSqueak`/`#dashboard`/`#status`/`#agent-mouse-cursor`; scope cleanup
  with `:not(#embeddedSqueak)`.
