# Launcher uses a Snowglobe display policy (it is swapped in/out)

## The invariant (from the user)
**Only a window with a Snowglobe display policy will update in the Orbit
webapp.** So if a window renders/updates on the page, its
`damageRepairPolicy` IS (or recently was) a
`Snowglobe.SnowglobeWindowDisplayPolicy`. Do NOT conclude a window is
"off the Snowglobe path" just because a point-in-time snapshot shows a
plain `WindowDisplayPolicy` — see the swap below.

## How the Snowglobe policy attaches to a window (2300-ui)
- `Window>>includeInSnowglobe` -> `includeInRemoteUI`.
- `ScheduledWindow>>includeInRemoteUI`:
  `self exposesToRemoteUI ifFalse: [RemoteUIProvider withDisplayPolicyClassDo:
   [:cls | self damageRepairPolicy: (cls forWindow: self)]]`.
  -> installs a `SnowglobeWindowDisplayPolicy` **as the window's
  `damageRepairPolicy`**, wrapping the previous one (kept in the policy's
  `originalDisplayPolicy` ivar).
- `ScheduledWindow>>exposesToRemoteUI`:
  `^damageRepairPolicy notNil and: [damageRepairPolicy exposesToRemoteUI]`.
  `WindowDisplayPolicy>>exposesToRemoteUI` ^false; the Snowglobe subclass
  ^true. So `win exposesToRemoteUI` is the reliable test for "currently
  Snowglobe-wrapped", NOT `damageRepairPolicy class name` (which can read
  `WindowDisplayPolicy` while the wrapper is swapped out).
- `Window>>excludeFromSnowglobe` -> `ScheduledWindow>>excludeFromRemoteUI`:
  `self exposesToRemoteUI ifTrue: [damageRepairPolicy := damageRepairPolicy
   originalDisplayPolicy]` -> restores the ORIGINAL (plain) policy.

## The swap during every capture (why snapshots mislead)
`SnowglobeWindowDisplayPolicy class>>broadcastRectangle:forDisplayPolicy:`
captures the whole window into a Pixmap:
```
[window excludeFromSnowglobe; displayOn: pixmap graphicsContext]
    ensure: [window includeInSnowglobe].
```
So during the full-window re-render the window is temporarily EXCLUDED
(plain policy), then re-included. A point-in-time read of
`damageRepairPolicy` frequently catches a window as plain. This is what
produced my earlier WRONG conclusion that the launcher was "off the
Snowglobe damage funnel / updated by full-window refresh." It is NOT --
it uses the Snowglobe policy like every mirrored window.

`includeInRemoteUI` creates a NEW wrapper each time (guarded by
`exposesToRemoteUI ifFalse:`), which is why `SnowglobeWindowDisplayPolicy
allInstances` accumulates several orphaned instances over time.

## Capture model (corrected)
1. Damage rect is accumulated via the window's Snowglobe policy
   (`accumulateRectangle:` -> class-side `scheduleRectangle:forDisplayPolicy:`
   -> per-policy Set in `updates`).
2. The broadcasting process (`startBroadcasting`, ~100ms `interFrameDelay`)
   drains `updates`; for each policy with pending rects it calls
   `broadcastRectangle:forDisplayPolicy:`, which RE-RENDERS THE WHOLE
   WINDOW into a pixmap (briefly excluded) and ships only the damaged
   rectangle, tiled into <=~1 MB horizontal bands.
   So the shipped pixels for a menu highlight = the band(s) of the
   full-window pixmap intersecting the SCHEDULED damage rectangle.

## RESOLVED: root cause of the intermittent partial "System" highlight
(The launcher IS Snowglobe-included in normal use; it is excluded only
*while a remote display update is in progress* -- the broadcast loop's
brief `excludeFromSnowglobe ... ensure:[includeInSnowglobe]`. The idle
0/2000-plain sampling just happened to land between broadcasts; it is NOT
the cause.)

The real cause is a Bug-B direct-draw bypass on the menu-bar rollover
redisplay path:
- WinXP menu-bar hover sets `WinXPMenuBarButtonView>>flyingOver: aBoolean`,
  which (on change) calls `redisplayForEnabledChange`.
- `Win95MenuBarButtonView>>redisplayForEnabledChange` calls
  `self simpleRedisplayIn: self normalBox colorBackgroundIfNeeded: ...`.
  (`PushButtonView>>normalBox` = `self bounds`, so NO geometry clipping --
  my earlier "one char short = narrow rect" guess was wrong.)
- `SimpleView>>simpleRedisplayIn:colorBackgroundIfNeeded:` only routes
  through `invalidateRectangle:repairNow:true` (the policy/broadcast path)
  when `state isOccluded` OR `graphicsContext medium hasOutstandingDamage`.
  Otherwise it takes the DIRECT-DRAW branch: grabs `self graphicsContext`
  (the screen GC), `intersectClip:`, and `self displayOn: gc` -- drawing
  straight to the local screen, BYPASSING the window's display policy. So
  the Snowglobe broadcasting policy never captures the hover highlight.
  The page therefore keeps showing a stale/partial frame (whatever an
  unrelated overlapping broadcast last captured), which read as the
  intermittent partial/one-glyph-short "System".

### Fix (implemented, validated)
Override the rollover redisplay to force the Snowglobe-visible path:
`UI.WinXPMenuBarButtonView>>redisplayForEnabledChange` ->
`Snowglobe.SnowglobeWindowDisplayPolicy broadcastRedrawOf: self`
(which does `invalidateRectangle: self bounds repairNow: false` +
`displayPendingInvalidation`, always routing through the policy's
`displayDamageList:in:` -- repairs local screen via originalDisplayPolicy
AND broadcasts the full button bounds). Covers all menu-bar buttons in
the WinXP look (File/System/Browse/... are all WinXPMenuBarButtonView).
Validated: `sys flyingOver: true` -> full blue highlight broadcast across
the whole word; `flyingOver: false` -> clean full unhighlight. Packaging
left to the user.

NOTE: A first attempt patched `MenuBarButtonView>>redisplayChangeOfState
From:to:` (model-state-change path) -- that is NOT the hover path and did
NOT fix the symptom. REVERTED (removeSelector:) on 2026-06-24: that path is
actuated ONLY via `BasicButtonView>>update:with:from:` when the model
announces `#value` and `getBooleanValue` (`model value` vs `referenceValue`)
flips -- i.e. a bound boolean toggling, which launcher menu-bar buttons
don't have. So it was dead code here. The real fix
(`WinXPMenuBarButtonView>>redisplayForEnabledChange` ->
`broadcastRedrawOf: self`) also covers enable/disable, since
`redisplayForEnabledChange` is sent both by `flyingOver:` (hover) and
`SimpleView>>isEnabled:`.

## Probing gotchas (2300-ui)
- Two `lamCTC` launcher windows (`8@36 corner:628@236` and a smaller
  one); `detect:` order is non-deterministic.
- Window class is `ApplicationWindow` (subclass of ScheduledWindow);
  inherits ScheduledWindow>>exposesToRemoteUI.
- Coerce labels with `displayString` (can be UserMessage); use
  `includesSubstring:`.
- Long sampling loops with `Delay` exceed the inline window -> returns a
  taskId; poll `getTaskStatus`.
