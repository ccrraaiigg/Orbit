# Snowglobe frame wire protocol (Caffeine side)

## Frame compression toggle (VW outbound) — `Snowglobe.Portal.CompressFrames`
Compression is gated by the `Snowglobe.Portal` class-side shared variable
`CompressFrames` (default `true`); read/write via `Snowglobe.Portal
compressFrames` / `compressFrames: aBoolean`. `Portal>>send` checks it per
frame: `true` ⇒ gzip the payload; `false` ⇒ raw envelope = one byte `0x52`
('R') + uncompressed payload. The Caffeine receiver demuxes on the FIRST byte
(`0x1F` gzip magic ⇒ `pako.ungzip`; `0x52` ⇒ `raw.subarray(1)`; anything else
dropped). Both Caffeine handlers — `Snowglobe>>connectTo:` and
`Snowglobe>>reinstallOnMessage` — already demux, so flipping the flag is
safe live with no page change. Only the VW→Caffeine display direction is ever
compressed; VW reads inbound input events raw (`Exit>>incomingPayloadIn:`
returns the message verbatim), and Caffeine sends input uncompressed. So
`Snowglobe.Portal compressFrames: false` on 2300-ui fully disables Snowglobe
compression (done 2026-06-20 to save CPU). Both the live shared-var value AND
the recorded initializer are now `false`, so it's durable across snapshots and
a from-scratch image rebuild / Store commit. The initializer was changed the
same way VW's own `CodeReader>>installChangedStatics:` does — without disturbing
package/private/constant:
`| ns b i | ns := Snowglobe.Portal classPool. b := ns bindingFor: #CompressFrames.
i := ns compileInitializer: 'false'. i method sourcePointer: 'false'. b initializer: i.`
(`InitializedVariableBinding` is the binding class; `defineSharedVariable:...`
is the heavier canonical API but risks moving the var's package if attributes
are wrong, so the surgical `initializer:` is preferred.)

## Remote display broadcaster can die → no repaints
Symptom: remote windows open/map but there are NO display updates, and the
sim UI appears unresponsive (input is actually fine; nothing repaints). The
VW UI process is healthy, parked in `WindowManager>>processNextEvent`
(Semaphore>>wait). The Snowglobe SOCKET is still open (`isConnected`=true) —
this is NOT a tether/connection problem.
End-state: the remote process `SnowglobeWindowDisplayPolicyBroadcasting`
(prio 80) is non-nil but `isTerminated=true`. Check with
`Snowglobe.SnowglobeWindowDisplayPolicy startBroadcasting isTerminated`
(returns the existing process without respawning).

Real mechanism (corrected): the broadcaster is a bare `[[...] repeat]` loop
forked in `startBroadcasting` with NO exception handler. In simulator/headless
mode the debugger is suppressed, so any unhandled exception's default action
TERMINATES the process. And `startBroadcasting` early-returned the non-nil
corpse instead of respawning ⇒ it stayed dead permanently.
NOTE: page activity CANNOT kill it — data flows VW→page only (broadcaster just
pushes pixels). Page→VW input goes over the SEPARATE `/tether` receive loop.
Earlier theory blaming window manipulation was wrong.

Durable fix (installed 2026-06-16, pkg Snowglobe): rewrote
`SnowglobeWindowDisplayPolicy class>>startBroadcasting` to (a) wrap each frame
body in `on: Error do:` that captures `[Timestamp, ex class name, messageText,
shortStack]` into the Smalltalk global `#SnowglobeLastFault` (guarded) and
`ex return: nil` to continue — so one bad frame can't kill the loop; and
(b) respawn when `broadcasting isTerminated` instead of returning the corpse.
Read `Smalltalk at: #SnowglobeLastFault ifAbsent: [nil]` after any future
stall to see the actual raising exception + stack.
Respawn cleanly with `Snowglobe.SnowglobeWindowDisplayPolicy initializeBroadcasting`
(terminates corpse, resets `updates`, calls guarded startBroadcasting).
Note: `SnowglobeWindowDisplayPolicy` lives in the `Snowglobe` namespace —
unqualified name is a DNU; use the full name.

## Instrumenting the frame-send path is CATASTROPHIC — don't, or do it non-throwing
Symptom: a 2300-ui (port 19070) backend's remote windows never appear in the
page; browser console shows `WebSocket connection to 'ws://…:19070/snowglobe'
failed: Invalid frame header`; VW `SnowglobeWindowDisplayPolicy isConnected`
reports `true` while `exit.websocket` ivar `closing`=true (split-brain: page
JSWebSocket `readyState`=1 but VW closed its end). The OTHER backends (19072,
19200) work with byte-identical code.

Root cause (2026-06-21): a diagnostic logging line left in
`Snowglobe.WebSocket07>>send:code:final:mask:` used a SIX-argument
`Array with:with:with:with:with:with:` — **this VW image's `Array` class only
implements `with:` up to FIVE args** (6-arg is a DNU). Every frame write hit
that DNU. `Portal>>send` wraps the whole send in
`on: Error do: [:exception | self close]`, so the DNU was silently swallowed
and the connection was closed on the VERY FIRST frame (even the tiny ~99-byte
MapWindow frame). The frame headers were actually valid (byte1=130 binary+FIN,
byte2=payload len, unmasked) — "Invalid frame header" is what the browser
reports when the server closes mid/around a frame. Removing the logging line
(restore the clean method) instantly fixed it: all 3 windows mapped AND the
large 1280×1009 Lam-2300-UI window painted full pixel content.

Lessons:
- `Portal>>send`'s `on: Error do: [:e | self close]` makes ANY exception
  anywhere under `websocket send:` (gzip, framing, logging, socket write)
  invisibly kill the connection. NEVER add throwing code to
  `send:code:final:mask:` / `Portal>>send` / anything they call. If you must
  log, make it bullet-proof (and prefer reading state out-of-band instead).
- This image's `Array class>>with:…` tops out at 5 args. For 6+ use
  `(Array with: a with: b with: c), (Array with: d with: e with: f)` or
  `{a. b. c. d. e. f}` (brace arrays work in `evaluate`, though the `compile`
  tool has rejected brace-array literals — use `Array with:` chains there).
- The "Access page transmits but other pages can't" historical symptom was the
  SAME self-inflicted bug (every frame DNU'd); it is NOT a real large-frame /
  64-bit-length / masking / gzip defect. Framing length encoding is correct
  big-endian for the 125 / 126(2-byte) / 127(8-byte) cases; server `masking` is
  false; gzip (`0x1F 0x8B`) is valid. All verified 2026-06-21.

## 2026-06-23: SAME 19070 symptom, DIFFERENT root cause — large-frame socket write fails ERROR_BAD_COMMAND
Symptom again: 2300-ui (19070) windows appear then disappear; browser console
`ws://…:19070/snowglobe failed: Invalid frame header` (and sometimes
`A server must not mask any frames that it sends to the client`). The other two
backends (19072/19200) work with byte-identical code. This time it was NOT a
code DNU. Verified:
- ZERO senders of `with:with:with:with:with:with:` (the old Array bug is gone).
- `compressFrames` is `true` on BOTH 19070 (broken) AND 19072 (working) → NOT a
  compression difference. (It had regressed from the 2026-06-20 durable `false`;
  the gzip path itself works fine — tested `OS.ZLib.GZipWriteStream` standalone.)
- All live `WebSocket07 masking` = false (server never masks).
- Captured the swallowed exception by temporarily instrumenting `Portal>>send`'s
  `on: Error do:` handler (guarded, non-throwing) to record class/message/stack
  into a global, then reconnecting from Caffeine. Result:
  `OsInvalidArgumentsError: ERROR_BAD_COMMAND` raised in
  `SocketAccessor>>privateWriteFrom:startingAt:for:` ←
  `IOBuffer>>flushBufferUpTo:` ← `ExternalWriteStream>>flush/nextPut:` ←
  `WebSocket07>>send:code:final:mask:` ← `send:code:final:` ← `send:` ←
  `Portal>>send`. A real OS SOCKET-WRITE error, not a Smalltalk DNU.
- Captured a per-frame header log (also temporary, in `send:code:final:mask:`):
  many frames send FINE (small map/paint frames AND large ones), framing is
  byte-correct — e.g. size 95066 → byte2=127, xLength
  `[0 0 0 0 0 1 115 90]` = 0x0001735A = 95066 ✓; unmasked. The log shows a large
  ~95 KB frame (the 1280×1009 Lam-2300-UI full-window paint) immediately
  followed by an opcode-8 CLOSE frame → i.e. the big frame's socket write threw,
  `Portal>>send` caught it and called `self close`. Small frames succeed (windows
  APPEAR); the big full-window paint frame's write fails (connection truncated
  mid-frame → browser desyncs → "Invalid frame header"/"masked frame" → windows
  DISAPPEAR). Page-side JSWebSocket ends at readyState 3 (closed) on 19070.
- Diagnostic technique to reproduce: from Caffeine, reconnect just the 19070
  client: `Snowglobe allInstances detect: [:s | the one whose
  connection.connection url = 'ws://192.168.1.140:19070/snowglobe']` then
  `[sg connectTo: 'ws://192.168.1.140:19070'] forkAt: Processor
  userBackgroundPriority` (onOpen → startSession → VW maps & paints). NOTE in
  Caffeine/Squeak, ByteString does NOT understand `includesSubstring:` (DNU);
  use `=` equality on the full url or another test.
OPEN ROOT CAUSE (not yet fixed): why does the ~95 KB socket write yield
ERROR_BAD_COMMAND on 19070 specifically (large frames painted fine on
2026-06-21)? Candidates to investigate next: non-blocking partial-write /
send-buffer handling for big frames on this socket, or the browser resetting the
connection under the large frame while the throttled webview consumer falls
behind (then VW's continued write dies). Both instrumented methods
(`Portal>>send`, `WebSocket07>>send:code:final:mask:`) were RESTORED to clean and
temp globals (`#SnowglobeFrameLog`, `#SnowglobePortalFault`) removed.

## 2026-06-24: DECISIVE — ERROR_BAD_COMMAND is the write-to-ALREADY-CLOSED-socket
## error; the PAGE closes first, not a VW-side size limit
Direct experiments through the live `exit` websocket (`exit instVarAt: 1`,
calling `ws send: (ByteArray new: N withAll: 65) code: 2 final: true mask: false`
to bypass gzip and write N raw bytes):
- On a socket whose VW end was ALREADY CLOSED (`SnowglobeWindowDisplayPolicy
  isConnected` = false, split-brain — page JSWebSocket still readyState 1):
  EVERY size, even 1 MB, raises `OsInvalidArgumentsError: ERROR_BAD_COMMAND`.
- On a FRESH, genuinely-live socket (`isConnected` = true) with a fast browser
  reader: ALL sizes SUCCEED — 125 B, 64 KB, 256 KB, 1 MB, 4 MB, **16 MB** all
  write fine. So VW's socket write has NO inherent large-frame size limit; the
  IOBuffer/`writeFrom:startingAt:forSure:` loop + WouldBlock retry handle big
  writes correctly when the peer is alive and draining.
CONCLUSION: `ERROR_BAD_COMMAND` is simply what `SocketAccessor`'s write
primitive (680) yields when the socket has been closed/reset BY THE PEER. So the
real sequence is: (1) the PAGE/browser drops the WebSocket first; (2) VW's next
broadcast write hits the dead socket → `ERROR_BAD_COMMAND`; (3) `Portal>>send`'s
`on: Error do: [:e | self close]` tears down the Snowglobe connection → windows
DISAPPEAR. The fault is NOT a VW-side framing/size/gzip defect. The open question
becomes: WHY does the page drop the WS around a large repaint?
STRONG LEAD (observed same session): sending a few large RAW frames
(1 MB + 4 MB + 16 MB) to the webview made the Integrated-Browser RENDERER CRASH
("Target crashed", page.evaluate fails, `#embeddedSqueak` gone) and logged the
exact production symptom `WebSocket connection to 'ws://…:19070/snowglobe'
failed: Invalid frame header` + `WebSocket is already in CLOSING or CLOSED
state`. So large incoming frames (real ones decompress 95 KB gzip → ~5 MB
Depth32 bitmap, repeatedly) pressure the webview renderer; under memory/throughput
pressure the renderer drops or resets the WS (or crashes), and THEN VW sees the
write die. CAUTION: do NOT stress-test by blasting multi-MB raw frames at the
shared page — it OOM-crashes the renderer and takes down the Caffeine VM (lost
the page this way on 2026-06-24; required user-consented reload).
LIKELY FIX DIRECTION (page-side, not VW-side): reduce per-frame decompressed
size / memory churn on the Caffeine receiver — e.g. cap full-window repaints,
tile large repaints into smaller sub-rectangles server-side so no single frame
decompresses to multiple MB, reuse/free the decompressed buffers, or move
ungzip+blit off the main thread. Secondary VW-side hardening: make `Portal>>send`
NOT permanently tear down on a single transient write error (or reconnect), but
that alone won't help since a closed socket stays closed.

## 2026-06-24: FIXED — server-side tiling of large repaints
Installed in 2300-ui (pkg Snowglobe), rewrote
`SnowglobeWindowDisplayPolicy class>>broadcastRectangle:forDisplayPolicy:` to
TILE the damage rectangle into horizontal bands of at most ~1 MB each
(`maxBytesPerFrame := 1048576`; `bandRows := (maxBytesPerFrame //
((rectangle width * 4) max: 1)) max: 1`, 32 bpp). The window pixmap is rendered
ONCE; then for each band `image := pixmap completeContentsOfArea: bandRect` and a
HandleDisplayEvent is sent with that band's `extent` and `bandRect origin`. This
is wire-compatible because the protocol ALREADY carries each frame's
`nextPutPoint: rectangle origin` + band extent and the receiver blits the partial
bitmap at that origin (exactly how ordinary small damage rects already paint), so
tiling just emits a series of normal partial-paint frames. Small damage rects
(the common case) still yield a single band — fast path unchanged.
Verified live: reconnected the page's 19070 Snowglobe client (Caffeine hash 1123,
`[sg connectTo: 'ws://192.168.1.140:19070'] forkAt: Processor
userBackgroundPriority`); the full 1280x1009 "Lam 2300 UI" simulator window
PAINTED COMPLETELY and STAYED, `isConnected` remained true. Forcing an explicit
full repaint (`win refresh` — note `invalidate` is a DNU on these windows; use
`refresh`) kept the connection open and the window present (clock kept ticking).
Before the fix the same large repaint dropped the WS and the window disappeared.

## 2026-06-24: REVIVED — remote cursor (opcode 8 `ShowCursor`) → page CSS cursor
Goal: show the native cursor (e.g. the vertical `ns-resize` resizer when hovering
a pane splitter's bottom edge) on the Orbit page, matching what the VW host shows.
The `ShowCursor` opcode (value **8**, class var on
`Snowglobe.SnowglobeWindowDisplayPolicy`) already existed and was already DRIVEN:
`Cursor>>beCursor` (pkg OS-Window System) calls
`RemoteUIProvider withDisplayPolicyClassDo: [:cls | cls isConnected ifTrue:
[cls showCursor: self]]` on EVERY cursor change. `ResizingSplitterController`
(pkg UIBasics-Controllers) `enterEvent:`/`exitEvent:` already call
`(view horizontal ifTrue: [self upDownCursor]) show` → `beCursor`. So NO
controller/framework patching was needed — both ends were just unwired.

Two unwired ends, both fixed (2026-06-24):
1. VW EMITTER `SnowglobeWindowDisplayPolicy class>>showCursor:` was stubbed
   (`false ifTrue: [...]`). Rewrote it to emit opcode 8 with the standard header
   then cursor payload: `startInstruction: ShowCursor; nextPutInteger: 0 (id);
   nextPutPoint: ext (cursor image extent, normally 16@16); nextPutPoint: hot;
   nextPutBytes: rgba; send`. RGBA via the existing `self rgbaBytesFor: cursor
   asOpaqueImage` (colour-key alpha algorithm, RGBA row-major). Hotspot via
   `cursor instVarAt: (cursor class allInstVarNames indexOf: 'hotSpot')` (Cursor
   has NO #hotSpot accessor; ivar order errorCode handle image mask hotSpot name;
   upDown/leftRight hot = 8@8, normal hot = 1@1). The NORMAL arrow
   (`cursor name = 'normal'`) is special-cased to emit a ZERO extent + empty bytes
   = "revert to native cursor" (else the whole page would wear VW's low-res 16px
   arrow). WHOLE body wrapped in `on: Error do: [:ex | ex return: nil]` because it
   runs inside `beCursor` on the local cursor path — it must NEVER throw or it
   would break the VW host's own cursor (`primBeCursor` wouldn't run).
2. Caffeine RECEIVER had no `instruction == 8` branch. Added a MAIN-THREAD branch
   (DOM access needed, like the 17/18 drag-aug branch) to BOTH
   `Snowglobe>>reinstallOnMessage` and `Snowglobe>>connectTo:`, inserted right
   before `if (instruction == 12)`. It reads `chot = stream.nextPoint()` and
   `crgba = stream.nextBytes()`, and drives a single persistent
   `<style id="snowglobe-cursor-style">` in `window.top.document.head`: when
   `extent.x==0 || crgba.length==0` → `textContent = ""` (native cursor restored);
   else build a 16x16 canvas (`createImageData`+`set`+`putImageData`),
   `toDataURL("image/png")`, and set `textContent =
   "*{cursor:url(<dataURL>) <hotX> <hotY>,auto !important}"`. The global
   `*{…!important}` rule guarantees the cursor shows over the canvas/morphic-window
   (inline element cursors without !important lose to it); it self-heals because
   `exitEvent:`/entering pane content fire `normal`/text cursors → reset.
Patched both methods in-image with `src copyReplaceAll: 'if (instruction == 12) {'
with: branch , 'if (instruction == 12) {'` then `Snowglobe compile:classified:`
(guard: skip if `src includesSubString: 'if (instruction == 8)'`). The branch is
SINGLE-LINE JS with only DOUBLE quotes (no `'`), so it embeds safely in the
Smalltalk single-quoted string literal. Then activated live without teardown:
iterate `Snowglobe allInstances`, for each whose `connection` websocket
(`conn instVarNamed: 'connection'`) has `(ws at: #readyState) = 1`, call
`sg reinstallOnMessage` (3 live instances).
VERIFY without a precise hover: force `Snowglobe.SnowglobeWindowDisplayPolicy
showCursor: ResizingSplitterController upDownCursor` then read the page's
`#snowglobe-cursor-style` textContent (should be the url(...) 8 8 rule); reset
with `showCursor: Cursor normal` (textContent → ""). USER-CONFIRMED working live
by hovering a splitter (2026-06-24).
PERSISTENCE: the VW `showCursor:` change persists in the remote 2300-ui image.
The Caffeine-side `reinstallOnMessage`/`connectTo:` changes live only in the
SqueakJS object memory until the next extension rebuild snapshots `caffeine.image`
(same "pending a rebuild" status as the drag-aug opcodes 17/18).
GOTCHA: in Caffeine/Squeak, ByteString uses `includesSubString:` (capital S) and
`Dictionary`/method source via `(Class >> #sel) getSource asString`;
`occurrencesOfString:` is a DNU — count substrings with an
`indexOfSubCollection:startingAt:` loop.
NOTE the fix is in the LIVE image only; for durability it needs a Store commit /
image snapshot (not yet done — out of scope unless asked).

## 2026-06-24: tiling committed to Store + loaded into 2300-backend; durable broadcaster guard (re)added to 2300-ui
- User committed the tiled `broadcastRectangle:forDisplayPolicy:` to Store and
  loaded it into 2300-backend (verified present there; broadcaster alive,
  isConnected=true).
- The current Snowglobe source did NOT actually contain the "2026-06-16 durable
  guard": `startBroadcasting` on BOTH images was still the bare `[[...] repeat]`
  loop that early-returns a terminated corpse. So a stray (non-large-repaint)
  exception could still silently terminate the broadcaster -> blank windows with
  no captured stack. (This is exactly why 2300-backend came up blank: its
  broadcaster had died; `Snowglobe.SnowglobeWindowDisplayPolicy initialize`
  respawned it.)
- (Re)installed the durable guard on 2300-ui (pkg Snowglobe), pending user Store
  commit + load into 2300-backend:
  * NEW class-side helper `recordBroadcastFault: anException` — captures
    `[Timestamp now, ex class name, messageText, <=25-frame shortStack]` into the
    `SnowglobeLastFault` SHARED (class) variable (added via
    `addClassVarName: 'SnowglobeLastFault'`, NOT a Smalltalk global); wrapped in
    its own `on: Error do: [nil]` so it NEVER raises.
  * VW gotcha: the signaling context selector is `anException initialContext`,
    NOT `signalerContext` (which is DNU on VW Exception). Walk it via `sender`.
    (`topOfContextStack` also works; `handlerContext` gives the on:do: frame.)
    Verified capture: `[nil foo] on: Error do: [:ex | SWDP recordBroadcastFault:
    ex]` -> classVar holds a 4-elt Array, 11-frame stack, first frame
    `UndefinedObject(Object)>>doesNotUnderstand:`.
  * Rewrote `startBroadcasting`: (a) `(broadcasting notNil and: [broadcasting
    isTerminated not]) ifTrue: [^broadcasting]` so a TERMINATED corpse is
    respawned rather than returned; (b) each per-policy `broadcastRectangle:` is
    wrapped in `on: Error do: [:ex | self recordBroadcastFault: ex. ex return:
    nil]` so one bad frame skips only that policy, not the loop; (c) an outer
    per-iteration `on: Error do:` backstop guards `interFrameDelay wait` /
    `updatesCritical:` too.
  * Recompiling `startBroadcasting` does NOT swap the already-forked loop block;
    activate the new loop with `SnowglobeWindowDisplayPolicy initializeBroadcasting`
    (terminates old, resets updates/interFrameDelay, calls new guarded
    startBroadcasting). Did so on 2300-ui — broadcaster alive, isConnected=true,
    forced full `win refresh` kept it alive, SnowglobeLastFault stayed nil.
  * After future stalls, read `Snowglobe.SnowglobeWindowDisplayPolicy classPool
    at: #SnowglobeLastFault` (the class var) for the actual raising exception +
    stack.

## `damageRepairPolicy` getter HIDES the Snowglobe wrapper — use the ivar
`ScheduledWindow>>damageRepairPolicy` deliberately returns
`damageRepairPolicy originalDisplayPolicy` (the unwrapped BASE
`WindowDisplayPolicy`) whenever `exposesToRemoteUI` is true — "the wrapper is
not publicly accessible." So `aWindow damageRepairPolicy` reading as a plain
`WindowDisplayPolicy` does NOT mean the window isn't exposing; it usually means
it IS. To reach the live `SnowglobeWindowDisplayPolicy` wrapper for
`mapWindowForDisplayPolicy:` / `broadcastRectangle:forDisplayPolicy:`, grab the
ivar directly: `view instVarAt: (view class allInstVarNames indexOf:
'damageRepairPolicy')`. Confirm with `wrapper isKindOf:
Snowglobe.SnowglobeWindowDisplayPolicy`. `setter damageRepairPolicy:` likewise
delegates to `originalDisplayPolicy:` when exposing. `Window>>exposesToRemoteUI`
is the reliable "is it broadcasting?" check. Reconnect a single page-side
Snowglobe from Caffeine with
`[sg connectTo: 'ws://HOST:PORT'] forkAt: Processor userBackgroundPriority`
(the method has a 5s `Delay` for the tether, so fork it); onOpen sends
`StartSession` and VW maps windows.

## Frame layout
Each gzipped frame body is:
1. instruction byte (INSTR.* in `website/src/snowglobe-server.js`)
2. varint integer id (window/snowglobe id)
3. point fullExtent (header)
4. per-instruction payload

## Worker dispatch trap
`JSSnowglobe` worker's `eventHandlingCode` only consumes the **instruction byte
and the id** before dispatching. It does NOT consume the header point. The
per-instruction handler (e.g. `handleDisplayEventIn:`, `mapWindowIn:`) starts
with `nextPoint()` and that read IS the header fullExtent.

⇒ **Do not re-emit the extent at the start of the body.** For
`HandleDisplayEvent`, the body starts directly with `dirtyRect extent`, then
`wantsTitlebar(bool), offsetFromParent(point), parentKey(int), label(bytes),
depth(byte), destination point, bitmap`.

The `buildFrameInstruction:id:extent:do:` helper writes the header
(byte+integer+point); the block writes only what comes AFTER fullExtent.

## SqueakJS WebSocket binary sending
`ByteArray asJSArgument` yields a JS String; passing it to
`WebSocket.send()` sends a UTF-8 TEXT frame and mangles bytes ≥ 0x80
(pako on the receive side throws "incorrect header check").

Workaround used in `SnowglobeMorphicService>>sendFrame:`:
```js
(jsws, byteString) => {
  if (jsws.readyState !== 1) return;
  var u8 = new Uint8Array(byteString.length);
  for (var i = 0; i < byteString.length; i++) u8[i] = byteString.charCodeAt(i) & 0xff;
  jsws.send(u8.buffer);
}
```
Send `u8.buffer` (ArrayBuffer) so the WebSocket emits a binary frame.

### The CONSUMER input path had the same latent bug (fixed 2026-07-24)
`WebEntrance>>send` (the consumer's `connection`, a `Portal` subclass used
for `HandleMouseEvent`/`HandleKeyboardEvent`/`RequestResizeWindow`) was
`connection send: self outgoingPayload` — the ByteArray → Latin-1 string →
**TEXT** frame, so bytes ≥ 0x80 in multi-byte wire integers got UTF-8
expanded (`0xD6` → `0xC3 0x96`). Fingerprint: values < 128 pass (low mouse
coords, small window sizes work), values ≥ 128 corrupt. This is exactly why
mirror-window **resize** (opcode 20, sends width/height ints) resized the
mirror but not the original — width often < 128 survived, height ≥ 128
became garbage (e.g. target 470 → 38595). Fix: `WebEntrance>>send` now
converts the payload to a `Uint8Array` via a lazily-installed JS helper
`window.__sgInputToU8` (charCodeAt loop, no channel swap) before
`connection send:`. Same idiom as the producer's `sendFrame:`. LIVE-ONLY in
the image until snapshot+rebuild.

## Snowglobe class chain (no Portal `connection` getter)
`Snowglobe → RemoteMessagingService → Object`. `RemoteMessagingService`
defines only `connection:` (setter). Access the underlying JSWebSocket via
`(snowglobe instVarNamed: 'connection') instVarNamed: 'connection'`.

## JSReadStream>>nextBitmap accepts only byte 2 (VW format)
Byte 1 (Squeak) opens a debugger; any other byte returns undefined and
`showBitmapAtonCanvas` crashes on `bytes.length`. Use `putBitmap:on:` which
writes a leading byte `2` then length-prefixed bytes.

## 2026-06-24: WHY the LEditor (LEditor tab) gutter is INVISIBLE in Orbit
Symptom: with the System Browser's `LEditor` tab selected, the native VW UI shows
a left/right gutter with LINE NUMBERS and colored ANNOTATION icons (the "leds");
in Orbit only the method TEXT shows, no gutter.
ROOT CAUSE — a `self graphicsContext` screen-GC BYPASS, the general anti-pattern
for offscreen capture. Snowglobe captures each window by rendering it into an
OFFSCREEN `Pixmap`: `broadcastRectangle:forDisplayPolicy:` does `window displayOn:
pixmap graphicsContext`. That cascade calls each subview's `displayOn: aCanvas`
with the pixmap GC. But the LEditor views draw their gutter to the LIVE on-screen
window GC instead of `aCanvas`:
  * `Refactory.Browser.LTextEditorView>>displayOn: aCanvas` (pkg LED-UI) =
    `super displayOn: aCanvas. self update.` — text goes to aCanvas (→ pixmap,
    visible), but then `update` is called with NO gc argument.
  * `LTextEditorView>>update` = `gc := self graphicsContext. self controller
    hideLeds. self displaySideBarBackgroundOn: gc. self displayLineNumbersOn: gc.
    self displayToogleButtonsOn: gc. self displayLedsOn: gc. self
    displaySelectionsOn: gc.` — the WHOLE gutter (sidebar bg, line numbers,
    toggle buttons, led annotation icons, selections) is painted to
    `self graphicsContext`.
  * `VisualPart>>graphicsContext` (pkg Graphics-Visual Objects) returns
    `container graphicsContextFor: self` → a GC on the REAL on-screen window
    medium, NOT the pixmap passed into `displayOn:`. So the gutter draws straight
    to the Windows screen and never lands in the broadcast pixmap → invisible in
    Orbit. The text shows because `super displayOn: aCanvas` paints it into the
    pixmap.
  * The wrapper `Refactory.Browser.LPrettyTextEditorView>>displayOn:` /`update`
    has the SAME pattern for its right-side strip (`gc := self graphicsContext`).
Works natively because there the window's medium IS the screen, so
`self graphicsContext` == where the user looks. This is the same class of bug as
any incremental "paint directly to my live GC outside displayOn:" idiom: invisible
to Snowglobe's offscreen pixmap capture.
FIX (NOT done — touches LED-UI app code OUTSIDE the Snowglobe package; needs user
consent + undo marker): route the gutter through the passed canvas — e.g.
`displayOn: aCanvas` → `super displayOn: aCanvas. self updateOn: aCanvas.` and add
`updateOn: gc` = `update` with `gc :=` removed (use the arg). Same for
`LPrettyTextEditorView`. Geometry is unchanged because during the pixmap cascade
the subview's clippingBounds match the on-screen ones.
TRAP when "make it part of the Snowglobe package": do NOT assign package
membership via the Store DB package model. `(Store.Package allPackages detect:
[:p | p name = 'Snowglobe'])` returns a DATABASE package record (ivars
primaryKey/dbIdentifier/blessingLevel/parcelID/...). Reading its `methods`
(faulted 1440 refs, took **21 s**) or `overrides`/`includesMethod:`/`addMethods:`
lazily faults from the Store DB and BLOCKS the image: a probe touching
`overrides`+`methods first`+`includesMethod:` ran past the **30 s MCP/tool
deadline** → surfaced as "Canceled" (`status=error dur=30024`), and the wedged
image then made the next calls fail with `502 "MCP server could not be started"`
(~30 s each). Diagnosed from main.jsonl durations (troubleshoot skill). So for
package assignment use a LIGHTWEIGHT image-resident path, never the DB-backed
`Store.Package` collections.
WHY the MCP "long-running tasks" feature does NOT save you here: that feature is
SMALLTALK-LEVEL — it forks the evaluation into a separate Smalltalk process and a
watchdog timer emits the `running`+taskId handshake while work continues. It
depends on the green-threaded VW scheduler getting CPU. The Store DB fault blocks
the VM BELOW the scheduler (blocking native/FFI call in the DB driver on the VM
OS thread), so: the forked eval can't run, the watchdog never fires (NO running
handshake), the MCP socket-listener never runs (every request — even a trivial
read-only `getMethodSource` — returns `502 "MCP server could not be started"`),
and the client cancel can't interrupt the native primitive (the wedge SURVIVES
cancellation: a `dur=6965` 7 s cancel still left the bridge 502 afterward). The
bridge self-heals only when the DB call drains on its own (an earlier `pkg
methods` eventually returned after 21 s and the 502s cleared). Behavioral tell of
a VM-level block vs a Smalltalk-level long computation: a Smalltalk-level loop
still lets the scheduler answer the listener and honors cancel; a native block
502s everything and ignores cancel. ⇒ Don't drive Store DB ops through evaluate
at all; long-running tasks can't rescue them.
FIX APPLIED & VERIFIED (2026-06-24): compiled four methods via the MCP `compile`
tool (NOT evaluate — compile installs methods without touching the DB), protocol
`snowglobe-rendering` so they're easy to relocate. On `LTextEditorView` (ref
resolved via `Refactory.Browser.LTextEditorView`): NEW `updateOn: aGraphicsContext`
= a copy of `update` with `gc := aGraphicsContext` instead of `self
graphicsContext`; OVERRIDE `displayOn: aCanvas` = `super displayOn: aCanvas. self
updateOn: aCanvas`. Same pair on `LPrettyTextEditorView` for its right-side strip.
The original `update` methods are left intact (now unused by displayOn:, still
fine for any incremental on-screen repaint). Native on-screen display is
unchanged because there the gc passed to `displayOn:` IS the window medium gc
(== what `self graphicsContext` returned). Forced re-broadcast with `win refresh`
(found via `ScheduledControllers scheduledControllers` filtering label) → Orbit
now shows the left line-number gutter (digits 1..n) that was previously missing.
The colored led annotation icons flow through the same `updateOn:` path and show
on methods that have them. PACKAGE ASSIGNMENT to Snowglobe was deliberately left
to the user (Store DB write); the methods currently sit in LED-UI with the
`snowglobe-rendering` protocol. These compiled changes live in the remote 2300-ui
image only.
