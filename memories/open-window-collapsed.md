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
- **"Keep Store"** (image-side `SmalltalkMCPServer>>openKeepViewer`, instance
  method): the CREATE branch's injected JS sets `mw.setAttribute("collapsed",
  "true")`. `connect` calls `server openKeepViewer` on every page load, so it
  comes up collapsed; the RESTORE branch (manual "view" on an existing
  window) un-hides it as before. Image change — reverts on rebuild unless
  snapshotted.

History: an earlier `orbit-startup-arrange.js` arranger that collapsed
those windows after they opened was REJECTED and removed (script, the
orbit.html `<script>`, and the symlink-list entry). Do not reintroduce it.

"Getting Started with Orbit" (a static `<markdown-viewer>` in orbit.html)
was removed separately; it self-mounted on every load.
