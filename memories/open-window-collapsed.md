# Opening a morphic-window collapsed

A creator can stipulate that a `<morphic-window>` opens collapsed (docked
to the icon-manager) via the boolean **`collapsed` attribute**, read once
in `connectedCallback` (`website/public/js/components/morphic-window.js`).

How it works: the icon-manager lists EVERY `morphic-window` and treats a
hidden window (`visibility:hidden`, or `data-icon-manager-pending-hidden`)
as collapsed. So "open collapsed" just means come up hidden. On mount, if
`collapsed` is present, connectedCallback sets `visibility:hidden;
opacity:0` (matching the resting state `collapse()` leaves) and then
REMOVES the attribute (one-shot, so a later DOM re-connect won't
re-collapse a window the user restored). No flash, no fade. The
icon-manager's restore (`_toggleWindow`) fades it back in normally.

Set the attribute BEFORE the element is connected (before appending it).
`connectedCallback` is NOT hot-patchable (custom element can't be
redefined), so this mechanism only takes effect on a fresh page load.

Users of the mechanism:
- **"evaluations"** (`evaluate-ledger.js`): `open(opts)` takes
  `{collapsed:true}`; the auto-open on page load passes it (manual
  `OrbitEvaluateLedger.open()` from the panel stays expanded).
- **"Keep Store"** (image-side `SmalltalkMCPServer>>openKeepViewer:`,
  instance method): the CREATE branch's injected JS sets
  `mw.setAttribute("collapsed", "true")`, so a fresh page load always
  comes up collapsed. The tool takes an optional boolean `restore`
  param (2026-08-04): when `false`, the RESTORE branch (existing
  window) refreshes data WITHOUT un-hiding or raising — this closes the
  hole where an extension restart against a still-running page would
  expand a collapsed window. The extension's
  `openKeepViewerOnStartup(opts)` (extension-impl.js) passes
  `restore:false` by default (startup) and `restore:true` from the
  panel's "view" action. `openKeepViewer` (zero-arg) survives as
  `^self openKeepViewer: true`. Image changes — baked into the
  packaged caffeine.zip as of the 1.258.0 build (fresh snapshot via
  prepareForRelease + orbit.caffeineSnapshot, 2026-08-04). Steering
  rule: a rebuild must snapshot first IF the agent changed the live
  image since the last snapshot; with no agent image changes, export
  the existing IndexedDB state as-is.

Gotchas found while adding the `restore` param:
- `FunctionAIToolParameter class>>initialize` had NO `#boolean`
  Converter, so any boolean tool param raised KeyNotFound inside
  `validate:`, which `MCPServer class>>toolsCall:` swallows for
  optional params → the method silently received nil. Fixed by adding
  `at: #boolean put: [:thing | thing = true or: [thing = 'true']]`
  (category is misspelled 'intitialization' in the image).
- The stored source for `SmalltalkMCPServer class>>initializeTools`
  was CORRUPTED (garbled overlapping fragments from getSource). Never
  recompile that kind of method from its getSource text; reconstruct
  from the live `tools` registry (name/selector/description/metadata
  per FunctionAITool) instead. It was recompiled clean on 2026-08-04.

History: an earlier `orbit-startup-arrange.js` arranger that collapsed
those windows after they opened was REJECTED and removed (script, the
orbit.html `<script>`, and the symlink-list entry). Do not reintroduce it.

"Getting Started with Orbit" (a static `<markdown-viewer>` in orbit.html)
was removed separately; it self-mounted on every load.
