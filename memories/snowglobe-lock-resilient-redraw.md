# Lock-resilient redraw for Snowglobe-mirrored windows

## Problem
When Windows 11 is locked, certain remote-UI feedback didn't reach the
page — e.g. the teal connection-highlight (drop target) when dragging a
resource over a flow connection in the Lam 2300 WaferFlow editor.

## TWO independent bugs, both required fixing
Confirmed by tracing a real locked drag. Symptom: cursor augmentation
(page-driven) worked, but no teal highlight.

### Bug A — drop-target dispatch never fired under lock (the dominant one)
The GE drag is a Smalltalk modal loop (`GEDragDropManager>>doDragDrop` →
`DragDropManager>>doDragDrop` → `selectionTracker startUp`), NOT OS
OLE drag-drop. The tracker (`UI.DragDropManagerTracker>>mouseMovedEvent:`)
DID receive mouse-moved events under lock (traced 311 calls). But it did:
```
window := Screen default windowAt: startPoint.
window == self currentWindow ifTrue: [... mouseMovedTo: startPoint in: window]
                             ifFalse: [... startDragInNewWindow: window ...]
```
`Screen default windowAt:` asks the OS which window is under the global
point. **When the session is locked the OS returns nil** (secure desktop
not queryable), and the tracker's `currentWindow` (= `controller
currentWindow`, set via the same OS lookup) was also nil. So `window` was
nil and `mouseMovedTo:in: nil` bailed (`win==nil ifTrue:[^self]`) — no
hit-test, no `dragEnter:`, no `draggingEntered:`, no highlight.

FIX: fall back to the drag's **source window** when the OS can't report
one. `UI.DragDropManagerTracker>>contextWindow` (= `sourceData
contextWindow`) is the originating GE editor window, known independently
of the OS. Patched `mouseMovedEvent:`:
```
window := Screen default windowAt: startPoint.
window isNil ifTrue: [window := self contextWindow].
```
The normal first-move else-branch (`startDragInNewWindow: contextWindow`)
then sets `currentWindow` and dispatches `dragEnter`. Hit-test is
`ApplicationWindow>>findObjectInterestedInDropAt: pt - inputOrigin`; under
lock the forwarded `globalPoint` was already correct (window near screen
origin) so coords lined up. This is a base-framework method (package
Interface-Events-Trackers) — the fix benefits ALL VW drag-drop under lock.

### Bug B — even when dispatched, the redraw bypassed the page (below)

## Root cause (Bug B)
`VisualPart>>invalidateRectangle:repairNow:true` propagates damage up to
`ScheduledWindow>>invalidateRectangle:repairNow:forComponent:`. When the
window's sensor has **no pending damage**, that method takes a
direct-draw else-branch: it grabs `self graphicsContext` and draws the
component straight to the screen GC. It never calls `displayDamageEvent:`,
so the Snowglobe display policy's capture hook (`displayDamageList:in:`)
never fires — nothing is broadcast to the page. That direct screen draw
is a no-op when the OS screen is locked, so the highlight is lost.

By contrast, the **broadcast path is lock-independent**: it re-renders
the whole window to an in-memory `Pixmap` (`window displayOn: pixmap gc`)
and ships the damaged rectangle's pixels. That path is reached via
`displayPendingInvalidation` → `displayDamageEvent:` →
`damageRepairPolicy displayDamageList:in:` (the Snowglobe policy when
`window exposesToRemoteUI`).

## Fix (all on the remote VisualWorks "2300-ui" image)
Added a class-side helper that forces damage through the broadcast path
(no coordinate math needed — the normal propagation translates the
view's local rect to window coords for us):

`Snowglobe.SnowglobeWindowDisplayPolicy class>>broadcastRedrawOf: aView`
```
| win |
win := aView topComponent.
win isNil ifTrue: [^self].
aView invalidateRectangle: aView bounds repairNow: false.
win displayPendingInvalidation
```
- `repairNow: false` only queues the (window-coords) damage into the
  window sensor; `displayPendingInvalidation` then flushes it through
  `displayDamageEvent:` → Snowglobe → schedule → broadcast pixmap render.

Patched `GEActionWithConnectionView>>draggingEntered:` and
`>>draggingExited:` (package GraphicalEditorViewApp) to call
`Snowglobe.SnowglobeWindowDisplayPolicy broadcastRedrawOf: self` right
after the existing `invalidateRectangle:repairNow:true`. Additive — the
original immediate draw is preserved for the unlocked case.

CWActionWithConnectionView (the live connection figure) inherits these
methods, so the teal highlight is now lock-resilient.

## Validation (locked, real drag)
Traced a real locked drag: 311 `mouseMovedEvent:` (winAt=nil, fell back
to ApplicationWindow 225), 9 ENTER + 9 EXIT on connection views, 18
`broadcastRedrawOf:` each showing dmg0=false→dmg1=true→dmg2=false
(proving the direct-draw branch would have bypassed Snowglobe and that
the helper rerouted through it). Teal highlight appeared on the page.
Also validated unlocked earlier by setting `cursorOver:true` on all live
CWActionWithConnectionView and calling `broadcastRedrawOf:` alone.

## Notes
- BOTH fixes are needed: Bug A makes `draggingEntered:` fire under lock;
  Bug B makes its redraw reach the page under lock.
- `broadcastRedrawOf:` is a general mechanism; reuse it for any "force a
  view's region to the remote UI regardless of lock" need.
- Purely VW-side changes; persist in the remote image. No Caffeine/page
  changes, so no VSIX rebuild needed for THIS fix. (The earlier
  cursor-augmentation Caffeine-side patch is still pending a rebuild to
  persist.)
- Instrumentation used a temporary `SnowglobeTealTrace` global
  (OrderedCollection); removed after validation. All four methods
  restored to clean production form.
