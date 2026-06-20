# SnowglobeToolState: wafer transport derives from materialManager, not effector registers

## Problem
The VR twin (`<lam2300-vr>`) only animated PM processing — never the
LP↔LL (atmospheric robot) or LL↔PM (vacuum transfer robot) wafer
transport. Root cause: `Snowglobe.SnowglobeToolState class>>currentJSON`
read CTROC effector registers
(`TransferChamberTransferChamber-EndEffectorN…`, `AtmArmAtmArm-…`,
`AirLockN…`) which hold blank strings / 0 during a flow, so robots
never showed a wafer or a destination.

## Fix (in `Snowglobe.SnowglobeToolState class`, category `snowglobe-toolstate`)
Derive transport from the authoritative material model instead:
`CWRegistry current machine materialManager allMaterial` → the
`LamWafer`s. Per wafer:
- `locationResourceName` — current station (canonical symbols:
  `Port1..3`, `AtmArm`, `AirLock1/2`, `TransferChamber`, `PM1..4`).
- `slotNumber` — slot.
- `locationHistory reverseDo:` — first record whose `resourceName`
  differs from the current loc gives the **previous distinct station**
  (the leg's source).

New class-side methods: `liveWaferCensus`, `emptyEffectorNamed:`,
`lockStatesFrom:`, `vtmRobotStateFrom:`, `atmRobotStateFrom:`, and a
rewritten `currentJSON` (modules/carriers/arm logic unchanged).

### Source targeting (V1)
Next-hop destination is NOT directly available mid-transit
(`destContainerResourceName`/`destPosition`/`currentLocationChangeRecord`
are nil). So we expose the **source** station (previous distinct
location) as the robot's target: vtm `destPM` = prev; atm `airLock`/
`slot` = prev lock/port. The renderer (`lam2300-vr.html`,
`_normDest`/`_normAtmLock`/`_normAtmPort`) drives the arm to that
station while showing the carried wafer. Imperfection: the vtm arm
points at the source station during carry rather than sweeping into
the destination PM. Acceptable for V1.

## Verification technique (MCP evaluate has a SHORT timeout — no long loops)
Don't run multi-second `whileTrue:` loops in `mcp_2300-ui_evaluate`;
they time out. Instead install a **browser-side recorder** via
Playwright that polls the snapshot the twin actually receives
(`/workspace-fs/read?uri=orbit-webdav://2300-ui/tool-state.json`) on a
`setInterval`, plus reads the A-Frame entity transforms inside the
iframe (`getElementById('robot-arm').object3D.rotation.y`,
`getAttribute('visible')` on `carried-wafer`/`atm-carried-wafer`).
Read the buffer between turns. Confirmed: vtm arm peaks ~60° with
`carried-wafer` visible (LL↔PM); atm `atm-carried-wafer` visible
(LP↔LL). The atm robot is a linear slide/reach mechanism, so its arm
rotation stays 0 — judge it by carried-wafer visibility / position.

## Continuity invariant: never drop an out-of-carrier wafer
Requirement: once a wafer leaves its carrier (load-port FOUP) until it
is back in a carrier, it must always be shown somewhere — even if just
the last known location. Implemented with a persistent class variable
`LastKnownLocations` (Dictionary waferName -> last census entry),
lazily inited via `SnowglobeToolState class>>lastKnownLocations`. In
`liveWaferCensus`:
- loc is a Port (`startsWith: 'Port'`) => in carrier; `removeKey:` and
  don't emit (carrier display handles ports).
- loc non-nil, non-port => fresh entry; store in lastKnown; emit.
- loc nil/blank (indeterminate handoff) => emit the stored lastKnown
  entry if present (bridges the gap), else skip (never seen).
- prune lastKnown keys for wafers no longer in allMaterial.
Verified end-to-end (continuity recorder polling tool-state.json):
`— ATM LOCK:LLB VTM PM1 VTM,PM1 VTM LOCK:LLB ATM —` with NO `—` gap
between leaving and returning to the carrier. The `VTM,PM1` overlap is
the PM-exit handoff (vtm carries while PM register still reads
waferPresent briefly) — acceptable.

## Compile gotcha (now fixed in LamMCPCompileTool)
`mcp_2300-ui_compile`'s `behavior` arg was being ignored, landing
class-side methods on the transient AgentSession class. After the
user's fix it honors `behavior`. `Snowglobe.SnowglobeToolState class`
metaclass ref was 1746321905 this session (per-session, don't reuse).
