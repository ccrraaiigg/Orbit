// <transient-window> Web Component
//
// Wraps a Morphic canvas in a borderless, undecorated window for transient
// UI such as pop-up menus and pull-down menus.  These windows have no
// titlebar, no border chrome, and do not appear in the icon manager.
//
// Usage:
//
//   var tw = document.createElement('transient-window');
//   tw.style.top = '100px';
//   tw.style.left = '200px';
//   tw.appendChild(canvas);
//   document.getElementById('Morphic').appendChild(tw);
//
// Clicking inside the window brings it to the front.  The close event
// can be dispatched programmatically:
//
//   tw.dispatchEvent(new CustomEvent('morphic-close', { bubbles: true }));

class TransientWindow extends HTMLElement {

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static _allWindows() {
    return Array.from(document.querySelectorAll('transient-window, morphic-window'));
  }

  _bringToFront() {
    var self = this;
    var allWins = TransientWindow._allWindows();
    var morphics = allWins.filter(function(w) {
      return w.tagName.toLowerCase() !== 'transient-window';
    });
    var transients = allWins.filter(function(w) {
      return w.tagName.toLowerCase() === 'transient-window';
    });
    // Transient windows layer above all morphic windows
    var transientBase = morphics.length;
    if (transients.length <= 1) {
      this.style.zIndex = transientBase;
      return;
    }
    // Desired order: others in their current relative order, then self on top
    var others = transients.filter(function(w) { return w !== self; });
    others.sort(function(a, b) {
      return (parseInt(a.style.zIndex, 10) || 0) - (parseInt(b.style.zIndex, 10) || 0);
    });
    for (var i = 0; i < others.length; i++) {
      others[i].style.zIndex = transientBase + i;
    }
    this.style.zIndex = transientBase + others.length;
  }

  connectedCallback() {
    this.style.position = 'absolute';
    this._render();
    this._attachBehavior();
  }

  disconnectedCallback() {
    if (this._onPointerDown) {
      this.removeEventListener('pointerdown', this._onPointerDown, true);
    }
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          position: absolute;
          z-index: 100;
          isolation: isolate;
          padding: 0;
          margin: 0;
          border: none;
          background: transparent;
        }
      </style>
      <slot></slot>
    `;
  }

  _attachBehavior() {
    var self = this;

    if (this._onPointerDown) {
      this.removeEventListener('pointerdown', this._onPointerDown, true);
    }

    this._onPointerDown = function() {
      self._bringToFront();
    };
    this.addEventListener('pointerdown', this._onPointerDown, true);

    this._bringToFront();
  }

  isOccluded() {
    return false;
  }

  static hotReload() {
    var ExistingClass = customElements.get('transient-window');
    return fetch('js/components/transient-window.js?' + Date.now())
      .then(function(r) { return r.text(); })
      .then(function(src) {
        src = src.replace(/customElements\.define\([^)]+\);?/, '');
        var NewClass = new Function(src + '\nreturn TransientWindow;')();
        Object.getOwnPropertyNames(NewClass.prototype).forEach(function(key) {
          if (key !== 'constructor') {
            ExistingClass.prototype[key] = NewClass.prototype[key];
          }
        });
        Object.getOwnPropertyNames(NewClass).forEach(function(key) {
          if (key !== 'prototype' && key !== 'length' && key !== 'name') {
            var desc = Object.getOwnPropertyDescriptor(NewClass, key);
            Object.defineProperty(ExistingClass, key, desc);
          }
        });
        document.querySelectorAll('transient-window').forEach(function(tw) {
          if (tw._onPointerDown) {
            tw.removeEventListener('pointerdown', tw._onPointerDown, true);
          }
          tw._render();
          tw._attachBehavior();
        });
      });
  }
}

customElements.define('transient-window', TransientWindow);
