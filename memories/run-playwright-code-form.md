# run_playwright_code invocation form

The `run_playwright_code` tool runs the supplied code as **statements
executed directly** with `page` (and top-level `await`) already in
scope. Do NOT wrap the body in `async () => { ... }` — a bare arrow
function literal is just defined and never invoked, so the call is a
silent no-op (the tool still returns the standard "Page Title / URL /
Snapshot: <unchanged>" template, giving no error).

Correct:

```js
const result = await page.evaluate(async () => { /* ... */ return out; });
return result;
```

Wrong (no-op):

```js
async () => { await page.evaluate(...); }
```

Symptoms of the wrong form: injected DOM never appears in
`screenshot_page`; `fetch` from the page never reaches a loopback sink;
return values never surface. Confirm execution by injecting a
high-z-index magenta div and screenshotting — if it doesn't render,
the code didn't run.

## Observability notes
- `run_playwright_code` surfaces a `return`ed value (e.g.
  `return result;`) in its tool result once execution finishes; long
  evaluations come back via a `deferredResultId` (call again with that
  id + same pageId, no code, to collect the result).
- The page snapshot / `read_page` does NOT reliably surface
  `console.*` output or arbitrary injected DOM. A loopback HTTP sink
  (page `fetch`-POSTs diagnostics to it) is a reliable out-of-band
  channel; the page CAN reach `127.0.0.1:<port>` once code actually runs.
