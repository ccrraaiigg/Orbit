# SqueakJS VM liveness: `display.lastTick` vs `vm.lastTick`, and the relinquish-notifier flood

## `display.lastTick` is NOT VM liveness

In `website/public/js/squeakjs/squeak.js`, the run loop is driven by
`window.setTimeout(run, ms)` (see `run()` → `loop = window.setTimeout(run, ms)`),
NOT requestAnimationFrame. Two different "lastTick" fields exist:

- **`vm.lastTick`** (`SqueakJS.vm.lastTick`) — advances every interpret slice.
  This is the real measure of whether the Smalltalk VM is running.
- **`display.lastTick`** — the last *draw/render* tick. When the Caffeine
  window (`#embeddedSqueak`) is **collapsed** (which `Lam2300>>connect` does),
  the canvas isn't rendered, so `display.lastTick` stays frozen **even though
  the VM is running fine**. Do not use it to diagnose VM stalls.

Measured fact: with the panel visible+focused and the Caffeine window
collapsed, `display.lastTick` can be many seconds stale while `vm.lastTick`
advances ~1:1 with wall-clock. The native setTimeout loop self-sustains in the
foreground; no external "wake"/heartbeat is needed.

## Do NOT add a runNow() heartbeat

A worker/interval heartbeat that calls `display.runNow()` whenever
`display.lastTick` looks stale will fire constantly (because that field is
always stale when the canvas is collapsed) and **hammers the scheduler**. If it
pumps `runNow()` while processes are churning (e.g. during connect, or while
you're terminating processes), the VM momentarily finds **no runnable process**.

Symptoms of that state:
- Console: `scheduler could not find a runnable process` (thrown by
  `vm.js wakeHighestPriority`), flooding.
- A pile of Squeak pre-debug notifiers titled
  `MessageNotUnderstood: UndefinedObject>>relinquishProcessorForMicroseconds:`.
  These accumulate (saw 181 stacked) and "reopen when closed" because closing
  one reveals the next identical one underneath.

Why that selector with a `nil` receiver: `relinquishProcessorForMicroseconds:`
is implemented only on `ProcessorScheduler class` and sent only as
`self relinquishProcessorForMicroseconds:` from `ProcessorScheduler class>>idleProcess`
(`[self relinquish...] repeat`). A nil receiver means the idle path ran with a
broken/`nil`-self context — a consequence of the scheduler being driven into the
no-runnable-process state, not a real code bug.

## Recovery recipe

1. Stop/kill any heartbeat pumping `display.runNow()`.
2. Delete the accumulated notifier morphs:
   `World submorphs select: [:m | (m respondsTo: #label) and: [(m label) includesSubString: 'relinquishProcessorForMicroseconds']]`
   then `do: [:w | w delete]`. Their processes are usually already gone.
3. Verify health via the Process Browser: a healthy image shows the standard
   set incl. `(10) ...: the idle process` and `(40) ...: the UI process`, and
   `ProcessorScheduler classPool at: #BackgroundProcess` is alive (priority 10,
   ctx `ProcessorScheduler class>>idleProcess`, receiver `ProcessorScheduler class`).
4. Confirm `SqueakJS.vm.lastTick` advances ~1:1 with wall-clock and console is quiet.

## Related wedge: a block reaching JSON encoding (`Object>>printJSONOn:` `3 halt`)

A second way to wedge the Caffeine scheduler: `Object>>printJSONOn:` is
`(self asJSArgument = self) ifTrue: [3 halt]. self asJSArgument printJSONOn: stream`.
`BlockClosure>>asJSArgument` answers `^self`, so **any BlockClosure that reaches
JSON encoding hits the `3 halt`** → `UnhandledError` → a Morphic debugger opens
at priority 60 → starves the priority-40 UI process → windows stop mapping and
the scheduler floods. The trigger path is the Tether RPC:
`IncomingMessageExchange>>underExchangeID:to:send:withParameters:over:` does
`receiver perform: selector` and `tether push:`-es the answer JSON-encoded
(`Tether>>serviceExternalMessage:` is the sibling path for class-side actions via
`server class perform: selector`). If a remote/MCP message **answers with a
block**, the push halts.

Diagnostic+hardening probe installed live (reversible — just remove the method):
`BlockClosure>>printJSONOn:` that records `thisContext` sender frames into the
`JSONBlockLog` global (capped at 50) and emits JSON `null` instead of halting.
Inspect with `Smalltalk at: #JSONBlockLog`. To revert, remove
`BlockClosure>>printJSONOn:` (Object's method is untouched). NOTE: live-only —
needs a snapshot to survive reload; to catch a *reload* trigger the user must
snapshot after install, then reload, then inspect `JSONBlockLog`.

RESOLVED (2026-06-19): on a *clean* snapshot+reload, `JSONBlockLog` stayed
**empty** — no block reached JSON encoding during startup/connect. So the
block-JSON `3 halt` does NOT fire on a clean reload; the stuck debugger seen
mid-session was an **artifact of agent MCP/Snowglobe pumping**, not a connect
bug. The probe is kept as harmless hardening (returns `'null'` and logs).

## "2300-ui windows don't open on reload": throttling DISPROVEN (2026-06-19)

The earlier "background-tab throttling" explanation is **WRONG** — disproven by
direct measurement. A persistent in-page sampler (`window.__orbitTickLog`,
source `website/public/js/orbit-tick-probe.js`) recorded `vm.lastTick` vs
`Date.now()` every 500ms across a deliberate **unshare → wait → reshare** cycle
(no reload). Result over 358 samples / 178.5s: `vmTick` advanced **1:1** with
wall-clock the whole time (totalVmTickDelta 178509 ≈ totalWallMs 178502), largest
inter-sample gap only 511ms. **The page runs at full speed whether shared or
not.** CDP-attach / focus / visibility throttling is NOT the cause. (`focus` was
already `false` while shared, so focus isn't the axis either.)

### ROOT CAUSE (confirmed by WebSocket capture 2026-06-19): client-side worker→main gate

A WebSocket frame logger baked into the served `squeak.html` (wraps
`window.WebSocket` before SqueakJS boots; mirror `website/public/js/orbit-ws-log.js`;
buffer at iframe `window.__wsLog`, decodes opcodes, inflates gzip via pako)
captured a real **bare reload while unshared**. Decisive timeline (dt = ms from
first frame; page UNSHARED throughout):

- `ws://<backend>:19070/snowglobe` open at dt=1256.
- Client sends `StartSession` (a **text** frame) at dt=1263.
- **Server sends all 3 `MapWindow(12)` frames at dt=1393–1394** (gzipped, lens
  101/102/59), then 5 `HandleDisplayEvent(2)` draws — **all while unshared**.
- Then total silence from dt~3200 to dt~12845.
- At dt=12845–12865 (the instant the user re-shared) only **3 outbound** text
  frames on the snowglobe socket; windows appeared immediately, with **no new
  inbound frames**.

So the server is innocent: it sends the MapWindow frames within ~140ms of the
socket opening on a bare reload, and the client's WebSocket receives them. The
earlier "server skips MapWindow because `exit` is nil" hypothesis is **WRONG**.

The gate is **client-side, downstream of WebSocket receipt**: the Snowglobe
client decodes frames in a **Web Worker** and posts non-draw events (MapWindow)
back to the main thread, which runs SqueakJS `mapWindow:` (creates the
`<morphic-window>` + `windows` dict entry). On a bare-reload the main SqueakJS VM
ticks 1:1 (measured), yet `windows` stays 0 until sharing — so the stalled hop
is the **Worker→main-thread message delivery**: those postbacks don't drain into
`mapWindow:` until the page becomes active/shared (CDP-attached). Sharing does
NOT reload the page (vmTick continuous) and brings in NO new MapWindow frames —
it just flushes the already-received maps. (Draws make canvases via the worker
independently, which is why `canvases`=3 but `windows`=0.)

NEXT (to pinpoint the exact stalled hop and design a fix): instrument the worker
boundary — log in the worker when it receives/decodes MapWindow and when it
`postMessage`s back, and in the main thread's `worker.onmessage` when it fires —
then on the next bare-reload (use MCP to read the client `windows` dict while
UNSHARED; MCP doesn't need the page shared) see whether the worker posted back
but main didn't dispatch, vs the worker itself stalled. The user's "always
shared" request is well-motivated as the fix (keeps the page in the un-gated
active state).

### CONFIRMED ROOT CAUSE (2026-06-19): the Snowglobe display Worker is frozen while unshared

Worker-boundary instrumentation (baked into served `squeak.html`; mirror
`website/public/js/orbit-worker-log.js`) settled it. The logger wraps
`window.Worker` to record `construct`, every `toWorker` `postMessage` (main→worker,
with `.instruction` opcode) and every `fromWorker` `message` (worker→main), plus a
`requestAnimationFrame` heartbeat (`__rafLog`) and `visibilitychange` log. A second
probe in served `orbit.html` (mirror `website/public/js/orbit-render-probe.js`)
adds a MutationObserver timestamping `morphic-window` DOM add/remove (`__winLog`)
and its own rAF heartbeat. **All survive a bare reload** (served HTML, symlinked).

Decisive bare-reload capture (dt = ms from page load; UNSHARED until dt≈11.7s):

- Local windows (Getting Started, evaluate-ledger, Keep viewer) added to the DOM
  at **dt≈21–23ms** — created synchronously on the **main thread**, never touch
  the worker, so they ALWAYS appear.
- Snowglobe Worker constructed at dt=5706.
- Main posts the frames **to** the worker: `toWorker` MapWindow(12)+HandleDisplayEvent(2)
  at **dt≈5905–6259** (unshared).
- Worker replies **`fromWorker`** MapWindow(12) only at **dt≈11690–11985 — the
  instant the tab was shared** (5.8s after receiving them).
- The 3 Snowglobe `morphic-window`s are added to the DOM at **dt≈11833–12121**,
  i.e. ~140ms after each worker reply.
- Main-thread `requestAnimationFrame` ran **continuously** the whole time (frame
  counter 19→626 ≈ 50fps, no >250ms gaps) in BOTH documents — so the page was
  compositing fine and the **main thread was never throttled**.

The JS handlers (`JSSnowglobe jsClassDefinition` → `mapWindowIn`, `handleDisplayEventIn`,
…) are **fully synchronous**: each decodes the stream and calls `postMessage(...)`
immediately. No rAF, no promises. So a synchronous handler taking 5.8s to reply
means the **Worker thread was not scheduled** between dt≈6.0s and the share — the
embedder freezes/throttles the dedicated Worker thread while the Integrated
Browser tab is **unshared**, while keeping the main thread's rAF alive. Sharing
(Playwright/CDP attaches a screencast) un-throttles the renderer; the worker
drains its queued messages, fires the `mapWindowIn` replies, and `mapWindow:`
creates the windows.

This explains every observation:
- **Sharing makes windows appear**: CDP attach un-freezes the worker → queued
  MapWindow messages drain → windows map (confirmed: replies coincide with share).
- **VSCode restart always works**: the webview is recreated presented/foreground,
  so the worker runs from boot.
- **Bare reload fails**: worker frozen while unshared; frames are received and
  queued to it but never processed until share.
- **Keep viewer / ledger / Getting Started always open**: main-thread DOM windows,
  independent of the worker.

FIX DIRECTION: keep the page in the un-gated (shared/active) state. Disabling
renderer background-throttling via `argv.json` was tried and **did NOT work**
(see the "Auto-elicit tab sharing" section below) — the switches don't reach the
webview iframe's worker. The accepted workaround is the Squeak-initiated sharing
elicitation from `Lam2300>>connect`.

DIAGNOSTIC CLEANUP (DONE 2026-06-19): the worker/rAF/window loggers were removed
from served `squeak.html` and `orbit.html`, and `orbit-worker-log.js`,
`orbit-render-probe.js`, `orbit-ws-log.js`, `orbit-tick-probe.js` were deleted.
(The currently-running page keeps its live WebSocket/Worker wrappers until the
next reload — harmless passive buffers.)

## Livecoding sync note

`scripts/js/symlink-extension.js` symlinks `squeak.html` (and a *whitelist* of
`public/js/*.js`) back to the repo, but NOT arbitrary new files. A new
`public/js/foo.js` gets baked into the VSIX, not symlinked — so removing its
`<script>` tag from the symlinked `squeak.html` is enough to stop it loading on
reload, but the baked copy lingers in the installed ext dir until a rebuild
(harmless if unreferenced).

## Auto-elicit tab sharing from `Lam2300>>connect` (2026-06-19)

The user wants the Integrated Browser tab shared on every startup. Outcome:

1. **Throttling switches DID NOT WORK (reverted)**. The three
   `disable-renderer-backgrounding` / `disable-background-timer-throttling` /
   `disable-backgrounding-occluded-windows` switches in `~/.vscode/argv.json`
   were tried, but the user measured (snapshot → reload) that windows STILL did
   not appear until the tab was shared. The Electron-level backgrounding switches
   evidently don't reach the VS Code webview iframe's dedicated Worker thread.
   The switches have been removed from `argv.json`.

2. **Squeak-initiated sharing elicitation + page read — the accepted workaround**:
   `Lam2300>>connect` calls
   `Top orbitChat: '…if not shared, elicit sharing… Then read the page…'`
   after `tether provideSmalltalkMCPService`, guarded by
   `(Top at: #orbitChat) isNil ifFalse: [...]`. This initiates a Copilot chat
   turn via `window.orbitChat` (`website/public/js/orbit-chat.js`), which POSTs
   `{query,mode,newSession}` to the extension's `/chat` bridge
   (`app-impl.js` proxy → private loopback → `workbench.action.chat.open`).

   **The decisive ingredient is the agent READING the page, not the share.**
   "Shared" in the VS Code picker is passive — it only makes the page available.
   What actually un-throttles the webview renderer is an **active CDP client**:
   when the agent calls `read_page` (or any browser tool), Chromium attaches a
   DevTools client to the renderer and stops backgrounding it, so the frozen
   Snowglobe display **Worker** gets scheduled, drains its queued `MapWindow`
   postMessages, and `mapWindow:` creates the `morphic-window` DOM. Observed
   directly: windows popped in the instant a `read_page` ran, even though the
   tab had been "shared" for a while with no windows. So the earlier "sharing
   makes windows appear" was really "the agent's attach makes them appear."
   The worker deliberately stays off the main thread (speed / unburden main),
   so the fix is to guarantee the CDP attach happens at startup — hence the
   prompt now tells the agent to read the page.

   `connect` runs on the **main thread** (never frozen — rAF stays continuous),
   so `orbitChat` fires fine while unshared. It's a workaround (it opens the
   windows *by involving the agent*), not a true headless fix, but the user
   chose to go with it.

   Key facts:
   - Caffeine/SqueakJS runs in the `#embeddedSqueak` iframe; `window.orbitChat`
     and `window.__ORBIT_BRIDGE_BEARER__` live on the **outer** `orbit.html`
     window (loaded there via `<script src="js/orbit-chat.js">`). The Smalltalk
     `Top` resolves to that outer window — `(Top at: #orbitChat)` is present and
     `Top orbitChat:` reaches it (same dispatch as the existing `Top alert:` in
     `Lam2300>>initialize`). NOTE: `Top == (JS evaluate: 'return window.top')`
     is **false** because each JS-proxy wrapper is a distinct Smalltalk object;
     don't use `==` to identify JS windows — test functionally (`at:`).
   - This is an **image-only** change (Caffeine `Lam2300`, package
     `Hex-HTML5-apps-Rosebud`). It persists across reload only via a snapshot
     (the user snapshotted after recompile). Do not snapshot yourself.

## Keep viewer didn't reopen on page reload (2026-06-19)

Sibling local windows survive a bare page reload because they're **static /
self-mounting in `orbit.html`**: Getting Started is a `<markdown-viewer>`
element in the markup; the evaluate-ledger (`evaluations`) self-mounts from its
component script. The **Keep viewer ("Keep Store") is NOT** — it's injected
dynamically by the extension's one-time startup hook
`openKeepViewerOnStartup()` (`website/src/extension-impl.js`, gated by
`auditReplayFired`, fired when Caffeine MCP first becomes available at extension
activation). That hook calls the Caffeine MCP tool `openKeepViewer`
(`SmalltalkMCPServer>>openKeepViewer`), which builds the `keep-viewer` web
component into `window.parent.document` with KStore notes/edges. A bare page
reload restarts the SqueakJS image and the outer document, destroying the
viewer, and the extension hook does NOT re-fire — so it's gone.

FIX: `Lam2300>>connect` now forks a bounded wait for the MCP server instance
(`SmalltalkMCPServer registeredInstance`, which is `Tether serverAt: self
endpoint` — non-nil once the server registers over the tether after reload) and
then calls `server openKeepViewer`, recreating the viewer on every page load
like the other local windows. To open it manually for the current session:
`SmalltalkMCPServer registeredInstance openKeepViewer`. Image-only change \u2014
needs a snapshot to persist.

