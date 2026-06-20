# 2300-tmc MCP server — what it connects to & carrier-sim findings

The `2300-tmc` MCP backend (mcpPort 15200, added to `BACKENDS` in
`website/src/extension-impl.js`) connects to the **TMC embedded
port-controller image** = `LamEmbeddedImage`.

## How to confirm the image identity
- `CWRegistry current` exists, class `CWRegistry`, but
  `CWRegistry current machine` is **nil** (no machine here).
- `CWRegistry current` instVar `registrants` (a Dictionary, instVarAt: 1)
  has the giveaways: `#semiE39Handler -> LamSEMIE39EmbeddedHandler`,
  `#image -> LamEmbeddedImage`.
- `LamCTCImage current` DNUs `ctcImageName` and `System imageName` DNUs —
  this is NOT the CTC/host image (that's 2300-ui).

## What this image hosts (registrants dict, 17 entries)
- `#substrateReaderOwner -> AtmosphericTransportResourceFA` (printString
  `AtmArm`) — the EFEM/atmospheric transport robot.
  - transportMechanism = `LamRelianceTransportMechanism` (printString `TX`).
  - instVar `portRepsOC` = OrderedCollection(Port1 Port2 Port3) — the real
    loadport objects.
  - instVar `locations` = (AtmArm-EndEffector11).
- E39/E90 handlers, alarm/event/variable/option handlers, IO server,
  SwazooServer (HTTP/WebDAV), memory monitors.

## The carrier-simulation root cause (definitive)
The real loadports are class **`LamDominoPortResourceFA`** (Domino FA real
hardware driver). For all three:
- `carrierSimulationSetupPolicy` = **nil**. The reader
  (`PortResource>>carrierSimulationSetupPolicy`, package
  `CWPortResoruceCarrierSimTools`) is
  `^self policyWithKey: #carrierSimulationSetupPolicy ifAbsent: [nil]`.
- There is **no `carrierSimulationSetupPolicy:` setter anywhere**
  (0 implementors, 0 senders). The policy is built ONLY from SysConfig,
  and only when the port is configured simulated.
- The Domino FA ports respond to NONE of the sim resource-role methods
  (`simIsCarrierPlaced`, `simPlaceCarrier`, `simRemoveCarrier`,
  `simCarrierID`, `setSlotMapFromCollection:forResourceNamed:`,
  `slotMapForResourceNamed:`, `simOpenDoor`). They DO respond to `loaders`.

The `CWCarrierSimulationSetupPolicy` class (impl of `placeCarrier`,
`setSlotMapFromCollection:`) and the `LamNTMSimulatedPortResource` /
`LamSTMSimulatedPortResource` / `LamNTMPortResource` / `LamSTMPortResource`
classes exist in this image but have **0 instances** — they belong to a
DIFFERENT (NTM/STM) port family that this tool's config does not use.

### Conclusion
Carrier simulation via `CWCarrierSimulationSetupPolicy` is NOT wired for
these Domino FA ports — it was never SysConfig-configured and the ports
can't play the sim resource roles. The "isSimulated" image flag is
controller emulation, not loadport carrier simulation. Injecting a policy
at runtime won't work because the port can't simulate placement/mapping.
A genuine 5-wafer flow must come from real material movement
(host/scheduler driving the AtmArm), not carrier-sim injection.

## THE REAL SIMULATION PATH (how a human flows wafers on THESE Domino FA ports)
Carrier sim here is NOT policy-based — it is **sensor + variable level**,
driven by the ControlWORKS **Hardware Simulator** framework (embedded-image
only). Evidence from live Port1 in the TMC image:
- `port cassettePresentSensor` = `CassettePresent_DI`, class
  **`LamSimulatedBinarySensor`** (a SIMULATED digital sensor), `isActive=true`.
- `port (variableNamed: #SimulatedMapping) value` = `#'1111111111111111111111111'`
  (25 chars, `$1`=wafer present, `$0`=empty), `portMaxSlot`=25.
- `port state` = `#OffLine`; `cassetteType`='PDO'; `pdoOption`=#BrooksV4;
  `loadPort isSimulated`=true; `isMapWaferByPort`=false →
  `isSimulatedPDOMapping`=false (BrooksV4 not in
  `typeOfPDOsThatHaveMappingCapability` = TDKE4/BksVision/AsystFalcon/
  Cymechs/Sinfonia...). So per-port simulated mapping is off; mapping goes
  through the normal sensor-array path.

Trigger chain when the cassette-present sensor goes active:
`cassettePresentSensorSensed` → `processCassettePresent:` → posts
Ergo200 carrier-present event, and if state is `#NoCarrier` sets it to
`#NewCarrier` → `handleCarrierReceived:atLoadPort:` →
`carrierNamed:sensedAtLoadPort:`. Then host/scheduler loads + flows.

The simulated sensor value is set via `BinarySimulator>>value:` /
`HardwareSimulator>>value:` (i.e. the Hardware Simulator Browser), NOT a
dedicated "place carrier" operator method (none exists:
`simulateCarrierArrival`/`setSimulatedValue:` have 0 implementors).

### Operator/runtime procedure (what a human does)
1. Bring the loadport online (operator GUI; Port1 currently OffLine).
2. "Place a FOUP" = drive the simulated cassette-present sensor active
   (Hardware Simulator Browser, embedded image). Already active here.
3. Slot contents come from the per-port `#SimulatedMapping` variable —
   operator edits it (1/0 per slot) to choose wafers.
4. Sensor-active → port NoCarrier→NewCarrier → carrier ID read + mapped.
5. Host/CTC scheduler loads the carrier, AtmArm moves wafers to the load
   lock (bring LL online too) → chambers → back to port.

### Hardware Simulator Browser (ControlWORKS Dev Tools Guide §2.4, fp14-18)
Embedded-image-only developer tool. Replaces sensor/actuator levels with
simulated versions and lets you script their behavior + modify values live
(StatusViewer). Four simulator classes: SimulatedAnalogActuator,
SimulatedAnalogSensor, SimulatedBinaryActuator, SimulatedBinarySensor.
`HardwareSimulator startUp`/`shutDown`. Supports cloning simulators between
machine resources. Docs read via
`DocReader new readPage: N ofFile: 'Development-tools.txt'` — DocReader is in
the Snowglobe package; the `docs/` folder lives on the 2300-ui host.

## VERIFIED runtime levers + full mapping chain (2026-06-17)
The actual operator simulation levers on the PDO loadPort
(`LamParallelPortDoorOpenerV11`, named `PDO`):
- `lp simulatedPodPresent` — sets BOTH #FoupPlaced + #PlatformOccupied
  sensors → `isPodPresent`=true → `processCassettePresent:` promotes
  **#NoCarrier → #NewCarrier** (only from NoCarrier!). Verified live.
- `lp simulatedPodAbsent` — clears both → **→ #NoCarrier**, carrierID=''.
- Gotcha: bringing the port online with a pod already present parks it at
  **#OldCarrier** (idle, no flow). Remove first (→NoCarrier) then place
  (→NewCarrier). `LamDominoPortResourceFA>>unload` = the "Cancel Carrier"
  Operate action.
- `port isManualMode` reads `#AgvMode='MANUAL'` (AGV/AMHS automation) — NOT
  the lever for a manually placed FOUP; MANUAL is correct for operator load.

### Mapping is host-driven (E87) — full chain
NewCarrier → ID read (CarrierStateTagIDE87='WAITING FOR HOST') → host
**ProceedWithCarrier** → `startMappingCarrierAtPortMaterialLocationNamed:`
(E87Route) → `getMaterialMap` → `performMaterialMap` →
`performMaterialMapAction` (opens door, `openWaitPDO`) →
`mapWafersAndGetResult`.

`LamDominoPortResourceFA>>mapWafersAndGetResult` = `checkForSimulatedMapping`
(NO-OP here: only acts if isSimulatedPDOMapping=true) + `super
mapWafersAndGetResult`.

`LamDominoPortResource>>mapWafersAndGetResult` slot-map source branches:
- `disableMapping`=true → `simulatedMappingArray` (reads **#SimulatedMapping**
  = our 5-wafer string '1111100000000000000000000'). NO robot needed.
- `isMapWaferByPort`=true (FALSE here) → loadPort mappingResultByPort.
- ELSE (THIS BrooksV4 PDO) → `CTAutoProxy newNamed: #AtmArm` →
  `performCompleteMapAt: aPosition`. The **AtmArm robot performs the map** →
  REQUIRES AtmArm ONLINE.

KEY: #SimulatedMapping is IGNORED for this port unless `disableMapping`=true.
Two routes to a 5-wafer map: (a) set disableMapping → #SimulatedMapping used
(no robot), or (b) bring AtmArm online and let it map.

### Blocker for real flow
Even a perfect map won't move wafers: AtmArm/TM robot, load locks, and all
PMs are OFFLINE. Mapping needs AtmArm online (unless disableMapping route);
flowing wafers needs the whole transport online + a lot/recipe (Lot Operation
tab). Bringing transport hardware online is a significant live-tool mutation
— confirm with user first.

## CTC (2300-ui = HostImage) flow/scheduler mechanism (2026-06-17)
The machine `Lam300Start` (class `LamMachine`) lives in the 2300-ui HostImage
(`CWRegistry current machine`). Rich scheduler: instVars `materialManager`,
`scheduler`, `processJobManager`, `recipeManager`, `recipeExecutor`,
`transferManager`, `portResources`, `processResources`, `transportResources`,
`bufferResources`, `lotOperate`, `operatePage`.

Resource snapshot (name -> state): PMs PM1-4Rep -> #Vacuum (idle-ready, NOT
aborted — GUI "PMn Abort" is a button label); AirLock1/2Rep -> #Standby;
CoolStationAL1Rep -> #Standby; AtmArmRep + TransferChamberRep -> #OffLine;
AlignerRep + WaferBufferStation1Rep -> #OffLine; Port1Rep -> #NewCarrier (CTC
SEES our mapped carrier!), Port2/3Rep -> #OffLine.

**Online**: `(machine resourceNamed: #X)` uses realResourceName keys, NOT the
rep `name` (#AtmArmRep). Iterate `machine transportResources` etc. directly.
Each rep responds to `bringOnline` (guarded by `isOnline`). BUT all reps
already report `isOnline=true` while `state=#OffLine` — logical-online vs
operational-state distinction. AtmArm mapped successfully at state #OffLine, so
#OffLine may NOT block scheduling. `bringOnline` (LamTransportResourceRepresentative)
delegates to `self represents bringOnline` (the real resource via CTRemote).
AtmArmRep class = LamATMRepresentative, realResourceName #AtmArm; also has
`goToIdleMode`.

**Recipes/flows EXIST** abundantly: `machine recipeManager
allFlowsInvolvingProcessResource` returns hundreds (e.g. simple per-PM flows
`#ARIA_FLOW_PM1`..`#ARIA_FLOW_PM4`). `selectedWaferFlow`=nil (none selected).
`recipeManager recipeDatabaseManager` = LamNewRecipeDatabase.

**Start-job paths (all converge on `machine execute: anMCG input: inPort
output: outPort`)**:
1. HOST: `remoteStartCmd: aSEMIGEMRemoteCommand` → `startProcessingDefaultFlow:
   withInputPort:withOutputPort:`. Command carries named params 'PPID' (flow),
   'CARRIER', 'LOTID', 'S_E_SLOTS' (wafer slots), 'PJSTART'. Building the
   SEMIGEMRemoteCommand needs a SECS S2F41 message (setParametersFrom:) — fragile.
2. OPERATOR GUI: `LamUILotOperations>>executeMaterial:` (Lot Operation "Start"
   button) → uses `findCWMCGUsingTable` (MCG already in the GUI material table,
   created when operator assigns a flow to the mapped carrier) → guards:
   isPortReadyForStart:, allSequenceExistInDataSet:, carrier-ID dup check →
   `execute:input:output:`. GUI-state dependent.
3. TEST/DIRECT: `startProcessingDefaultFlow` (no-arg) builds its OWN carrierID
   'Lam-Carrier N' + 25 wafer entries (ignores map!) via `LamSEMIGEMERCData new`
   + `makeWaferEntryForSlot:waferID:process:`, MCG via `recipeExecutor
   createMaterialCommitGroupWith:using:#newOn:with:onLot:`, port =
   `newCarriersPortResourceName` (the NewCarrier port = Port1), then execute.
   Flow from `self ppExecName`. PROBLEM: 25 wafers vs physical 5 → robot picks
   from empty slots → alarms; also creates fresh carrier conflicting with the
   existing NewCarrier material on Port1.

**Cleanest precise-5-wafer path**: replicate the no-arg logic but (a) add only
slots 1-5, (b) explicit flow #ARIA_FLOW_PM1, (c) bind to the existing carrier
material rather than a fresh one, (d) Port1 in+out. Then `machine execute:`.
Risk: must bind to existing NewCarrier material (auto-created by
materialArrivalSensed) or remove it first; firing a conflicting job can cascade
alarms on the live tool — confirm approach before firing.

## Flow DB is partial + hardware-mismatched (2026-06-17)
This image's 2280 process flows were authored for OTHER tool configs:
- AutoPM/ARIA flows reference generic recipes NOT on disk (e.g.
  `PM1/Recipes/Tuning_Recipe_Generic` → execute fails
  `CWRecipeManagerRecipeIncomplete ... #Tuning_WAC_Generic not found`).
- POR flows reference real recipes but for resources we DON'T have
  (e.g. `CoolStationAL9`, `AirLock3`) → `CWRecipeExecutorResourceNotAvailable`
  or a `createStepParametersFrom:atIndex:` NonIntegerIndex halt.

**Our actual hardware** (`machine {process,transport,buffer,port}Resources
collect: realResourceName`): AirLock1/2, Aligner, AtmArm, ATP1,
CheckWaferStation, CoolStationAL1-4, CoverWaferStation, EMS1, MetrologyICD,
Pass1/2, PM1-4, Port1-3, SRDi1, SRM1, TransferChamber, WaferBufferStation1/2.

**Fast flow filtering** (avoid the SLOW recursive `allReferencedRecipeNames`
— it loads every recipe from disk and times out / gets cancelled):
- `flow requiredResources` (IdentitySet, FAST) — filter ⊆ our hardware.
- `flow referencedRecipeNames` (FAST, non-recursive) — direct recipe paths
  `Resource/Recipes/Name`.
- Scanning ~80 flows with these is quick (no disk recipe load).
**COMPATIBLE + recipe-complete flow found**: `AA_10point_TESC_Cal02_PM2`
(PM2 10-point TESC calibration), requires only `#AirLock2 #AtmArm #PM2
#TransferChamber`, references existing recipe `PM2/Recipes/AA_EJ_10point_TESC_Cal2`.
Its MCG builds successfully (resources available).

## The low-level `execute:` path needs full operator/host setup (2026-06-17)
Hand-building an MCG + `machine execute: mcg input: #Port1 output: #Port1`
(via `recipeExecutor createMaterialCommitGroupWith:using:#newOn:with:onLot:`
+ `makeWaferEntryForSlot:waferID:process:`, specs are `MaterialSpecification`
responding to `process`/`id`/`slotNumber`, NOT waferID/carrierID) fails with a
chain of unset-field DNUs:
- `inputLocationName`/`outputLocationName` nil → set via
  `port portMaterialLocationName` (= `#Port1-PTML`).
- After that, still `nil isEmpty` deep in
  `CWRecipeExecutor>>buildProcessJobsFor:...` / `runMaterial:` /
  `startProcessing:input:output:`.
The machine's OWN "testing" entries `startProcessingDefaultFlow` /
`startProcessingDefaultFlowRefactored:` are explicitly marked incomplete
("testing version ... a better version must be developed"), also skip
locations, hardcode 25 wafers, and use `newCarriersPortResourceName` (DNU
here) — so they'd hit the same failure. The ONLY fully-wired starts are
`LamUILotOperations>>executeMaterial:` (operator GUI, needs `findCWMCGUsingTable`
= an MCG already in the operate-page material table) and `remoteStartCmd:`
(host, needs a SEMIGEMRemoteCommand from a SECS S2F41). Pivot options for a
visible demo: (A) wire the operate-page model so executeMaterial: works, or
(B) drive AtmArm/TransferChamber directly via CTROC (matches the user's stated
"make things happen via CTROC" methodology, most reliable for twin animation).

## CWCarrierSimulationSetupPolicy (from class comment)
Owns a resourceMap of role->CTROCProxy. Roles: `#carrierPlacementResource`
(simPlaceCarrier/simRemoveCarrier/simIsCarrierPlaced),
`#carrierIDResource` (simCarrierID/simCarrierID:),
`#slotMapResource` (setSlotMapFromCollection:forResourceNamed:/
slotMapForResourceNamed:), `#manualDoorPositionResource`. Configured in
SysConfig under a CWPFPortResource's `#policies` dict with keys
`name`, `type->nil`, `simulationType->#CWCarrierSimulationSetupPolicy`,
optional `simResources` sub-dict. Slot values use
`PositionalContainer slotEmpty` / `slotCorrectlyOccupied`.
