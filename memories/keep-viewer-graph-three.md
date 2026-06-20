# keep-viewer graph: single THREE instance for hover/raycasting

The Keep viewer's 3D graph (`website/public/js/components/keep-viewer.js`,
`_initForceGraph`) renders each node as a `three-spritetext` SpriteText
inside an iframe.

## Gotcha: dual THREE breaks node hover

Loading the graph libs from jsdelivr's `/+esm` bundles a *separate* copy
of THREE into each package:

```
import ForceGraph3D from "https://cdn.jsdelivr.net/npm/3d-force-graph/+esm";
import SpriteText  from "https://cdn.jsdelivr.net/npm/three-spritetext/+esm";
```

This logs the console warning **"Multiple instances of Three.js being
imported."** With two THREE instances, the graph's raycaster (3d-force-graph's
THREE) cannot intersect the label sprites (three-spritetext's THREE), so
node hover / `.nodeLabel` tooltips silently never fire. The graph still
renders and drags fine — only hover is dead.

## Fix: share one THREE via esm.sh `?deps=`

```
import ForceGraph3D from "https://esm.sh/3d-force-graph?deps=three@0.180.0";
import SpriteText  from "https://esm.sh/three-spritetext?deps=three@0.180.0";
```

`?deps=three@X` makes esm.sh serve both packages against the *same* pinned
THREE build → one instance → raycasting works. Verified: 9/9 nodes show
tooltips on the production render path.

- `three@0.180.0` works. Older pins fail: 0.170/0.171 throw
  `does not provide an export named 'Timer'` (3d-force-graph wants Timer
  in core three). esm.sh `?external=three` + import map is a worse rabbit
  hole (needs `three/webgpu`, `three/tsl`, `three/examples/jsm/` subpath
  maps and still hits version export mismatches). Use `?deps=` instead.
- d3-force-3d has no three dependency; left on jsdelivr `/+esm`.

## Testing hover from Playwright

Don't grid-hover blindly — sprites are small and a coarse grid yields false
0-hit results regardless of correctness. Get exact node screen coords via
`graph.graph2ScreenCoords(n.x,n.y,n.z)` and hover those. To reach the graph
object, temporarily expose `window.__kg = graph` before the
`keep-graph-ready` postMessage, but remember: reassigning `iframe.srcdoc`
to inject that line *reloads* the iframe (warms the module cache) and can
mask load-order effects. Prefer patching the live `_initForceGraph` and
calling `kv._render()` so you exercise the real production path.
