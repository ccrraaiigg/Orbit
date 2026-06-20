# Lam 2300 VR digital-twin window (`<lam2300-vr>`)

## Geometry lives on the INNER `<morphic-window>`, not the host

The `<lam2300-vr>` host element is `display:contents`, so inline
`top/left/width/height` set on the HOST ARE IGNORED. The visible window is
the inner `<morphic-window>` the host wraps; that is where position/size
actually take effect. The host's own `getBoundingClientRect()` reads 0×0 —
do not trust it.

Current authoritative geometry (read from the live inner morphic-window):

- top: 817px
- left: 1001px
- width: 760px
- height: 514px
- z-index: 40

The VR twin does NOT overlap the "Lam 2300 UI" sim window. Do NOT collapse,
hide, or shrink it to screenshot the sim — just screenshot the full viewport.

## Recreating after a page reload

```js
document.querySelectorAll('lam2300-vr').forEach(el => el.remove()); // scoped tag, safe
const el = document.createElement('lam2300-vr');
el.setAttribute('caption', 'Lam Research 2300 — VR digital twin');
document.body.appendChild(el);
// then position the INNER morphic-window (host is display:contents):
const inner = el.querySelector('morphic-window');
Object.assign(inner.style, {
  position: 'absolute',
  top: '817px',
  left: '1001px',
  width: '760px',
  height: '514px',
  zIndex: '40'
});
```

Caption: `Lam Research 2300 — VR digital twin`. Inner iframe src: `lam2300-vr.html`.

## PM numbering = overhead left-to-right

`PROCESS_MODULES` ids are assigned to angles so the overhead camera
(looking straight down; world -x = screen-left) shows PM1..PM4 left to
right: `PM1=250, PM2=210, PM3=150, PM4=110` (deg). Module x =
`sin(angle)*MODULE_DIST`, so ascending screen-x = PM1(-3.38) ..
PM4(+3.38). Everything (mesh, `destYaw[id]=angle-90`, both labels) is
keyed by id off this array, so the sim's `destPM 'PMn'` stays
consistent — only the labels moved, not the physical chambers.

## Both arms park at the station they last serviced when idle

Neither transfer arm springs back to center/home when idle. Each stays
parked at the station where the wafer it last handled now rests, until
that wafer moves on or it must carry again.

VTM (vacuum, PM<->LL) — `applyRobot` idle branch: prefer a loaded PM
(`this.lastLoadedPM`, set in `applyModule` on empty->loaded; else any
loaded PM). If NO PM is loaded, fall back to a load lock that holds a
wafer (`this.lastFilledLock`, set in `applyLocks` on empty->filled;
else any filled lock, LLB preferred). If STILL no live signal (e.g. the
ATM arm has since emptied that lock), HOLD `this.lastParkYaw` — the arm
never springs back to home. The arm NEVER moves unless it must carry
again. So after PM1->LLB it parks at LLB and stays there even once the
ATM removes the wafer from LLB. (`destYaw` has LLA/LLB entries because
`LOAD_LOCKS` is concatenated into the destYaw build.)
`applyModule`/`applyLocks` run before `applyRobot` in `applySnapshot`,
so `this.wafer[id]` / `this.lockHasWafer[id]` are current.

ATM (atmospheric/EFEM, LP<->LL) — `applyAtmRobot` idle branch: retract
(reach 0) but keep `atmTargetX` at `this.lastServicedPort` (set
whenever it picks from a load port) instead of drifting to center
(x=0). It only leaves when another load port needs it (a new pick
updates `lastServicedPort`).

`HOME_YAW` faces a load lock (LLB), not 0: it is initialized to
`this.destYaw['LLB']` (= -115 deg with LLB angle -25) AFTER `destYaw`
is built. So when the VTM arm has nothing to attend it sits facing a
load lock rather than dead ahead.

## Live-patching geometry without reload
To change PM angles live (no iframe reload): for each id set `mod-<id>`
position/rotation, counter-rotate the inner `.module-label[data-module]`
to `0 -angle 0`, reposition the sibling `.overhead-label[data-module]`
(keep its y), and update `toolComp.destYaw[id]=angle-90`. Patch
`applyModule`/`applyRobot` directly on the live component instance
(`el.components.tool`). Find it via
`doc.querySelectorAll('*')` where `e.components && e.components.tool`.
