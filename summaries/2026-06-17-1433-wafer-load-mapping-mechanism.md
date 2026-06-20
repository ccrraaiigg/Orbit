# Wafer-load + mapping mechanism (2300-tmc) — compaction summary

(Full pre-compaction summary preserved below.)

## 1. Conversation Overview

**CURRENT ACTIVE TASK:** User authorized a clean carrier-load cycle on Port1:
deactivate sensor → confirm #NoCarrier → set 5-wafer map → activate sensor →
watch it map and hand off to the host (and animate the VR twin). Mid-execution.

**OVERARCHING DEMO GOAL:** put an LP unit online, load a cassette of five wafers,
put an LL unit online, and flow all five wafers — shown on both the 2300 sim and
the VR twin simultaneously. Methodology preference: use only the 2300-ui MCP tools
and make things happen in the backend image via CTROC (2300-backend tools also OK).

## 2. Technical Foundation

Multi-image VisualWorks: 2300-ui (15070, CTC/host, GUI), 2300-backend (15072,
material mgmt/scheduling), 2300-tmc (15200, LamEmbeddedImage = TMC port controller,
real port resources + atmospheric robot + simulated sensors), Caffeine (SqueakJS,
Keep). 2300-tmc role ref 1639124361 (MethodCompilation, SharedVariableAccess).

Canonical Port1 access in TMC image:
```smalltalk
| reg atm port lp |
reg := CWRegistry current.
atm := (reg instVarAt: 1) at: #substrateReaderOwner.
port := (atm instVarAt: (atm class allInstVarNames indexOf: 'portRepsOC')) first.
lp := port loadPort.
```
port class = LamDominoPortResourceFA; lp class = LamParallelPortDoorOpenerV11.
cassetteType='PDO', pdoOption=#BrooksV4, portMaxSlot=25.

Operator simulation levers (PDO hardware sim): `lp simulatedPodPresent` sets
#FoupPlaced + #PlatformOccupied sensors (→ NewCarrier); `lp simulatedPodAbsent`
clears them (→ NoCarrier). Requires lp isSimulated=true.

## 3. The mapping mechanism (NEWLY REVERSE-ENGINEERED THIS SESSION)

Carrier processing is **host-driven (E87)**:
NewCarrier → (ID read; CarrierStateTagIDE87='WAITING FOR HOST')
→ host ProceedWithCarrier → `startMappingCarrierAtPortMaterialLocationNamed:`
(E87Route) → `getMaterialMap` → `performMaterialMap` → `performMaterialMapAction`
(opens loadport door, openWaitPDO) → `mapWafersAndGetResult`.

`LamDominoPortResourceFA>>mapWafersAndGetResult` calls `checkForSimulatedMapping`
then `super mapWafersAndGetResult`.

`checkForSimulatedMapping` is a **NO-OP for this BrooksV4 PDO** (only acts when
isSimulatedPDOMapping=true, i.e. TDKE4 loadport with mapWaferByPort enabled).

`LamDominoPortResource>>mapWafersAndGetResult` branch logic:
- if `disableMapping` → resultString := `self simulatedMappingArray` (reads
  #SimulatedMapping variable = our '1111100000000000000000000' = 5 wafers!).
- else if `isMapWaferByPort` (FALSE here) → loadPort mappingResultByPort.
- else (THIS PDO) → `resource := CTAutoProxy newNamed: #AtmArm`;
  `resultString := resource performCompleteMapAt: aPosition`.
  i.e. the **atmospheric robot (AtmArm) performs the map** — REQUIRES AtmArm ONLINE.

THEREFORE:
- #SimulatedMapping is ignored for this port UNLESS disableMapping=true.
- Real mapping needs the AtmArm robot online (currently OFFLINE).
- Two routes to a 5-wafer map: (a) set port disableMapping=true so simulatedMappingArray
  (#SimulatedMapping) is used (no robot), or (b) bring AtmArm online and let it map.

## 4. Live state at summary time (Port1, 2300-tmc)

state=#NewCarrier, isPodPresent=true, carrierID='', carrierIDStatus=255,
carrierSlotMapStatus=255, mappingResultByPort='', carrierMaterial=nil,
#SimulatedMapping='1111100000000000000000000'. isManualMode=true (AgvMode='MANUAL'),
mode=#Production. Port2/Port3=#OffLine. GUI (Process tab) confirms: Port1 panel
State=NewCarrier / Previous State=NoCarrier, Cassette Present DI=true, Wafer
Protrusion DI=false, Execution Carrier ID/Flow/Lot all empty. Schematic shows Port1
purple cassette labelled NewCarrier; TM robot center red circle-slash (OFFLINE);
PM1–PM4 red; Port2/3 OffLine. So the entire transport is offline.

`isManualMode` reads #AgvMode='AUTO/MANUAL' (AGV/AMHS automation) — NOT the right
lever for a manually placed FOUP; MANUAL is correct for operator-driven loading.

## 5. Blocker / decision point

Even a perfect map won't flow wafers: AtmArm/TM robot, load locks, and PMs are all
OFFLINE. Mapping itself needs AtmArm online (unless disableMapping route). Bringing
transport hardware online is a significant live-tool mutation → confirm with user.

Two options to present:
- A (lighter): host-emulate ProceedWithCarrier + bring AtmArm online → carrier maps
  → 5 wafers populate Execution Carrier ID + slot map. Proves "loaded+mapped 5
  wafers" but no transfer.
- B (full): bring AtmArm + a load lock + ≥1 PM online, create a lot (Lot Operation
  tab) with recipe/flow, run full flow so wafers move — visible on sim + VR twin.

## 6. Steering reminders

NEVER reload page / restart server/MCP without consent. NEVER remove #embeddedSqueak/
#dashboard/#status/#agent-mouse-cursor; scope cleanup with :not(#embeddedSqueak).
Don't hide/collapse VR twin; screenshot full viewport. Playwright mouse → call
window.__agentMouse(x,y). Deferred MCP tools need tool_search first. Don't enumerate
all classes. Project memories → ./memories/ (workspace). 2300 unhandled-exception
alarms are expected debris. Shared page id cbc5fde5-5649-40c9-9787-13fec9630c09,
URL http://localhost:8089/orbit.html?backend=192.168.1.140. Console buffer via
window.__consoleBuffer. Transcript:
/Users/craig/Library/Application Support/Code/User/workspaceStorage/f2e99a27b072f4f84da16eb0ecb08967/GitHub.copilot-chat/transcripts/e702fc90-5e48-4e76-9415-fee292435d23.jsonl
