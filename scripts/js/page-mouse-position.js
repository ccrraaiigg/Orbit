// page-mouse-position.js — track the current mouse position on the
// Orbit page, and expose a polling API for Squeak (and any other
// observer) to read it.
//
// API:
//   window.__pageMouse()             → { x, y, t, inside }
//   window.__pageMouse.x             → number (last clientX)
//   window.__pageMouse.y             → number (last clientY)
//   window.__pageMouse.t             → DOMHighResTimeStamp of last update
//   window.__pageMouse.inside        → boolean: pointer is currently
//                                       over the document
//
// `x`, `y` are viewport-relative (clientX / clientY). `t` is
// performance.now() at the time of the last `mousemove`. `inside`
// flips to false on `mouseleave` of the document and back to true
// on the next `mousemove` (or `mouseenter`).
(function () {
  if (window.__pageMouseInstalled) return;
  window.__pageMouseInstalled = true;

  const state = { x: 0, y: 0, t: 0, inside: false };

  function snapshot() {
    return { x: state.x, y: state.y, t: state.t, inside: state.inside };
  }

  function api() { return snapshot(); }
  Object.defineProperties(api, {
    x:      { get: () => state.x },
    y:      { get: () => state.y },
    t:      { get: () => state.t },
    inside: { get: () => state.inside }
  });

  window.__pageMouse = api;

  function onMove(e) {
    state.x = e.clientX;
    state.y = e.clientY;
    state.t = e.timeStamp || performance.now();
    state.inside = true;
  }
  function onEnter() { state.inside = true; }
  function onLeave(e) {
    // Only flip when the pointer truly leaves the document, not when
    // it crosses into a child element.
    if (e.relatedTarget === null) state.inside = false;
  }

  window.addEventListener('mousemove', onMove, { capture: true, passive: true });
  document.addEventListener('mouseenter', onEnter, { capture: true, passive: true });
  document.addEventListener('mouseleave', onLeave, { capture: true, passive: true });
})();
