# Snowglobe SetWindowTitle (instruction 14)

## Goal

Have a remote `morphic-window`'s titlebar update when the
corresponding VW `ScheduledWindow`'s label changes (e.g. when a
`SystemBrowser` selects a different class).

## VW side (Snowglobe package)

- **`Snowglobe.SnowglobeWindowDisplayPolicy class>>setWindowTitleForDisplayPolicy:`**
  (protocol 'displaying'): builds and broadcasts an instruction-14
  frame:
  ```
  exit
      startInstruction: 14;
      nextPutInteger: window key;
      nextPutPoint: window extent;     "placeholder; main-thread parser always reads a Point"
      nextPutString: window label asString;
      send
  ```
  Only sends when `exit` and `window key` are both set.

- **`Snowglobe.SnowglobeWindowDisplayPolicy>>setWindowTitle`**
  (protocol 'controlling'): `^self class setWindowTitleForDisplayPolicy: self`.

- **`ScheduledWindow>>label:`** (Snowglobe-package extension to
  Interface-Framework, protocol 'accessing'): after `super label:
  label`, calls
  `self snowglobeDisplayPolicy ifNotNil: [:policy | policy setWindowTitle]`.

- **`ScheduledWindow>>snowglobeDisplayPolicy`** (Snowglobe-package
  extension): reads `damageRepairPolicy` ivar directly via `instVarAt:`
  and answers it iff `isKindOf: Snowglobe.SnowglobeWindowDisplayPolicy`,
  else nil. The public `damageRepairPolicy` accessor unwraps the
  Snowglobe wrapper, so a helper that reads the raw ivar is needed.

VW could not get a class shared `SetWindowTitle = 14` declared
(`addBinding:` raised `ConflictingBindingDefinitions`); literal `14` is
used instead.

## Caffeine side

- New class `SnowglobeTitleEvent` < `SnowglobeEvent` with ivar `label`,
  category 'Snowglobe'.
  - `label` accessor.
  - `proxy:` calls `super proxy:`, then
    `label := jsObjectProxy label asArray asByteArray asString`.
- `SnowglobeInstructions class>>initialize` extended with
  `SetWindowTitle` → 14 in classPool.
- `SnowglobeEvent class>>initialize` adds
  `at: SetWindowTitle put: SnowglobeTitleEvent`.
- `JSSnowglobe class>>instanceMethodNames` extended at index 14 with
  `setWindowTitleIn` (between `unmapWindowIn` and
  `showBitmapAtonCanvas`).
- New `JSSnowglobe class>>setWindowTitleIn` (protocol 'instructions')
  emits worker-side JS that consumes the placeholder extent, then
  posts `{instruction, id, label: stream.nextBytes()}` back.
- `Snowglobe class>>initializeHandlerSelectors:` extended with
  `at: SetWindowTitle put: #setWindowTitle:`.
- `Snowglobe>>setWindowTitle:` (protocol 'instructions'):
  ```
  setWindowTitle: event
      | window windowElement |
      window := windows at: event id ifAbsent: [^self].
      windowElement := window windowElement.
      windowElement ifNil: [^self].
      windowElement setAttribute: #title with: event label
  ```
  `morphic-window`'s `attributeChangedCallback` already redirects
  `title` → `caption` on the titlebar.

## Gotcha encountered

`Snowglobe class` and `SnowglobeEvent class` cache their
instruction-keyed dictionaries from compile-time pool resolution. After
adding `SetWindowTitle` to the `SnowglobeInstructions` shared pool, the
cached dictionaries had `nil → handler` because
`initializeHandlerSelectors:` and `SnowglobeEvent class>>initialize`
were already compiled against the absent binding. Fix: recompile both
methods, then reinitialize:

```
Snowglobe class recompile: #initializeHandlerSelectors:.
SnowglobeEvent class recompile: #initialize.
Snowglobe initialize.
SnowglobeEvent initialize.
```

After that, `Snowglobe handlerSelectorAt: 14` returns
`#setWindowTitle:`, and `SnowglobeEvent classPool at: #EventClasses`
maps `14 → SnowglobeTitleEvent`.

## Verification status

- VW: invoking `setWindowTitle` on a real `SnowglobeWindowDisplayPolicy`
  raises no error; the bytes are pushed onto `exit`.
- Caffeine: the dispatch tables are correct.
- End-to-end title change has not been observed yet because every
  existing live `Snowglobe` session has a Web Worker built before
  `JSSnowglobe class>>instanceMethodNames` was extended. The worker's
  `instanceMethodNames` array is baked at worker construction. Naïvely
  nilling and recreating `entrance>>worker` does not rewire the closure
  installed on `connection onMessage:` (it captured the old worker).
  Re-invoking `Snowglobe>>connection:` re-installs the closure but
  fails because the open WebSocket is in a state where the message
  payload isn't a Blob.
- Steering forbids me from reloading the page. The Caffeine image was
  snapshotted to IndexedDB via `Smalltalk snapshot: true andQuit: false`
  so the next reload will boot with all changes installed and the new
  worker built fresh.

## Next time

To verify end-to-end:
1. Reload the Orbit page (user-initiated).
2. From VW, open a `FullSystemBrowser`, expose its window via
   `includeInSnowglobe; map`.
3. Change the selected class. The browser's `updateWindowLabel` →
   `ScheduledWindow>>label:` will invoke
   `setWindowTitle`, broadcast instruction 14, and the
   `morphic-window` titlebar should update.

If it doesn't, instrument by:
- `(latest := Snowglobe allInstances last) windows keys` to confirm the
  window is registered.
- Add a `Transcript show:` in `Snowglobe>>setWindowTitle:` to confirm
  it's invoked.
- Inspect the `morphic-window` element's `title` and `caption`
  attributes via Playwright.
