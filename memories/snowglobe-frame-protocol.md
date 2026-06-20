# Snowglobe frame wire protocol (Caffeine side)

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

## Snowglobe class chain (no Portal `connection` getter)
`Snowglobe → RemoteMessagingService → Object`. `RemoteMessagingService`
defines only `connection:` (setter). Access the underlying JSWebSocket via
`(snowglobe instVarNamed: 'connection') instVarNamed: 'connection'`.

## JSReadStream>>nextBitmap accepts only byte 2 (VW format)
Byte 1 (Squeak) opens a debugger; any other byte returns undefined and
`showBitmapAtonCanvas` crashes on `bytes.length`. Use `putBitmap:on:` which
writes a leading byte `2` then length-prefixed bytes.
