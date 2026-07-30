# Snowglobe: Portal instruction reentrancy (2026-07-29)

## Symptom

Every other display update from a mirrored VisualWorks window failed to reach
Caffeine. Reproducible only with **real local input** at the VW window, never
with page-driven (Playwright) input.

## Root cause

`Snowglobe.Portal` holds a single `outgoingMessage` write stream.
`startInstruction:` unconditionally replaced it. Meanwhile
`SnowglobeWindowDisplayPolicy class>>broadcastRectangle:forDisplayPolicy:`
assembles a display frame as one long cascade, writing ~300 KB a byte at a time
into a doubling `WriteStream`.

That allocation makes `MemoryPolicy>>makeSpaceFor:ofType:` run
`ObjectMemory class>>garbageCollect` → `compactingGC`, which raises a wait
cursor via `Cursor>>showWhile:`. `Cursor>>beCursor` is hooked to
`SnowglobeWindowDisplayPolicy class>>showCursor:`, which calls
`exit startInstruction: ShowCursor` — **in the broadcast process, nested inside
the frame being assembled**. The partial frame was destroyed and `send` shipped
garbage. Because the per-frame allocation is large and regular, the GC lands on
roughly every second frame, hence the strict alternation.

Captured stack:

```
Snowglobe.Portal>>startInstruction:
Snowglobe.SnowglobeWindowDisplayPolicy class>>showCursor:
Cursor>>beCursor / currentCursor: / show / showWhile:
ObjectMemory class>>compactingGC
ObjectMemory class>>garbageCollect
MemoryPolicy>>makeSpaceFor:ofType:
```

## Fixes applied

1. `showCursor:` returns immediately when `Processor activeProcess == broadcasting`.
   The broadcast process never legitimately changes the cursor. **This is the only
   change that survives.** The user confirmed it fixed the every-other-frame loss.

2. Everything listed under "Reverted" below was **reapplied on 2026-07-30**, after the
   wedge was traced to an unrelated pre-existing defect. See "Reapplied 2026-07-30".
3. A reentrant instruction lock in `Portal`, because the message stack fixes nesting
   within a process but not interleaving between processes. See "Resolved 2026-07-30".

## Reverted: everything else tried on 2026-07-29 (READ THIS BEFORE RETRYING)

A second round of changes was layered on top and **had to be backed out** after the
VisualWorks image became unresponsive shortly after each Snowglobe connect —
including after a plain page load with no manual intervention. Backed out:

- a `pendingMessages` stack in `Portal` (`startInstruction:` pushes, `send` pops in
  an `ensure:`) to make nested instructions safe generally;
- `Portal>>startInstruction:sized:` pre-sizing the buffer;
- `Portal>>nextPutBytes:` doing a bulk `nextPutAll:` instead of a byte loop;
- `broadcastRectangle:forDisplayPolicy:` retaining the existing display policy
  (`window damageRepairPolicy: remotePolicy`) instead of `includeInSnowglobe`,
  and hoisting the `snowglobeOffsetFromParent` computation out of the cascade;
- `showCursor:` computing its bytes before opening the instruction;
- `#debug`-level trace calls in `Portal>>startInstruction:`/`send`.

Lessons:

- **Change one thing at a time in a live image, and let the user confirm between
  changes.** Six simultaneous changes made the regression impossible to attribute.
- The per-frame policy churn from `WindowDisplayPolicy class>>adoptWindow:`
  (`self new adoptWindow:`) looks wasteful but may be load-bearing for damage
  bookkeeping. Do not "fix" it without understanding `updates` keying first.
- A stacked-message scheme is only safe if **every** `startInstruction:` reaches a
  `send`. Several senders build their arguments *inside* the cascade
  (`beginCursorOverlayFor:offset:`, `mapWindowForDisplayPolicy:`), so an error
  there leaks a stack entry permanently and shifts every later pop.
- `outgoingMessage` is shared across processes — the UI, damage-repair (80) and
  broadcast (80) processes all assemble into it. A push/pop stack does not fix
  cross-process interleaving: a process that resumes after preemption writes into
  whatever message is current.

## Reapplied 2026-07-30, after the wedge was traced elsewhere

The revert above was a panic measure; the wedge turned out to be the shared `Delay`
(next section), not any of these. All of them are back in, plus leak-proofing for the
two senders that built arguments inside the cascade.

- `Portal` gained the `pendingMessages` inst var; `startInstruction:sized:` pushes,
  `startInstruction:` delegates with a 1 KB default, `send` pops in an `ensure:`.
- `Portal>>nextPutBytes:` uses `outgoingMessage nextPutAll: bytes`.
- `broadcastRectangle:forDisplayPolicy:` hoists `snowglobeOffsetFromParent` and the
  label out of the cascade, presizes the buffer to `bits size + label size + 128`,
  and retains the display policy.
- `mapWindowForDisplayPolicy:` hoists `snowglobeWantsTitlebar` /
  `snowglobeOffsetFromParent` / `snowglobeParentKey` / `label`, each guarded, and
  skips the frame entirely if any is unavailable.
- `beginCursorOverlayFor:offset:` computes `rgbaBytesFor:` before opening the
  instruction and presizes.
- `showCursor:` needed no change — it already computes `ext`/`hot`/`rgba` before
  `startInstruction:`.
- The `#debug` trace calls in `Portal` were **not** restored (they are what turned
  a spin into gigabytes of synchronous file I/O).

### The `updates` keying question, answered

`updates` is an `IdentityDictionary` keyed by display-policy instance;
`accumulateRectangle:` schedules `forDisplayPolicy: self`. `includeInSnowglobe`
routes through `WindowDisplayPolicy class>>includeInRemoteUIWindow:` →
`activeWindowDisplayPolicyClass adoptWindow:` → `self new adoptWindow: window`, so a
**new** policy instance (and hence a new key) was created on every frame.

Retaining the instance is safe with respect to the wrapper chain:
`excludeFromRemoteUI` does `damageRepairPolicy := damageRepairPolicy
localWindowDisplayPolicy`, `LamRemoteUIWindowDisplayPolicy>>localWindowDisplayPolicy`
delegates down and `WindowDisplayPolicy>>localWindowDisplayPolicy` answers `self`, so
the chain stays depth-1 and terminates. Skipping `adoptWindow:` therefore only skips
re-setting values that are already correct.

What was **not** understood, and is the real hazard: the per-frame reselection is
load-bearing on disconnect.

```smalltalk
SnowglobeWindowDisplayPolicy class>>isActiveWindowDisplayPolicyClass
	^ self isConnected
```

`activeWindowDisplayPolicyClass` consults that on every `includeInSnowglobe`, so the
churn is how windows fall back to a plain local `WindowDisplayPolicy` once the portal
dies. Unconditional retention would pin windows to a dead remote policy and let
`accumulateRectangle:` fill `updates` forever with no consumer. The shipped version
gates on it:

```smalltalk
	(self isConnected and: [remotePolicy isKindOf: self])
		ifTrue: [window damageRepairPolicy: remotePolicy]
		ifFalse: [window includeInSnowglobe]
```

Verified: policy `identityHash` per window is now stable across repaints (was a fresh
hash every frame), and `pendingMessages` depth returns to 0.

Still unverified: whether the old churn also served to *shed* stale damage (a detached
policy is never scheduled again, bounding an entry's lifetime in `updates`).

### TRAP: `damageRepairPolicy` is not the policy slot

```smalltalk
ScheduledWindow>>damageRepairPolicy
	damageRepairPolicy == nil ifTrue: [damageRepairPolicy := DamageRepairPolicy new].
	^ damageRepairPolicy localWindowDisplayPolicy   "ALWAYS unwrapped to the LOCAL policy"

ScheduledWindow>>myWindowDisplayPolicy
	^ damageRepairPolicy                            "the raw slot -- use THIS"
```

Capturing with `damageRepairPolicy` makes `remotePolicy isKindOf:
SnowglobeWindowDisplayPolicy` always false, so the retention silently does nothing.
The first attempt shipped that way and was inert for a day. It also means an
inventory of windows built with `damageRepairPolicy` reports *every* window as a
plain `WindowDisplayPolicy`, which is badly misleading when hunting for windows that
aren't mirrored.

The *setter* is fine: `damageRepairPolicy: aPolicy` does
`damageRepairPolicy adoptLocalPolicy: aPolicy`, and after `excludeFromSnowglobe` the
slot holds a plain local policy whose `adoptLocalPolicy:` answers its argument.

## Resolved 2026-07-30: menu bar shows the GC cursor and no pull-down

Symptom: clicking a launcher menu bar item intermittently produced no pull-down in the
mirror (the real VW menu was fine) plus a stuck garbage-collection cursor. Roughly one
click in three.

Root cause: **several processes assembled into the single shared
`Portal>>outgoingMessage` concurrently.** `LamRemoteUIWindowDisplayPolicy>>
mapTransientWindowOr:` forks a *fresh* process per map:

```smalltalk
mapTransientWindowOr: alternateBlock
    self showWindowsLocally ifTrue: [super mapTransientWindowOr: alternateBlock].
    self forkDamageRepairIn: [
        self mapWindow.
        self window scheduleRemoteUIRectangle: (0@0 corner: self window extent)]
```

so the writers are the `…Broadcasting` loop, the UI process, and one
`… - Damage Repair Process` per map. A ring-buffer probe caught three instructions
open at once (`d=3`). The `MapWindow` itself got out intact, which is why the window
existed on the page; the full-window repaint queued right after it, and the
`ShowCursor` restore, were assembled into buffers swapped out from under them.
Hence: window mapped but never painted, cursor stuck on "garbage".

Fix: an instruction is now atomic across processes and reentrant within one.
`Portal` gained `lockOwner`, `lockDepth`, `lockSemaphore`, `sendingDepth`, with
`acquireInstructionLock` / `releaseInstructionLock` called from
`startInstruction:sized:` and `send`'s `ensure:`.

Three things that make the lock safe, all of them learned the hard way:

- **`waitWithTimeoutMs: 250`, never `wait`.** A cascade
  (`exit startInstruction: X; …; send`) cannot be wrapped in an `ensure:`, so a
  process terminated mid-instruction leaks the lock. Blocking forever there would
  stall every display process — the same shape as the 2026-07-29 wedge. On timeout it
  steals and logs `#lockStolen`, degrading to the old interleaving instead of wedging.
  (`waitWithTimeoutMs:` answers **true when acquired**, false on timeout.)
- **Reentrancy by owner check**, not by `Semaphore critical:`. A GC's wait cursor
  reenters through `Cursor>>beCursor` on the *same* process; `critical:` would
  self-deadlock.
- **`releaseInstructionLock` clamps** with `excessSignals > 0 ifFalse: [signal]`, so
  the semaphore stays binary and self-repairs after a steal.

`send` drops the socket write when `sendingDepth > 0` — a message begun while an outer
one is already being written would splice its bytes into that frame. Only the GC wait
cursor nests that deeply and dropping a cursor update is harmless; the drops come in
matched garbage/normal pairs so the page's cursor stays consistent.

After the fix, over 27 map/unmap cycles: zero `#lockStolen`, and every depth-2 entry
was a `ShowCursor` immediately `#sendDropped`. No cross-process nesting at all.

### The probe that found it

A bounded in-memory ring, `Smalltalk at: #SnowglobePortalTrace put: OrderedCollection
new`, read with `Smalltalk at: #SnowglobePortalTrace ifAbsent: [nil]` at each logging
site (the idiom already used by `SnowglobeCloseLog`). Records
`#start`/`#send`/`#map`/`#unmap`/`#cursor` with `Processor activeProcess name` and the
pending-message depth. **Log the process name** — that is what cracked it. Costs one
global read when disabled, and unlike raising `SnowglobeDiagnostics current level` it
cannot turn a spin into gigabytes of synchronous file I/O.

Caveats when reading it: entries are appended *after* the push, so log order can
disagree with real order under preemption; and process names truncate — 
`SnowglobeWindowDisplayPolicyBroadcasting` vs `SnowglobeWindowDisplayPolicy - Damage
Repair Process` are 28 characters apart.

Also observed, not yet explained: windows come in duplicate pairs sharing one key
(e.g. two `AHSWHCTransientWindow key=161`, one mapped with a Snowglobe policy and one
unmapped with a plain one). See `snowglobe-corpse-cleanup.md`.

## Resolved 2026-07-29: the image wedged on page reload (shared Delay + unkillable orphan)

Symptom: VisualWorks went unresponsive shortly after a page reload, and the MCP
server went silent with it. Correlated with `snowglobe-trace-*.log` files of
1.0 GB and 1.7 GB, whose tails were ~50 identical lines per millisecond:

```
[warning] Snowglobe.SnowglobeWindowDisplayPolicy error: This Delay is already waiting
```

Root cause, two independent defects that compound:

1. `initializeBroadcasting` created ONE shared `Delay` in `interFrameDelay`, and
   `broadcastProcessLoop` waited on it. A `Delay` may only be waited on by one
   process at a time, so the moment two broadcast processes coexist — which a page
   reload produces, since the new connection starts broadcasting while the previous
   process is still alive — one raises `This Delay is already waiting` every
   iteration. (`broadcastSupervisorLoop` always got this right: it makes a fresh
   `(Delay forMilliseconds: 1000)` per iteration.)
2. `terminateBroadcasting` (and `forceLocalFallbackFromSupervisor`) terminate only
   the process currently registered in `broadcasting`. Once an earlier teardown has
   niled it, an orphaned broadcast process **cannot be stopped by anything**: not by
   its own `on: Error do:` handler calling `disconnectAndFallback`, and not by the
   watchdog, whose stall branch is gated on `broadcasting notNil` and therefore goes
   quiet exactly when it is needed. The orphan spins at priority 80 (above
   `userSchedulingPriority` 50), starving the UI and the MCP server.

Fix, all in `broadcastProcessLoop`:

- each broadcast process creates its own `Delay`;
- the loop retires itself when `Processor activeProcess ~~ broadcasting`, checked
  *after* the wait so it cannot fire during the race between `forkAt:` (priority 80)
  and `startBroadcasting`'s assignment to `broadcasting`;
- a 500 ms backoff in the error handler, so no repeating error can be a hot loop.

`initializeBroadcasting` no longer creates the shared `Delay`.

Lessons:

- **A trace file on disk survives a wedge; the MCP connection does not.** When the
  image locks up, raise the diagnostics level, reproduce, restart, and read the tail
  of the log. Read the TAIL with `s position: f fileSize - 6000` — never slurp a
  multi-gigabyte log into the image.
- Check log file *sizes* early. The size alone identified which runs had wedged.
- Raising the diagnostics level is not free: it converted a quiet spin into
  gigabytes of synchronous file I/O and made the wedge much more likely to be
  noticed as a hang. It is an observability tool, not a passive one.
- A cleanup routine that only stops the *registered* worker leaves orphans immortal.
  Workers should also check their own registration and retire themselves.


## What the reverted changes were, in detail (for a future, more careful attempt)

- `Portal` gained a `pendingMessages` inst var. `startInstruction:` stacked the
  message under assembly; `send` restored it in an `ensure:`, popping only when the
  stack was non-empty so `startMessage`-based Tether use stayed balanced.
- `broadcastRectangle:forDisplayPolicy:` resolved `snowglobeOffsetFromParent`
  **before** opening the instruction, so every `startInstruction:` was matched by
  a `send` and the stack could not leak on that path.
- `broadcastRectangle:forDisplayPolicy:` reinstalled the *same* policy after the
  offscreen render (`window damageRepairPolicy: remotePolicy`) instead of
  `includeInSnowglobe`. The refactored `WindowDisplayPolicy class>>
  includeInRemoteUIWindow:` → `adoptWindow:` → `self new adoptWindow:` creates a
  fresh policy every frame, so `updates` accumulated damage under displaced
  policy keys (seen in traces as `frame: policies=2` for one window, and a
  different `policy=<identityHash>` on every frame).
- `nextPutBytes:` did one bulk `outgoingMessage nextPutAll: bytes` instead of
  `bytes do: [:byte | self nextPutByte: byte]`, and `startInstruction:sized:`
  pre-sized the buffer. `broadcastRectangle:` passed `bits size + label size + 128`,
  so a band no longer doubled its way up from 1 KB (which threw away ~1 MB of
  intermediate ByteArrays per band). `image bits` is a ByteArray whose `size` is
  the byte count, so it can be `nextPutAll:`d straight into a ByteArray
  `WriteStream`.


## Diagnosing technique that worked

`SnowglobeDiagnostics current level: #debug` writes to
`snowglobe-trace-<stamp>.log` in the image directory (LF-separated, not CR).
Temporarily adding to the `#debug` trace:

- a sampled checksum of the band's `image bits` — proved the pixmap was fresh,
  ruling out a stale-render race;
- the writing process name in `Portal>>startInstruction:`, plus a `sender` chain
  for non-display instructions — pinpointed the nested `ShowCursor`.

## VisualWorks gotchas hit along the way

- Contexts respond to `sender`, not `parentContext`; and to `selector` via
  `printString` only (`method` DNUs on `MethodContext` here).
- `WriteStream` has no `nl`; use `nextPut: Character lf`.
- `Object` has `instVarAt:`, not `instVarNamed:`.
- `Array class>>with:` tops out at 5 arguments.
