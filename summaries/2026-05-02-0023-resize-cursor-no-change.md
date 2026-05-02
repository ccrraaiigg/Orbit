# Resize cursor hover no change

1. Conversation Overview:
- Primary Objectives: The overarching goal is to fix visible resize cursor hover behavior for `<morphic-window>`. Original report from prior context: “On a morphic-window, the resize cursor hover transitions only last for about a pixel after the mouse transits either side of a border.” In this continuation, user repeatedly reported that the visible problem remains: “It’s back to the original problem. The resize cursors only appear for about a pixel, in different places for different approach directions.” Then: “No change.” Then after a reload: “Page reloaded. No change.” Most recent user message: “No change.”
- Session Context: Working in `/Users/craig/me/behavior/forks/orbit`, active page `http://localhost:8089/lam.html`, browser page ID `8a63f471-45f8-49e1-aa7f-8c09e0230d24`. Main source file is `website/public/js/components/morphic-window.js`. The page is livecoded with Playwright and `customElements.get('morphic-window').hotReload()`.
- User Intent Evolution: The user’s goal has not changed: make resize cursors appear continuously and reliably around morphic-window borders. The user’s repeated “No change” reports overrode multiple DOM/computed-style validations, proving that visible OS cursor behavior is the source of truth, not computed CSS.
2. Technical Foundation:
- Orbit Web App: Livecoding pair-programming harness serving `lam.html` in VS Code Integrated Browser, with windowing implemented by Web Components around SqueakJS/Smalltalk content.
- `<morphic-window>`: Web Component in `website/public/js/components/morphic-window.js`; wraps Morphic/SqueakJS content in draggable/resizable windows with titlebar, controls, maximize/collapse, outline resize, and hot reload.
- Hot Reload Pattern: `customElements.get('morphic-window').hotReload()` fetches `js/components/morphic-window.js`, strips `customElements.define`, evaluates `MorphicWindow`, copies prototype/static methods onto registered class, rerenders and reattaches existing instances, and should refresh live resize hit surfaces.
- Cursor Architecture Attempts: Started with document-level geometry-driven cursor styles; moved to reactive transparent overlay; then persistent fixed native resize hit surfaces. Current direction is persistent fixed native hit surfaces over edges/corners.
- Environment Constraints: macOS; VS Code workspace root `/Users/craig/me/behavior/forks/orbit`; nested `website` may be its own git repo. Worktree contains many unrelated changes; do not revert anything unrelated. Use Playwright for page manipulation, not MCP.
3. Codebase Status:
- `website/public/js/components/morphic-window.js`:
- Purpose: Defines `<morphic-window>`, including window decoration, titlebar, controls, maximize/collapse, resize geometry, cursor behavior, resize drag, and hot reload.
- Current State: Heavily modified for resize cursor debugging. Most recent patch has been applied but not yet checked or hot-reloaded. The code now has persistent fixed resize hit surfaces created as direct body children.
- Key Code Segments:
  - `static _windowEdgeAtPoint(clientX, clientY)`: geometry hit detection for topmost visible non-maximized morphic window.
  - `static _resizeHitSurfaceContainer()`: after the latest patch, simply returns `document.body`.
  - `static _addResizeHitSurface(container, win, edges, left, top, width, height)`: creates `div[data-morphic-window-resize-surface]`, fixed positioned, own z-index `2147483646`, `pointerEvents = auto`, cursor from `win._cursorForEdges(edges)`, and pointerdown handler that calls `win._bringToFront()` and `win._startResizeWithEdges(e, edges)`. Latest patch changed background to `rgba(0, 0, 0, 0.001)` and made surfaces direct body children.
  - `static _removeResizeHitSurfaces()`: latest patch removes both `[data-morphic-window-resize-surfaces]` and `[data-morphic-window-resize-surface]`.
  - `static _refreshResizeHitSurfaces()`: removes existing surfaces, then creates corner and edge surfaces for visible non-maximized windows using `outerT = 8`, `edgeT = 10`, `cornerT = 14`; surfaces for top windows are appended last via `.reverse()`.
  - `static _clearGlobalResizeCursor(force)`: clears cursor state/styles; non-forced mode can reapply if last pointer is still on an edge. Force mode used after resize completion/hot reload.
  - `static _ensureGlobalResizeBehavior()`: installs named global pointermove/pointerleave/pointerdown handlers, tracks last pointer position, ignores internal pointerleave, and geometry-starts resize as fallback.
  - `_edgesForPoint(clientX, clientY)`: constrained resize hit geometry with `inHorizontalRange` and `inVerticalRange`.
  - `_startResizeWithEdges(e, edges)`: removes resize surfaces during actual resize, sets resize state/cursors, captures pointer, starts outline resize.
  - `_onResizePointerUp(e)`: finalizes resize, clears cursor state, refreshes persistent hit surfaces.
  - `_onPointerMove`, `_onPointerUp`, `_bringToFront`, `_sendToBack`, `_onViewportResize`, `connectedCallback`, `disconnectedCallback`, and `hotReload`: all refresh resize hit surfaces when window geometry/stacking/lifecycle changes.
- Dependencies: Relies on DOM, fixed positioning, `getBoundingClientRect()`, z-index ordering, custom element hot reload, document-level pointer events, and SqueakJS/iframe content inside windows.
- `website/public/js/caffeine.js`:
- Purpose: Legacy page behavior for Caffeine/embedded Squeak.
- Current State: Inspected, not modified in this phase.
- Key Code Segments: cursor hiding on keydown via `.cursor-hidden` and CSS `.cursor-hidden, .cursor-hidden * { cursor: none !important; }`; mousemove removes hidden class.
- `website/public/js/components/icon-manager.js`:
- Purpose: Icon/window list manager with its own cursor behavior.
- Current State: Inspected by grep, not modified.
- Key Code Segments: Can set custom iconify cursor and `cursor: none !important` on self/document; possible competing cursor owner.
- `website/public/js/squeakjs/squeak.js`:
- Purpose: SqueakJS runtime/browser input handling.
- Current State: Inspected, not modified.
- Key Code Segments: appends `display.cursorCanvas` with `id="cursorCanvas"`, `cursor: none`, `pointerEvents: none`.
- `website/public/js/squeakjs/vm.js`:
- Purpose: SqueakJS VM primitives.
- Current State: Inspected, not modified.
- Key Code Segments: `primitiveBeCursor` sets cursor canvas visible and `cursorCanvas.parentNode.style.cursor = 'none'`.
- `/memories/repo/morphic-window.md`:
- Purpose: Repository-scoped memory note.
- Current State: Updated. Current key note: persistent fixed native hit surfaces are the current strategy; reactive hover overlays are too late for visible OS cursor stability.
4. Problem Resolution:
- Issues Encountered:
  - Original transparent resize handles created one-pixel native cursor boundary flashes.
  - Document-level `html.style.cursor` and high-priority CSS looked continuous in computed style but did not change visible behavior for the user.
  - Reactive overlay created on `pointermove` was too late and was also disrupted by internal `pointerleave` clearing.
  - Old anonymous hot-reload listeners complicated testing until named global handlers were added.
  - Persistent surfaces appeared correct in DOM/computed tests, but user still reported “No change.”
  - Other cursor owners exist: Caffeine cursor-hidden CSS, icon-manager cursor-none rules, and SqueakJS cursor canvas/parent cursor none.
- Solutions Implemented:
  - `.resize-handle*` remain pointer-transparent and no longer own cursor behavior.
  - Resize geometry centralized in `_windowEdgeAtPoint()` and `_edgesForPoint()`.
  - Document-level global cursor style/overlay support added, but current main strategy is persistent fixed resize surfaces.
  - Internal `pointerleave` events are ignored.
  - Global handlers are named and reusable for hot reload.
  - Persistent fixed edge/corner surfaces are refreshed from geometry and removed during active resize.
  - Latest unverified patch: make each resize surface a direct body child with own z-index and a barely painted background to avoid browser cursor hit-test quirks with transparent elements or `pointer-events:none` ancestors.
- Debugging Context:
  - Multiple Playwright sweeps showed DOM/computed cursor continuity but user-visible behavior did not change.
  - Before latest patch, live inspection at sample `{ caption: "Agent.Agents", x: 782, y: 272 }` showed top element was a resize surface `DIV` with computed/inline `ew-resize`; html/body inline cursor empty; no `cursor-hidden` class; no `#cursorCanvas`; only cursor-hidden CSS rule present.
  - This mismatch suggests the visible cursor may be controlled outside normal top-element computed cursor, or cursor hit testing differs in VS Code Integrated Browser.
- Lessons Learned:
  - Do not trust computed CSS alone for visible cursor behavior.
  - Creating hover cursor surfaces after `pointermove` can be too late.
  - Internal pointerleave from child boundaries can cause one-pixel flashes.
  - SqueakJS/icon-manager/caffeine can be cursor owners and must be considered if DOM surfaces appear correct but visible cursor is wrong.
5. Progress Tracking:
- Completed Tasks:
  - Created `summaries/2026-05-01-resize-cursor-flashes.md` for earlier conversation summary.
  - Added and iterated document-level resize behavior.
  - Added global cursor style helpers.
  - Added reactive overlay helpers and then moved away from relying on them.
  - Fixed internal pointerleave clearing.
  - Added named global resize handlers.
  - Added persistent fixed resize hit surfaces and lifecycle/geometry refreshes.
  - Inspected competing cursor code in `caffeine.js`, `icon-manager.js`, `squeakjs/squeak.js`, and `squeakjs/vm.js`.
  - Applied latest patch to make resize surfaces direct body children with own z-index and barely painted background.
- Partially Complete Work:
  - Latest patch has not yet been syntax-checked, hot-reloaded, or verified.
  - The user-visible cursor issue remains unresolved according to the user.
- Validated Outcomes:
  - Before latest patch, `node --check` and VS Code diagnostics were clean.
  - Before latest patch, persistent surfaces existed before pointer movement and covered the sampled right edge from x=509 through x=527.
  - Pointerdown on a surface started resizing; surfaces were removed during resize; pointerup restored surfaces and cleared resize state.
- Not Validated:
  - The direct-body painted-surface patch.
  - Whether visible OS cursor changes for the user after latest patch.
6. Active Work State:
- Current Focus: Fixing visible resize cursor hover flashes on `<morphic-window>` after DOM/computed tests repeatedly passed but user still saw “No change.”
- Recent Context: User said “No change” after persistent fixed surfaces were installed. Agent inspected other cursor owners, found SqueakJS/icon-manager/caffeine cursor code, ran a live cursor-state inspection, and then patched resize surfaces to be direct body children with barely visible painted background.
- Working Code: The latest patch changed this section in `morphic-window.js`:
```js
static _resizeHitSurfaceContainer() {
  return document.body;
}

static _addResizeHitSurface(container, win, edges, left, top, width, height) {
  ...
  surface.style.background = 'rgba(0, 0, 0, 0.001)';
  surface.style.pointerEvents = 'auto';
  surface.style.zIndex = '2147483646';
  ...
}

static _removeResizeHitSurfaces() {
  Array.from(document.querySelectorAll('[data-morphic-window-resize-surfaces], [data-morphic-window-resize-surface]')).forEach(function(surface) {
    surface.remove();
  });
}

static _refreshResizeHitSurfaces() {
  ...
  var container = WindowClass._resizeHitSurfaceContainer();
  WindowClass._removeResizeHitSurfaces();
  container = WindowClass._resizeHitSurfaceContainer();
  ...
}
```
- Immediate Context: Need to validate the latest patch and hot-reload it into the page. If user still sees no change, shift investigation toward non-DOM cursor ownership: Squeak custom cursor/cursor canvas, icon-manager cursor-none, Caffeine cursor-hidden, iframe-level cursor, or integrated browser cursor behavior.
7. Recent Operations:
- Last Agent Commands:
  - `multi_tool_use.parallel`: `grep_search` for cursor-related patterns in `website/public/js/**`, `read_file` first 220 lines of `morphic-window.js`, `read_file` first 150 lines of `caffeine.js`.
  - `read_file`: `website/public/js/squeakjs/vm.js` lines 6550-6585.
  - `read_file`: `website/public/js/squeakjs/squeak.js` lines 760-790.
  - `run_playwright_code`: live inspection of cursor state at sampled right border.
  - `apply_patch`: changed persistent resize surfaces to direct body children, own z-index, and minimally painted background.
- Tool Results Summary:
  - `grep_search`: 140 matches. Important cursor owners found in `caffeine.js`, `icon-manager.js`, `squeakjs/squeak.js`, `squeakjs/vm.js`, and `morphic-window.js`.
  - `vm.js` read: `primitiveBeCursor` makes cursor canvas visible and sets `cursorCanvas.parentNode.style.cursor = 'none'`.
  - `squeak.js` read: cursor canvas appended to canvas parent with `cursor: none`, `pointerEvents: none`.
  - Playwright live inspection result: top element at sample was resize surface `DIV`, computed and inline `ew-resize`; html/body inline cursor empty; no cursor-hidden class; `cursorCanvas: null`; `caffeineFrameCursor: auto`; `iconManagerCursor: auto`; only cursor-hidden CSS rule found.
  - Latest `apply_patch`: succeeded. No validation yet after patch.
- Pre-Summary State: The agent had just applied the direct-body/minimally-painted resize surface patch and had not yet run `node --check`, `get_errors`, hot reload, or Playwright verification.
- Operation Context: These commands were executed because user reported “No change” even after persistent resize surfaces appeared correct in DOM inspection.
8. Continuation Plan:
- Pending Task 1: Immediately validate latest patch:
  - Run `node --check website/public/js/components/morphic-window.js`.
  - Run `get_errors` for `website/public/js/components/morphic-window.js`.
  - Hot reload in page: `await customElements.get('morphic-window').hotReload(); customElements.get('morphic-window')._clearGlobalResizeCursor(true); customElements.get('morphic-window')._refreshResizeHitSurfaces();`
  - Inspect that surfaces are direct children of body, have `background: rgba(0, 0, 0, 0.001)`, own z-index, and top element is a surface across edge band.
- Pending Task 2: Verify drag still works:
  - Move mouse to sampled edge.
  - Before pointerdown: top is `data-morphic-window-resize-surface`, cursor `ew-resize`.
  - During pointerdown: target window `_resizing` true, surfaces removed, doc/host cursor set.
  - After pointerup: `_resizing` false, surfaces restored, cursor cleared.
- Priority Information: User-visible behavior is unresolved. If direct-body painted surfaces still produce “No change,” stop iterating on computed DOM cursor tests as proof and investigate actual cursor ownership/rendering. Specifically inspect all iframes for `#cursorCanvas` and cursor styles; check whether `icon-manager` or Caffeine cursor-hidden is active during user motion; consider disabling Squeak custom cursor or applying resize cursor to the Squeak cursor canvas/parent while near morphic-window borders.
- Next Action: Validate the most recent patch, hot-reload, report sync status, and ask for user confirmation only after the live page is actually updated. If user again says “No change,” pivot to iframe/Squeak custom cursor investigation rather than more DOM hit-surface variations.
