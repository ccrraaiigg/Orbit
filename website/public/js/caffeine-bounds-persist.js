// Persist the Caffeine window (#embeddedSqueak) bounds across page reloads.
// Saves top, left, width, height to /caffeine-bounds.json via PUT on change.
// Restores them from the same file (served statically) on load.

(function() {
  var BOUNDS_URL = '/caffeine-bounds.json';
  var saveTimer = null;

  function readBounds(el) {
    return {
      top: el.style.top,
      left: el.style.left,
      width: el.style.width,
      height: el.style.height
    };
  }

  function saveBounds(el) {
    var b = readBounds(el);
    if (!b.top && !b.left && !b.width && !b.height) return;
    fetch(BOUNDS_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b)
    }).catch(function() {});
  }

  function nudgeResize(el) {
    // Trigger a 1px resize so the SqueakJS VM re-renders at the restored size.
    // Wait for the iframe to be ready before nudging.
    var iframe = el.querySelector('iframe');
    if (!iframe) return;

    function doNudge() {
      var w = parseFloat(el.style.width);
      if (!w) return;
      var MW = customElements.get('morphic-window');
      if (!MW) return;
      var side = MW.prototype.sideBorderThickness.call(el);
      var title = MW.prototype.titlebarThickness.call(el);
      var h = parseFloat(el.style.height);

      // Grow 1px
      el.style.width = (w + 1) + 'px';
      iframe.width = (w + 1) - 2 * side;

      // Fire resize on iframe contentWindow
      try { iframe.contentWindow.dispatchEvent(new Event('resize')); } catch (_) {}

      // Invoke onResizeComplete if available
      if (typeof el.onResizeComplete === 'function') {
        el.onResizeComplete({
          x: Math.round(parseFloat(el.style.left)) + side,
          y: Math.round(parseFloat(el.style.top)) + title,
          width: Math.round(w + 1) - 2 * side,
          height: Math.round(h) - title - side,
          done: function() {
            // Shrink back
            el.style.width = w + 'px';
            iframe.width = w - 2 * side;
            try { iframe.contentWindow.dispatchEvent(new Event('resize')); } catch (_) {}
            if (typeof el.onResizeComplete === 'function') {
              el.onResizeComplete({
                x: Math.round(parseFloat(el.style.left)) + side,
                y: Math.round(parseFloat(el.style.top)) + title,
                width: Math.round(w) - 2 * side,
                height: Math.round(h) - title - side,
                done: function() {}
              });
            }
          }
        });
      } else {
        // No callback yet; just shrink back after a frame
        requestAnimationFrame(function() {
          el.style.width = w + 'px';
          iframe.width = w - 2 * side;
          try { iframe.contentWindow.dispatchEvent(new Event('resize')); } catch (_) {}
        });
      }
    }

    // Wait for onResizeComplete to be installed by SqueakJS, then nudge.
    function waitForCallback() {
      if (typeof el.onResizeComplete === 'function') {
        doNudge();
      } else {
        setTimeout(waitForCallback, 500);
      }
    }

    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
      waitForCallback();
    } else {
      iframe.addEventListener('load', function() {
        waitForCallback();
      });
    }
  }

  function restoreBounds(el) {
    fetch(BOUNDS_URL).then(function(r) {
      if (!r.ok) return;
      return r.json();
    }).then(function(b) {
      if (!b) return;
      if (b.top) el.style.top = b.top;
      if (b.left) el.style.left = b.left;
      if (b.width) el.style.width = b.width;
      if (b.height) el.style.height = b.height;
      var iframe = el.querySelector('iframe');
      if (iframe && b.width && b.height) {
        var MW = customElements.get('morphic-window');
        if (MW && MW.prototype.sideBorderThickness && MW.prototype.titlebarThickness) {
          var side = MW.prototype.sideBorderThickness.call(el);
          var title = MW.prototype.titlebarThickness.call(el);
          iframe.width = parseFloat(b.width) - 2 * side;
          iframe.height = parseFloat(b.height) - title - side;
        }
      }
      nudgeResize(el);
    }).catch(function() {});
  }

  function debouncedSave(el) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function() { saveBounds(el); }, 300);
  }

  function attach(el) {
    if (el.__boundsPersistAttached) return;
    el.__boundsPersistAttached = true;
    restoreBounds(el);
    var observer = new MutationObserver(function() {
      debouncedSave(el);
    });
    observer.observe(el, { attributes: true, attributeFilter: ['style'] });
  }

  function wire() {
    var el = document.getElementById('embeddedSqueak');
    if (el) attach(el);
  }

  wire();
  window.addEventListener('load', wire);
  document.addEventListener('DOMContentLoaded', wire);
})();
