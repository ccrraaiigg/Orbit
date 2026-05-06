// spec-compiler.js — Compile a decoded VisualWorks WindowSpec (as JSON)
// into live Web Components.
//
// Input shape produced by the Smalltalk-side walker (see
// summaries/2026-05-05-windowspec-walker.md for the source). Each spec
// object is a plain JS object with a `__type` field naming its
// VisualWorks class, and the named instance variables as own properties.
// Composite values use these envelopes:
//
//   { __type: 'LayoutFrame', l, lF, t, tF, r, rF, b, bF }
//   { __type: 'Point', x, y }
//   { __type: 'Rectangle', l, t, r, b }
//   { __type: 'Color', rgb }
//   { __type: 'UserMessage', key, defaultString, catalogID? }
//   { __type: 'Symbol', name }
//   { __type: 'SpecCollection', collection: [...] }
//
// Top-level usage:
//
//   import { compileWindowSpec } from './spec-compiler.js';
//   const win = compileWindowSpec(specJson, { aspects });
//   document.body.appendChild(win);
//
// `aspects` is an optional map { aspectName: ValueHolder-ish } whose
// entries supply two-way binding for fields whose `model:` keys reference
// a named aspect (e.g. 'pageHolder').  A ValueHolder-ish object exposes
// `.value` (read/write) and an `addEventListener('change', fn)` /
// `removeEventListener` pair (or duck-typed `subscribe(fn) -> unsubscribe`).
//
// The compiler dispatches per `__type` to a handler in `SPEC_HANDLERS`.
// Unknown spec classes degrade gracefully into a labeled placeholder so
// the rest of the window still renders.

// Note: this module assumes <morphic-window> and <workbook-window> are
// already registered in the page (loaded by orbit.html as classic
// scripts). We don't import them here, since reimporting non-idempotent
// modules would attempt to re-define their custom elements.

// ---------- helpers ----------

export function applyLayoutFrame(el, frame) {
  if (!frame || frame.__type !== 'LayoutFrame') return;
  Object.assign(el.style, {
    position: 'absolute',
    left:   `calc(${(frame.lF || 0) * 100}% + ${frame.l || 0}px)`,
    top:    `calc(${(frame.tF || 0) * 100}% + ${frame.t || 0}px)`,
    width:  `calc(${((frame.rF || 0) - (frame.lF || 0)) * 100}% + ${(frame.r || 0) - (frame.l || 0)}px)`,
    height: `calc(${((frame.bF || 0) - (frame.tF || 0)) * 100}% + ${(frame.b || 0) - (frame.t || 0)}px)`
  });
}

export function userMessageText(msg) {
  if (msg == null) return '';
  if (typeof msg === 'string') return msg;
  if (msg && msg.__type === 'UserMessage') return msg.defaultString || msg.key || '';
  if (msg && msg.__type === 'Symbol')     return msg.name || '';
  return String(msg);
}

function aspectName(value) {
  if (value && value.__type === 'Symbol') return value.name;
  if (typeof value === 'string') return value;
  return null;
}

function bindAspect(aspects, name, getter, setter) {
  if (!name || !aspects || !aspects[name]) return null;
  const holder = aspects[name];
  if (setter) setter(holder.value);
  let unsub = null;
  if (typeof holder.subscribe === 'function') {
    unsub = holder.subscribe(v => setter && setter(v));
  } else if (typeof holder.addEventListener === 'function') {
    const fn = () => setter && setter(holder.value);
    holder.addEventListener('change', fn);
    unsub = () => holder.removeEventListener('change', fn);
  }
  return { holder, unsub, write: v => { holder.value = v; } };
}

// ---------- spec handlers ----------

const SPEC_HANDLERS = {

  FullSpec(spec, ctx) {
    // Window envelope around the component tree.
    const win = spec.window ? compile(spec.window, ctx) : document.createElement('div');
    if (spec.component) {
      const body = compile(spec.component, ctx);
      // Attach component subtree to the window's body region.
      if (typeof win.attachBody === 'function') win.attachBody(body);
      else win.appendChild(body);
    }
    return win;
  },

  WindowSpec(spec, ctx) {
    const wrap = document.createElement('morphic-window');
    wrap.setAttribute('caption', userMessageText(spec.label));
    if (spec.bounds && spec.bounds.__type === 'Rectangle') {
      wrap.style.left   = (spec.bounds.l) + 'px';
      wrap.style.top    = (spec.bounds.t) + 'px';
      wrap.style.width  = (spec.bounds.r - spec.bounds.l) + 'px';
      wrap.style.height = (spec.bounds.b - spec.bounds.t) + 'px';
    }
    if (spec.min && spec.min.__type === 'Point' && spec.min.x && spec.min.y) {
      wrap.style.minWidth  = spec.min.x + 'px';
      wrap.style.minHeight = spec.min.y + 'px';
    }
    // Body: a positioned container the FullSpec handler will fill.
    const body = document.createElement('div');
    Object.assign(body.style, {
      position: 'absolute',
      left: '6px', top: '28px', right: '6px', bottom: '6px',
      background: '#ece9d8',
      overflow: 'hidden'
    });
    wrap.appendChild(body);
    wrap.attachBody = (child) => body.appendChild(child);

    // Menu bar / toolbar are by aspect name; we expose them so an
    // outer component (e.g. workbook-window) can wire them up.
    wrap.dataset.menuAspect    = aspectName(spec.menu) || '';
    wrap.dataset.toolBarAspect = aspectName(spec.toolBar) || '';
    return wrap;
  },

  SpecCollection(spec, ctx) {
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.width  = '100%';
    container.style.height = '100%';
    (spec.collection || []).forEach(child => {
      const el = compile(child, ctx);
      applyLayoutFrame(el, child.layout);
      container.appendChild(el);
    });
    return container;
  },

  TabControlSpec(spec, ctx) {
    const el = document.createElement('div');
    el.dataset.specName = spec.name || '';
    Object.assign(el.style, {
      display: 'flex',
      flexDirection: 'column',
      background: '#ece9d8',
      border: '1px solid #8a8676',
      boxSizing: 'border-box'
    });
    const strip = document.createElement('div');
    Object.assign(strip.style, {
      flex: '0 0 22px',
      display: 'flex',
      alignItems: 'flex-end',
      padding: '2px 4px 0 4px',
      background: '#ece9d8',
      borderBottom: '1px solid #8a8676'
    });
    const host = document.createElement('div');
    Object.assign(host.style, {
      flex: '1 1 auto',
      background: '#ffffff',
      overflow: 'auto'
    });
    el.appendChild(strip);
    el.appendChild(host);

    const labels = (spec.labels || []).map(userMessageText);
    let active = 0;
    const renderTabs = () => {
      strip.innerHTML = '';
      labels.forEach((lbl, i) => {
        const t = document.createElement('div');
        t.textContent = lbl || ('Page ' + (i + 1));
        Object.assign(t.style, {
          padding: '3px 12px',
          marginRight: '2px',
          background: i === active ? '#fff' : '#d6d2c0',
          border: '1px solid #8a8676',
          borderBottom: 'none',
          borderTopLeftRadius: '3px',
          borderTopRightRadius: '3px',
          cursor: 'default',
          position: 'relative',
          top: i === active ? '1px' : '0'
        });
        t.addEventListener('click', () => { active = i; renderTabs(); ctx.fire('tab-change', { name: spec.name, index: i }); });
        strip.appendChild(t);
      });
    };
    renderTabs();

    bindAspect(ctx.aspects, aspectName(spec.model), null, v => {
      if (Array.isArray(v)) {
        labels.length = 0;
        v.forEach(s => labels.push(s));
        renderTabs();
      }
    });
    return el;
  },

  InputFieldSpec(spec, ctx) {
    const el = document.createElement('input');
    el.type = 'text';
    el.dataset.specName = spec.name || '';
    if (spec.isReadOnly) el.readOnly = true;
    Object.assign(el.style, {
      boxSizing: 'border-box',
      font: '11px "Segoe UI", "Helvetica Neue", Arial, sans-serif',
      padding: '2px 4px',
      background: spec.isReadOnly ? '#f8f6ec' : '#fff',
      border: '1px solid #b8b4a4',
      color: '#333'
    });
    if (spec.helpText) el.title = userMessageText(spec.helpText);
    const bound = bindAspect(ctx.aspects, aspectName(spec.model),
      null, v => { el.value = v == null ? '' : String(v); });
    el.addEventListener('input', () => bound && bound.write(el.value));
    return el;
  },

  LabelSpec(spec, ctx) {
    const el = document.createElement('div');
    el.dataset.specName = spec.name || '';
    el.textContent = userMessageText(spec.label);
    Object.assign(el.style, {
      font: '11px "Segoe UI", "Helvetica Neue", Arial, sans-serif',
      color: '#333'
    });
    return el;
  },

  ActionButtonSpec(spec, ctx) {
    const el = document.createElement('button');
    el.type = 'button';
    el.dataset.specName = spec.name || '';
    el.textContent = userMessageText(spec.label);
    el.addEventListener('click', () => ctx.fire('action', {
      name: spec.name, action: aspectName(spec.model)
    }));
    return el;
  },

  TextEditorSpec(spec, ctx) {
    const el = document.createElement('textarea');
    el.dataset.specName = spec.name || '';
    Object.assign(el.style, {
      boxSizing: 'border-box',
      width: '100%', height: '100%',
      font: '12px Menlo, Consolas, "Courier New", monospace',
      border: '1px solid #b8b4a4',
      background: '#fff',
      padding: '4px 6px',
      resize: 'none'
    });
    if (spec.isReadOnly) el.readOnly = true;
    const bound = bindAspect(ctx.aspects, aspectName(spec.model),
      null, v => { el.value = v == null ? '' : String(v); });
    el.addEventListener('input', () => bound && bound.write(el.value));
    return el;
  },

  RegionSpec(spec, ctx) {
    const el = document.createElement('div');
    el.dataset.specName = spec.name || '';
    Object.assign(el.style, { background: '#ddd', border: '1px solid #b8b4a4' });
    return el;
  },

  DividerSpec(spec, ctx) {
    const el = document.createElement('div');
    el.style.background = '#8a8676';
    return el;
  },

  SubCanvasSpec(spec, ctx) {
    // Placeholder: a sub-canvas embeds another window spec by name.
    // Without access to the sub-spec here we render a labeled box.
    const el = document.createElement('div');
    el.dataset.specName = spec.name || '';
    el.textContent = '[SubCanvas: ' + (spec.majorKey || spec.minorKey || '?') + ']';
    Object.assign(el.style, {
      background: '#fafaf2', border: '1px dashed #b8b4a4',
      color: '#666', font: '11px sans-serif', padding: '4px'
    });
    return el;
  }
};

function unknownSpec(spec) {
  const el = document.createElement('div');
  el.textContent = '[' + (spec.__type || 'Spec') + (spec.name ? (': ' + spec.name) : '') + ']';
  Object.assign(el.style, {
    background: '#fff4d6', border: '1px dashed #b08a44',
    color: '#7a5a00', font: '11px sans-serif', padding: '4px'
  });
  return el;
}

function compile(spec, ctx) {
  if (!spec || typeof spec !== 'object') return document.createTextNode(String(spec));
  const handler = SPEC_HANDLERS[spec.__type];
  return handler ? handler(spec, ctx) : unknownSpec(spec);
}

// ---------- public entry point ----------

export function compileWindowSpec(specJson, { aspects = {}, onEvent = null } = {}) {
  const ctx = {
    aspects,
    fire(type, detail) {
      if (typeof onEvent === 'function') onEvent({ type, detail });
    }
  };
  return compile(specJson, ctx);
}

// Convenience: tiny ValueHolder for callers that don't bring their own.
export class ValueHolder extends EventTarget {
  constructor(initial) {
    super();
    this._value = initial;
  }
  get value() { return this._value; }
  set value(v) {
    if (v === this._value) return;
    this._value = v;
    this.dispatchEvent(new CustomEvent('change', { detail: v }));
  }
}

// Expose for non-module callers / quick experimentation in the page.
if (typeof window !== 'undefined') {
  window.OrbitSpecCompiler = { compileWindowSpec, applyLayoutFrame, ValueHolder };
}
