# Resize cursor flashing — machine-specific, investigating Skia Graphite

## Conversation Overview
- Primary Objectives: Fix visible resize cursor flashing on `<morphic-window>` borders. Original report: "On a morphic-window, the resize cursor hover transitions only last for about a pixel after the mouse transits either side of a border." This session began with: "I'm seeing the resize hover cursor all across the right border of the Caffeine window, but it only flashes as I cross the edges of the left border." Evolved through several user reports: "I'm still seeing the flash", "I'm referring to horizontal motion across the vertical borders", "I'm also seeing the flashing across the border on all sides and corners of the VisualWorks window", and finally "If I put the VisualWorks window in the upper left, it flashes everywhere. If I put it at the middle right, no flashing." Ultimately discovered to be machine-specific.
- Session Context: Working in `/Users/craig/me/behavior/forks/orbit`. Active page is `http://localhost:8089/orbit.html` (changed from prior `lam.html`), browser page ID `9b8de443-8527-4ec0-a206-acd214554029`. Source file `website/public/js/components/morphic-window.js` (1116 lines). Hot reload via `customElements.get('morphic-window').hotReload()`.
- User Intent Evolution: Progressed from straightforward cursor fix → recognition that the problem is machine-specific (works on another VSCode machine with same DPR 2.5) → investigating Chromium GPU/Skia feature flags via VS Code's `argv.json`.

## Technical Foundation
- `<morphic-window>` Web Component with shadow DOM containing titlebar + slot for content (canvas/iframe).
- Resize zones: 8 shadow-DOM divs (`.resize-zone.edge-{top,bottom,left,right}` + `.corner-{tl,tr,bl,br}`) with native CSS cursor styles.
- Pointerdown on resize zone triggers `_startResizeWithEdges(e, edges)`.
- VS Code `argv.json` at `~/Library/Application Support/Code/argv.json` (or `Code - Insiders/`) with `disable-features` key for Chromium flags.
- Environment: macOS, devicePixelRatio 2.5, two VS Code machines tested (one flashes, one doesn't). Skia Graphite is current Skia backend (cannot be disabled via tried flags `UseSkiaRenderer`, `SkiaRenderer`, `SkiaGraphite`).

## Codebase Status
- `website/public/js/components/morphic-window.js`:
  - Reactive cursor scheme replaced with declarative shadow-DOM resize zones. Latest change is `rgba(0,0,0,0.01)` background on resize zones (compositor workaround that did not help).
  - `.resize-zone` CSS in `_render()`: position: absolute, background: `rgba(0,0,0,0.01)`, z-index: 10, with edge/corner subclasses sized 5px edges / 7px corners.
  - HTML template includes 8 `<div class="resize-zone ...">` elements after `<slot>`.
  - `_attachBehavior()`: wires pointerdown on each zone to `_bringToFront()` + `_startResizeWithEdges(e, edges)`. Removed `_onCursorMove`/`_onCursorLeave` listeners and `_onBorderPointerDown`.
  - `_startResizeWithEdges(e, edges)`: factored out from `_startResize` for direct edge dispatch from zones.
  - `_onCursorLeave(e)` still defined with `if (e && e.target !== this) return;` but no longer registered.

## Problem Resolution
- Issue 1: Capture-phase `pointerleave` fired for iframe descendants, clearing host cursor. Fixed by `e.target !== this` guard.
- Issue 2: Reactive `style.cursor` setting in pointermove handler is one frame behind visible cursor. Fixed by switching to declarative shadow-DOM zones with native `cursor:` CSS.
- Issue 3: Position-dependent flashing on this specific machine. Tried `rgba(0,0,0,0.01)` background to force compositor participation — did not help. Confirmed not a code issue: works on another machine with identical code and identical DPR 2.5.
- Lessons Learned: Reactive cursor management via JS is always too slow. Declarative CSS hit-testing is the only reliable approach. Some visual issues are machine-specific GPU/compositor bugs not fixable from page code.

## Active Work State
- Current Focus: Disable Skia Graphite via VS Code's `argv.json`.
- User reported: `disable-features` values `UseSkiaRenderer`, `SkiaRenderer`, `SkiaGraphite` did not turn off Skia Graphite as reported in `chrome://gpu`.
- Next: Suggest the dedicated command-line switch `--disable-skia-graphite` (in argv.json: `"disable-skia-graphite": true`), which Chromium source code (`gpu/config/gpu_finch_features.cc` `IsSkiaGraphiteEnabled`) shows takes precedence over both the feature flag and device-support check.
