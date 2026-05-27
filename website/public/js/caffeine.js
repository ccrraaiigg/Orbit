function dragElement(element, handle) {
  var deltaX = deltaY = x = y = 0

  handle.onmousedown = dragMouseDown

  function dragMouseDown(event) {
    event = event || window.event
    event.preventDefault()

    Array.from(document.querySelectorAll('body *')).map(element => element.style.zIndex = 0)
    window.document.getElementById('dashboard').style.zIndex = 2000

    this.style.zIndex = 1

    x = event.clientX
    y = event.clientY

    document.onmouseup = closeDragElement
    document.onmousemove = elementDrag}

  function elementDrag(event) {
    event = event || window.event
    event.preventDefault()

    deltaX = x - event.clientX
    deltaY = y - event.clientY
    x = event.clientX
    y = event.clientY

    element.style.top = (element.offsetTop - deltaY) + 'px'
    element.style.left = (element.offsetLeft - deltaX) + 'px'}

  function closeDragElement() {
    document.onmouseup = null
    document.onmousemove = null}}


function resizeElement(element) {
  // Create box in bottom-left.
  var resizer = document.createElement('div')

  resizer.id = 'resizeHandle'
  resizer.style.width = '10px'
  resizer.style.height = '10px'
  resizer.style.background = 'red'
  resizer.style.opacity = 0.5
  resizer.style.position = 'absolute'
  resizer.style.right = 0
  resizer.style.bottom = 0
  resizer.style.cursor = 'se-resize'

  // Append child to element.
  element.appendChild(resizer)

  // box function onmousemove
  resizer.addEventListener('mousedown', initResize, false)

  // window functions mousemove & mouseup
  function initResize(event) {
    element.onresizestart(event)
    window.addEventListener('mousemove', resize, false)
    window.addEventListener('mouseup', stopResize, false)}

  // Resize the element.
  function resize(event) {
    element.style.width = (event.clientX - element.offsetLeft) + 'px'
    element.style.height = (event.clientY - element.offsetTop) + 'px'
    element.onresize(event)}

  // On mouseup, remove window functions mousemove & mouseup.
  function stopResize(event) {
    window.removeEventListener('mousemove', resize, false)
    window.removeEventListener('mouseup', stopResize, false)
    element.onresizeend(event)}}


window.onload = function () {
  var embeddedSqueak = document.getElementById('embeddedSqueak'),
//      summary = document.getElementById('summary'),
      statustext = document.getElementById('status').children[0]

  statustext.style.textShadow = '1px 1px 1px #000'
  statustext.style.opacity = 0.5

  embeddedSqueak.onmouseenter = function () {
      document.getElementById('Caffeine').contentWindow.focus()}

  embeddedSqueak.onmouseleave = function () {
      window.focus()}
    
/*
  summary.onmousedown = function () {
    embeddedSqueak.style.zIndex = 1}

  summary.onmouseover = function () {
    embeddedSqueak.style.boxShadow = ''}
*/
  
  window.setTimeout(
    function () {
      window.scrollTo(0, 0)
      document.body.style.transition = 'all 1000ms'
      document.body.bgColor = ''},
    500)
  
  window.setTimeout(
    function () {
      var dashboard = window.document.getElementById('dashboard'),
	  spinner = window.document.getElementById('sqSpinner')

      window.progress.style.opacity = 1
      window.thestatus.style.opacity = 0.8
//      window.document.getElementById('summary').style.opacity = 1
	dashboard.style.opacity = 0.75},
    1500)
}

document.addEventListener('contextmenu', function(e) { e.preventDefault(); }, true);

// Raise the Caffeine window on a plain (no-modifier) mousedown anywhere
// inside it — including inside the SqueakJS iframe, whose events don't
// bubble out to the parent document. We attach a capture-phase mousedown
// listener to both the morphic-window host and the iframe's contentDocument,
// and call _bringToFront() when no shift/ctrl/alt/meta keys are held.
(function() {
  function bareMousedown(e) {
    // Raise on plain mousedown (no modifiers) or on cmd-left-mousedown
    // (meta only, button 0). Cmd-left still continues into the existing
    // cmd-click / cmd-drag pipeline in morphic-window; we just also
    // bring the Caffeine window to the front.
    var noMods = !(e.shiftKey || e.ctrlKey || e.altKey || e.metaKey);
    var cmdLeft = e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && e.button === 0;
    if (!noMods && !cmdLeft) return;
    var win = document.getElementById('embeddedSqueak');
    if (win && typeof win._bringToFront === 'function') win._bringToFront();
  }
  function attachToIframeDoc(iframe) {
    var doc;
    try { doc = iframe.contentDocument; } catch (_) { return; }
    if (!doc || doc.__caffeineRaiseAttached) return;
    doc.__caffeineRaiseAttached = true;
    doc.addEventListener('mousedown', bareMousedown, true);
  }
  function wire() {
    var win = document.getElementById('embeddedSqueak');
    if (win && !win.__caffeineRaiseAttached) {
      win.__caffeineRaiseAttached = true;
      win.addEventListener('mousedown', bareMousedown, true);
    }
    var iframe = document.getElementById('Caffeine');
    if (iframe) {
      if (!iframe.__caffeineRaiseLoadAttached) {
        iframe.__caffeineRaiseLoadAttached = true;
        iframe.addEventListener('load', function() { attachToIframeDoc(iframe); });
      }
      attachToIframeDoc(iframe);
    }
  }
  wire();
  window.addEventListener('load', wire);
  document.addEventListener('DOMContentLoaded', wire);
})();

// Hide the cursor while typing; restore on mouse movement.
(function() {
  var hidden = false;
  var modifierOnly = { Meta: 1, Shift: 1, Alt: 1, Control: 1, CapsLock: 1 };
  var attachedDocs = [];

  function setHidden(v) {
    hidden = v;
    attachedDocs.forEach(function(d) {
      d.documentElement.classList.toggle('cursor-hidden', v);
    });
  }

  function onKeydown(e) {
    if (hidden || modifierOnly[e.key]) return;
    setHidden(true);
  }
  function onMouseMove() {
    if (!hidden) return;
    setHidden(false);
  }

  function ensureStyle(doc) {
    if (doc.__cursorHideStyleAttached) return;
    doc.__cursorHideStyleAttached = true;
    var style = doc.createElement('style');
    style.textContent = '.cursor-hidden, .cursor-hidden * { cursor: none !important; }';
    (doc.head || doc.documentElement).appendChild(style);
  }
  function attachToDoc(doc) {
    if (!doc || doc.__cursorHideAttached) return;
    doc.__cursorHideAttached = true;
    attachedDocs.push(doc);
    ensureStyle(doc);
    doc.addEventListener('keydown', onKeydown, true);
    doc.addEventListener('mousemove', onMouseMove, true);
  }
  function attachToIframe(iframe) {
    var doc;
    try { doc = iframe.contentDocument; } catch (_) { return; }
    attachToDoc(doc);
  }
  function attachToAllIframes() {
    document.querySelectorAll('iframe').forEach(function(iframe) {
      // Re-attach on every load (iframe nav resets contentDocument).
      iframe.addEventListener('load', function() { attachToIframe(iframe); });
      attachToIframe(iframe);
    });
  }

  attachToDoc(document);
  attachToAllIframes();
  window.addEventListener('load', attachToAllIframes);
  document.addEventListener('DOMContentLoaded', attachToAllIframes);
  new MutationObserver(function(muts) {
    muts.forEach(function(m) {
      m.addedNodes && m.addedNodes.forEach(function(n) {
        if (n.tagName === 'IFRAME') {
          n.addEventListener('load', function() { attachToIframe(n); });
          attachToIframe(n);
        }
      });
    });
  }).observe(document.documentElement, { subtree: true, childList: true });
})();

// Freeze all chromeless remote windows while the Caffeine iframe has focus.
// The Caffeine window renders the original Squeak world, which contains the
// source SystemWindows — while it's in the foreground, the Squeak world may
// be actively scrolled or manipulated in ways that repaint regions behind
// other windows, causing flashes. Freezing keeps the remote wrappers showing
// a stable snapshot until focus leaves the iframe.
//
// The iframe swallows pointer events, so we cannot rely on pointerdown on
// the host element. Instead we wrap the Caffeine host's _bringToFront()
// (which the existing bareMousedown handler calls) to trigger the freeze.
// A document-level pointerdown outside the Caffeine host thaws the top one.
(function() {
  function freezeAll() {
    var MW = customElements.get('morphic-window');
    if (!MW) return;
    document.querySelectorAll('morphic-window[chromeless]').forEach(function(w) {
      if (w.id === 'embeddedSqueak') return;
      if (w.style.visibility === 'hidden') return;
      MW._freezeChromelessSnapshot(w);
    });
  }
  function thawTop() {
    var MW = customElements.get('morphic-window');
    if (!MW) return;
    var best = null;
    var bestZ = -Infinity;
    document.querySelectorAll('morphic-window[chromeless]').forEach(function(w) {
      if (w.id === 'embeddedSqueak') return;
      var z = parseInt(w.style.zIndex, 10) || 0;
      if (z > bestZ) { bestZ = z; best = w; }
    });
    if (best) MW._thawFrozenSnapshot(best);
  }

  function wire() {
    var host = document.getElementById('embeddedSqueak');
    if (!host || host.__caffeineFocusFreezeAttached) return;
    if (typeof host._bringToFront !== 'function') return;
    host.__caffeineFocusFreezeAttached = true;

    // Override _bringToFront on the Caffeine host instance to freeze
    // chromeless windows when the user clicks it. The Caffeine host
    // must always sit above frozen overlays (z 2147483646) when active,
    // not just when maximized, so we unconditionally set z 2147483647.
    // We call the prototype method directly rather than capturing a
    // reference that can go stale after hot-reload patches.
    host._bringToFront = function() {
      var MW = customElements.get('morphic-window');
      MW.prototype._bringToFront.call(host);
      host.style.zIndex = '2147483647';
      if (!host._isTransitioning) freezeAll();
    };

    // Pointerdown outside the Caffeine host → thaw the frontmost.
    document.addEventListener('pointerdown', function(e) {
      var path = e.composedPath ? e.composedPath() : [];
      for (var i = 0; i < path.length; i++) { if (path[i] === host) return; }
      thawTop();
    }, true);
  }

  wire();
  window.addEventListener('load', wire);
  document.addEventListener('DOMContentLoaded', wire);
})();

