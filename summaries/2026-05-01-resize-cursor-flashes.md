1. Conversation Overview:
- Primary Objectives: The user’s initial report was: “On a morphic-window, the resize cursor hover transitions only last for about a pixel after the mouse transits either side of a border.” The overarching goal is to make `<morphic-window>` resize cursor hover behavior usable and continuous, without one-pixel flashes, while keeping resize drag working.
- Session Context: Work happened in the Orbit project at `/Users/craig/me/behavior/forks/orbit`, active web page `http://localhost:8089/lam.html` (browser page ID `8a63f471-45f8-49e1-aa7f-8c09e0230d24`). The relevant file is `website/public/js/components/morphic-window.js`.
- User Intent Evolution: After the first expansion, the user said: “I reloaded the page. The cursor flashes still happen, but at points further away from either side of the border.” After a dwell-delay attempt, the user said: “No change.” Then: “When approaching from the left of the right border, there are three flashes. When approaching from the right of the right border, there is one flash. Each flash lasts for about one pixel.” After an overcorrection suppressing hover cursors, the user said: “Now the resize cursors are completely gone.” The final implemented direction is: restore resize hover cursors, but make them a single continuous document-level geometry-driven region, not native cursor changes from invisible handles.

2. Technical Foundation:
- Web Component `<morphic-window>`: Implemented in `website/public/js/components/morphic-window.js`; wraps Morphic/SqueakJS canvas/iframe content in a draggable, resizable window with titlebar controls.
- Active Page / Livecoding: `http://localhost:8089/lam.html`; use Playwright only for page manipulation. Console instrumentation was installed earlier. After script changes, keep live script, live DOM objects, and external script file in sync.
- Hot Reload Pattern: Use `customElements.get('morphic-window').hotReload()`; Web Component class names are not globally accessible. `hotReload()` fetches `js/components/morphic-window.js`, copies prototype/static methods onto the registered class, then rebuilds all `morphic-window` instances.
- Final Resize Architecture: Resize hover/pointerdown is controlled by document-level geometry detection, not pointer events on transparent `.resize-handle` elements. `.resize-handle*` now have `pointer-events: none` and no native resize cursor styles.
- Dirty Worktree: Many unrelated pre-existing changes are present in the repo/worktree. Do not revert anything unrelated. Focus only on `website/public/js/components/morphic-window.js`.

3. Codebase Status:
- `website/public/js/components/morphic-window.js`:
- Purpose: Defines the `<morphic-window>` Web Component, including titlebar, drag, maximize/collapse, resizing, cursor handling, occlusion, and hot reload.
- Current State: Modified extensively to fix resize cursor hover flashes. Final live state is hot-reloaded and verified.
- Key Code Segments:
  - `class MorphicWindow extends HTMLElement`: Main component.
  - Constructor: still binds `_onCursorMove`, `_onCursorLeave`, `_onViewportResize`, `_onResizePointerMove`, `_onResizePointerUp`; includes instance cursor timer fields from prior attempt (`_resizeCursorTimer`, `_pendingResizeCursor`, `_activeResizeCursor`) that are still used during actual resize cleanup/application.
  - `static _morphicWindowsFromFrontToBack()`: Returns visible `morphic-window` elements sorted by descending `zIndex`.
  - `static _windowEdgeAtPoint(clientX, clientY)`: Finds topmost non-maximized morphic window edge at a point using each window’s `_edgesForPoint`; returns `{ win, edges, cursor }`.
  - `static _clearGlobalResizeCursor()`: Clears global pending/active resize cursor state and removes `document.documentElement.style.cursor`.
  - `static _scheduleGlobalResizeCursor(edgeHit)`: Final version applies hover cursor immediately via `document.documentElement.style.cursor = edgeHit.cursor` for an edge hit, and clears when no hit. This restored hover cursors after the user reported they were gone.
  - `static _ensureGlobalResizeBehavior()`: Installs document capture listeners for `pointermove`, `pointerleave`, and `pointerdown`. Uses `customElements.get('morphic-window') || WindowClass` inside listeners so hot reload state is stored on the registered class. `pointerdown` starts resizing via `_startResizeWithEdges`.
  - `connectedCallback()`: Calls `_render()`, `_attachBehavior()`, and `MorphicWindow._ensureGlobalResizeBehavior()`.
  - `_render()`: `.resize-handle` CSS now includes `cursor: inherit; pointer-events: none;`; individual `.resize-handle.top`, `.bottom`, `.left`, `.right`, corners straddle the border but no longer set cursor.
  - `_attachBehavior()`: No longer attaches pointermove/leave cursor listeners or handle `pointerdown`; keeps active resize move/up and button/titlebar behavior.
  - `_edgeCursorForPoint(clientX, clientY)` and `_edgesForPoint(clientX, clientY)`: Geometry math includes `outerT = 8`, `edgeT = 10`, `cornerT = 14`.
  - `_cursorForEdges(edges)`: Maps edge booleans to proper resize cursor.
  - `_startResizeWithEdges(e, edges)`: Sets `WindowClass._resizingWindow`, clears global hover cursor, sets document and host cursor to resize cursor, captures pointer, and starts outline resize.
  - `_onResizePointerUp(e)`: Ends resize, applies geometry, resizes embedded surface, clears host/document cursor/global resize state.
  - `static hotReload()`: Calls `ExistingClass._ensureGlobalResizeBehavior()`, removes stale listeners including old cursor/resize handlers, clears timers, rebinds prototype methods, rerenders, reattaches behavior.
- Dependencies: Relies on document-level events, `customElements.get('morphic-window')`, `getBoundingClientRect()`, and z-index ordering. Interacts with SqueakJS canvases/iframes as children but does not modify SqueakJS directly.

- `website/public/js/components/icon-manager.js`:
- Purpose: Shows window list/icon manager and has its own cursor handling for iconify/edges.
- Current State: Inspected but not modified.
- Key Code Segments: `_edgeCursorForPoint`, `_onCursorMove`, `_showIconifyCursor`, `_hideIconifyCursor`. It was considered as another cursor source but final fix remained in `morphic-window.js`.

- `/memories/repo/morphic-window.md`:
- Purpose: Repository memory note for future work.
- Current State: Created/updated.
- Key Notes: Hot reload via `customElements.get('morphic-window').hotReload()`; resize edge affordances use document-level geometry detection; `.resize-handle*` are `pointer-events: none`; hover cursor is geometry-driven and drag cursor applied during resize.

4. Problem Resolution:
- Issues Encountered:
  - Initial resize handles and hit tests were too narrow/inside-only, causing one-pixel hover behavior.
  - Expanding transparent handles moved the flash outward, because the invisible handles themselves created native CSS cursor boundaries.
  - Delaying host cursor display did not help because native handle/hit surfaces were still involved.
  - Moving to document-level geometry fixed handle-origin flashes, but an intermediate stationary-only/dwell implementation removed hover cursors entirely.
- Solutions Implemented:
  - Resize handles are no longer pointer targets: `.resize-handle { pointer-events: none; cursor: inherit; }`.
  - Edge detection is centralized in `MorphicWindow._windowEdgeAtPoint()`.
  - Hover cursor is now one continuous region controlled by `document.documentElement.style.cursor`, set immediately when the geometry controller detects the edge, cleared when it does not.
  - Pointerdown on the edge is handled by the document-level controller and starts resize via `_startResizeWithEdges`.
- Debugging Context:
  - Static pixel scan showed three potential boundaries when approaching from inside: entering resize math at 10px inside, crossing canvas/host at about 5px inside, and leaving host at border.
  - Motion tests were needed because timer behavior during movement differed from static scans.
  - Final motion tests showed one continuous cursor span in both directions.
- Lessons Learned:
  - Do not let transparent resize handles own cursor hit testing; they create native boundary flashes.
  - Store hot-reload global state on the registered class from `customElements.get('morphic-window')`, not on a temporary class object from `new Function`.

5. Progress Tracking:
- Completed Tasks:
  - Expanded resize geometry to include outside band.
  - Removed transparent handles as pointer/cursor owners.
  - Added document-level resize hover and pointerdown controller.
  - Restored immediate hover resize cursor through geometry controller.
  - Preserved resize drag start and cleanup behavior.
  - Hot-reloaded active page and rebuilt live `morphic-window` instances.
  - Validated syntax and diagnostics.
- Partially Complete Work:
  - Awaiting user confirmation of the final visual behavior. The agent had not sent the final response yet when summarization triggered.
- Validated Outcomes:
  - `node --check website/public/js/components/morphic-window.js` succeeded.
  - VS Code diagnostics via `get_errors` returned “No errors found.”
  - Playwright final pixel-motion check: `ltrSpans: [[765,782]]`; `rtlSpans: [[782,765]]`, indicating one continuous `ew-resize` span across the tested right border.
  - Playwright final drag test: before pointerdown `docCursor:"ew-resize"`; during pointerdown `resizing:true`, `docCursor:"ew-resize"`, `hostCursor:"ew-resize"`; after pointerup `resizing:false`, cursors cleared.

6. Active Work State:
- Current Focus: Fixing `morphic-window` resize cursor hover flashes while preserving hover resize cursors and resize drag.
- Recent Context: User said “Now the resize cursors are completely gone.” The agent restored immediate hover cursors via `_scheduleGlobalResizeCursor` after removing handle hit testing. Final checks showed hover cursor is back as a continuous geometry-driven band.
- Working Code:
```js
static _scheduleGlobalResizeCursor(edgeHit) {
  var WindowClass = customElements.get('morphic-window') || MorphicWindow;
  if (!edgeHit || !edgeHit.cursor) {
    WindowClass._clearGlobalResizeCursor();
    return;
  }
  if (edgeHit.cursor === WindowClass._activeResizeCursor && edgeHit.win === WindowClass._activeResizeWindow) return;
  if (WindowClass._resizeCursorTimer) clearTimeout(WindowClass._resizeCursorTimer);
  WindowClass._resizeCursorTimer = null;
  WindowClass._pendingResizeCursor = '';
  WindowClass._pendingResizeWindow = null;
  WindowClass._pendingResizeX = null;
  WindowClass._pendingResizeY = null;
  WindowClass._activeResizeCursor = edgeHit.cursor;
  WindowClass._activeResizeWindow = edgeHit.win;
  document.documentElement.style.cursor = edgeHit.cursor;
}
```
- Immediate Context: Final response should explain that resize hover cursors are restored, now as one continuous geometry-driven band, and cite validation. Also mention live sync status and that a SqueakJS timeout appeared in console but seemed unrelated if necessary.

7. Recent Operations:
- Last Agent Commands:
  - `functions.apply_patch`: Restored immediate geometry-driven hover resize cursor by rewriting `_scheduleGlobalResizeCursor`.
  - `functions.run_in_terminal`: `node --check website/public/js/components/morphic-window.js`.
  - `functions.get_errors`: checked diagnostics for `morphic-window.js`.
  - `functions.run_playwright_code`: hot-reloaded `MorphicWindow.hotReload()` and cleared global resize cursor.
  - `functions.run_playwright_code`: ran pixel-motion sample across a right border in both directions.
  - `functions.read_file`: read the large Playwright result file showing `ltrSpans` and `rtlSpans`.
  - `functions.run_playwright_code`: verified pointerdown starts resize and pointerup clears cursor/state.
- Tool Results Summary:
  - Syntax: success; no terminal output.
  - Diagnostics: “No errors found.”
  - Hot reload: `{"ok":true,"windows":18,"globalInstalled":true}`.
  - Page recent events included unrelated-looking SqueakJS timeout: `Error: SqueakJS timeout at subclass.js_executeCallback...`.
  - Pixel-motion result: `sample {"caption":"DebuggerClient>>service","right":773,"y":609,"ok":true}`; `ltrSpans:[[765,782]]`; `rtlSpans:[[782,765]]`; rows from x 765 through 782 had `docCursor:"ew-resize"` and `computedCursor:"ew-resize"`, outside rows `auto`; `afterExit` cursor cleared.
  - Drag result: `sample {"caption":"Agent.Agents","x":782,"y":272,"ok":true}`; before `docCursor:"ew-resize"`; during `resizing:true`, `docCursor:"ew-resize"`, `hostCursor:"ew-resize"`, `globalResizingCaption:"Agent.Agents"`; after `resizing:false`, cursors cleared.
- Pre-Summary State: The agent had just verified the final restored hover cursor implementation and was about to send a final concise status response.
- Operation Context: These commands were executed to respond to the user’s “Now the resize cursors are completely gone” by restoring hover cursor behavior without reintroducing one-pixel flashes.

8. Continuation Plan:
- Pending Task 1: Send final/status response to the user explaining the current final fix. Use wording like: “I restored the resize hover cursors, but now they’re driven only by the document-level geometry controller; the transparent handles remain pointer-transparent.”
- Pending Task 2: Include validation: “left-to-right and right-to-left both show one continuous `ew-resize` span, x=765 through x=782 in the sampled case, and drag start/cleanup still works.”
- Priority Information: Highest priority is user confirmation. If the user still sees flashes, next debugging should compare actual OS cursor behavior vs DOM `documentElement` style, possibly inspect browser-level cursor rendering or overlapping window edge selection. Also check if multiple document-level listeners from previous hot reloads remain installed; `_globalResizeBehaviorInstalled` prevents duplicate installs on the registered class now, but older listeners from prior temporary class installs may still exist in the live page until full reload. If weird behavior persists after page reload, inspect listener duplication and consider namespacing/removing old listeners with stored references.
- Next Action: Immediate next response should be a final summary, not more tools, unless user sends another issue. Mention: “Live script hot-reloaded; live DOM objects rebuilt; external script file updated.”
