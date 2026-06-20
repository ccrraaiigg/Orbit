# Three-image carrier / wafer-flow demo — session summary (2026-06-17)

## Primary objective (in progress)
"Put an LP unit online, load it with a cassette of five wafers, put an LL unit
online, and flow all five wafers. Show it on both the 2300 sim and the VR twin
simultaneously."

Methodology constraint: prefer the `2300-ui` MCP tools + CTROC; `2300-backend`
MCP is an acceptable fallback. Do NOT collapse/hide the VR twin window (it does
not overlap the sim window); recreate it at inner-morphic-window geometry
top 817 / left 1001 / width 760 / height 514 / z-index 40.

## Key architectural discovery: THREE VisualWorks images
- **UI image** — the "Lam 2300 UI" window. Has `mcp_2300-ui_*` tools.
  Capabilities: SharedVariableAccess, MethodCompilation, AgenticMemoryAccess.
- **Backend image** — `C:\Lam\Install\Backend\lamBackend.im`, material
  management / scheduling. Has `mcp_2300-backend_*` (port 19072). Role ref
  obtained with `["MethodCompilation","SharedVariableAccess"]`.
- **CTC/M controller image** — the "CTC/M VisualWorks" window (`lamCTC`).
  The simulator, scheduler, `Port1` resource, `materialManager`, and
  `carrierSimulationSetupPolicy` are LOCAL here. **No MCP targets this image.**
  Both UI and backend reach it only via `CTAutoProxy` / `CTRemoteProxy`.

### Proxy semantics
`CTRemote import: #Port1` / `CWRegistry current resourceNamed: 'Port1'` return
proxies that forward a whitelisted exported protocol. Distinguish:
- **nil return** = selector forwarded but the remote answer is absent/nil.
- **"Message not understood" (DNU)** = selector is NOT exported.
Forwarded: `addArtificialWaferUsing:`, `carrierSimulationSetupPolicy` (→ nil),
`realResourceName`. Unexported (DNU): `isSimulated`, `getSimulatedSlotMapArray`.

## Negative results established this session
1. **Static material injection does NOT drive the visible animation.**
   `materialManager addArtificialWaferUsing:` (forwarded to the real CTC/M
   material manager) returns 'ok' but no wafer appears in the UI Operate
   animation OR the twin, and the wafer is not retained in `presentMaterial`
   (size 0 afterward). Only a genuine scheduler-driven flow animates the views.
2. **`carrierSimulationSetupPolicy` is nil via proxy.** It is created only when
   the loadport simulation subcanvas is properly active inside the CTC/M image;
   `becomeActiveIn:at:` and `portResourceChanged` only READ it. Blocked from
   UI/backend.
3. **UI image restarted mid-task**, reverting my canonical `SnowglobeToolState`
   rewrite (it was never filed to disk). `materialIdsAt:` is gone; the original
   `currentJSON` (which reads CTROC registers via `CTRemote import:`) is back.

## Reframe (helpful)
The original twin reads CTROC registers BECAUSE a genuine wafer flow updates
those registers (that's how the CTC/M controller reports tool state). The
canonical rewrite was only a workaround for injecting wafers OUTSIDE the real
flow. So for a genuine cassette+Start flow, the original CTROC-reading twin
should animate naturally — no rewrite needed.

## Remaining genuine paths
a. Drive the operator UI via Playwright in the streamed 2300 canvas: bring
   ports online, open the loadport simulation / carrier-setup tool, place a
   5-wafer cassette, press Start. Scheduler flows wafers → UI animates → CTROC
   registers update → twin animates. Faithful but requires careful canvas
   clicking, and may still hit the carrier-sim-policy wall (policy lives in
   CTC/M).
b. User starts an MCP server inside the CTC/M controller image → direct access
   to the simulator/scheduler/policy.

## Cleanup done
- Stray `DEMO-1` injection not retained (no removal needed; presentMaterial=0).
- Cleared `#UnhandledException` alarms in UI image (incl. `#materialIdsAt:` DNU
  debris).

## UPDATE: 2300-ui IS the CTC image (user correction) — carrier-sim path traced & blocked
Confirmed: 2300-ui = CTC/Host image. `LamMaterialManager`, `LamPortResourceRepresentative`
reps, and `LamCTCImage` are all LOCAL. `LamCTCImage current isSimulated = true`; all 10
sub-images (TMCImage, PM1-4Image, HostImage, BackendImage, UISImage, ServiceImage,
DDSImage) are flagged `simulated=true`.

### The genuine cassette-load API (clean, found)
`CWSimulatedCreateAndLoadCarrierCommand` (package CWSimulatedCarrierCommands):
```smalltalk
cmd := CWSimulatedCreateAndLoadCarrierCommand
    newForCarrierNamed: #DEMOCAR1 slotMap: anArrayOf25 portResourceNamed: #Port1.
cmd execute.   "true/false; cmd errorMessage on failure"
```
Slot constants: `PositionalContainer slotEmpty = 1`, `slotCorrectlyOccupied = 3`.
Port1 wafer capacity = 25. `execute` does: validateUniqueness → initializePortResource
→ validateLoadPortState → simulateCarrierPlacement (policy setSlotMap/placeCarrier)
→ notifyMaterialManager → startLoadingCarrier → waitForNewCarrier (20s timeout).

Established working low-level pattern (from `LamMaterialRedirectBufferWaferService>>
simulatorTest_QuickRecover_TwoPort`):
```smalltalk
p := CTRemote import: #Port1.
p carrierSimulationSetupPolicy removeCarrier;
   setSlotMapFromCollection: (p getSimulatedSlotMapArray); placeCarrier.
p loadCarrierUsingLotID: 'lot'.
```

### THE BLOCKER (definitive)
Every port's `carrierSimulationSetupPolicy` is **nil** — via the rep AND via direct
`CTRemote import: #Port1` (a CTRemoteProxy). Command fails: **"Port resource named
Port1 is not simulated."** The embedded Port1 resource also does NOT understand
`getSimulatedSlotMapArray` / `isCarrierPlaced` / `performSimulatedActiveE84SingleHandoff`
(all 0 implementors in CTC image → they live on a *simulated-port-resource subclass* in
the embedded TMCImage, and the running Port1 either isn't that subclass or doesn't export
them through CTROC). The "simulated" image flag means controller EMULATION, not loadport
carrier-simulation. So loadport carrier-simulation is NOT active for these ports in this
running config, and cannot be enabled from the CTC or Backend image via MCP/CTROC.
`CWPFPortResource` class itself is not even loaded in the CTC image (embedded-only).

### Implication / open decision for user
Pure CTROC/MCP wafer injection that FLOWS is blocked by the missing carrier-sim policy.
Options: (A) enable loadport carrier simulation in the TMC image config (needs user /
tool restart in carrier-sim mode — outside safe MCP reach); (B) find an alternate
simulated wafer source (host job / AMHS) — not yet found; (C) accept register-driven
visualization (non-flow) for the twin.

## Standing reminders
- Re-arm display feed after page reloads: `Snowglobe.SnowglobeWindowDisplayPolicy
  initialize` (in 2300-ui).
- Recreate VR twin at top 817 / left 1001 / width 760 / height 514 / z-index 40,
  caption "Lam Research 2300 — VR digital twin". Screenshot FULL viewport; do
  not hide/collapse it.
- Never reload the whole Orbit page or restart the server/MCP without consent
  (reloading just the child VR iframe is fine).
- Deferred MCP tools need `tool_search` first. Don't enumerate all classes.
- Shared Playwright page id: cbc5fde5-5649-40c9-9787-13fec9630c09.
