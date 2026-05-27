// agent-mouse-cursor.js — translucent purple dot showing the agent's mouse position.
// Exposes window.__agentMouse(x, y) — call after every Playwright mouse.move / mouse.click.
(function () {
  if (window.__agentMouseInstalled) return;
  window.__agentMouseInstalled = true;

  const dot = document.createElement('div');
  dot.id = 'agent-mouse-cursor';
  Object.assign(dot.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '24px',
    height: '24px',
    marginLeft: '-12px',
    marginTop: '-12px',
    borderRadius: '50%',
    background: 'rgba(160, 32, 240, 0.45)',
    border: '2px solid rgba(120, 0, 200, 0.75)',
    boxShadow: '0 0 8px rgba(160, 32, 240, 0.6)',
    pointerEvents: 'none',
    zIndex: '2147483647',
    transition: 'transform 60ms ease-out',
    transform: 'translate(-9999px, -9999px)'
  });

  function append() {
    if (!dot.isConnected && document.body) document.body.appendChild(dot);
  }
  if (document.body) append();
  else document.addEventListener('DOMContentLoaded', append, { once: true });

  window.__agentMouse = function (x, y, opts) {
    append();
    dot.style.transform = `translate(${x}px, ${y}px)`;
    if (opts && opts.click) {
      dot.style.background = 'rgba(255, 90, 220, 0.7)';
      setTimeout(() => { dot.style.background = 'rgba(160, 32, 240, 0.45)'; }, 180);
    }
  };
})();
