# Caffeine MCP tools (SqueakJS)

## Finding classes by name (use instead of scanning)

- `mcp_caffeine_findClassNames` (selector `SmalltalkMCPServer>>findClassNames:`)
  returns class names matching a pattern. Plain fragment = case-insensitive
  substring (wrapped `*frag*`); `*` glob respected (`Snowglobe*`, `*Event`).
  Implemented as `Smalltalk classNames select: [:n | glob match: n asString]` —
  reads only the name set, never iterates/instantiates behaviors. This is the
  sanctioned replacement for the forbidden `allClassesDo:` name search.
- NOTE: this image's `String` has no `includesSubstring:`; use `match:`
  (case-insensitive in Squeak) for substring/glob tests.
- The method + the `findClassNames` entry in `initializeTools` live only in the
  running image; they are lost on a fresh image load unless the image is
  snapshotted (do not snapshot yourself — that's a steering prohibition).

## Adding new tools

- Tool methods go on `SmalltalkMCPServer` (instance side); helpers can sit in a `keep-private`-style category.
- Each tool method declares MCP params via `<param: #name type: #string description: '...' required: false>` pragmas, in keyword order. `<result: ...>` is optional but useful documentation.
- Register tools in `SmalltalkMCPServer class>>initializeTools` via `[self registeredInstance] aiToolNamed: #toolName withDescription: '...' forSelector: #selectorKeyword:withMoreKeywords:`.
- After patching `initializeTools`, call `SmalltalkMCPServer initializeTools` to re-run it; this rebuilds `tools` and calls `Webpage current tether notifyOfToolsListChange`. The MCP client picks up new tools without reconnecting; `tool_search` finds them on the next call.
- Type strings used: `'string'`, `'integer'`, `'boolean'`. Optional params: `required: false`.

## Return-shape contract (strict)

Tool methods **must answer either a `Dictionary` or a simple collection of `Association`s** (e.g. `{ #k1 -> v1. #k2 -> v2 }`). Returning a bare `OrderedCollection`/`Array` of Dictionaries breaks the serializer — wrap as `Dictionary at: 'notes' put: array; yourself`. Returning `nil` is fine inside a Dictionary value (`at: 'note' put: nil`) but not as the top-level result; wrap as `{ #note -> nil }`.

## JSON in / Smalltalk dicts out

- Parse JSON params with `WebUtils jsonDecode: aJsonString readStream`. Returns `PseudoJSObject` (JSONObject is gone). It responds to `at:`, `keysAndValuesDo:`, `includesKey:`. Arrays come through as `Array`.
- When converting parsed JSON into a Smalltalk `Dictionary` whose keys you'll match with Symbol literals (`#agent`, etc.), use `k asSymbol`.

## Capability gating

Existing tools (`capabilities`, `role`, `evaluate`, `compileMethod`) and the new `keep*` tools do **not** check capabilities at tool-call time. `evaluate`/`compileMethod` rely on the role being set up first by the agent calling `role` explicitly. New utility tools can follow the same hands-off pattern.

## Reference: the registered-instance pattern

Each tool's receiver is computed lazily: `[self registeredInstance] aiToolNamed: ...`. At call time the per-session `SmalltalkMCPServer` instance handles the call. `self currentSession` inside a tool method gives the `AgentSession` for the current conversation; can be `nil` for tools called outside a session.

## `Webpage>>run:` / `Webpage>>fetch:` and promise rejection

`Webpage>>run: aBlock` runs `aBlock` (which must answer a JS Promise),
attaches handlers, and `wait`s on a `Semaphore` the handlers signal.

Historically it registered **only** a fulfillment handler (`then:`), so a
**rejected** promise never signaled the semaphore and the calling process
blocked forever in `Webpage>>run:` (a non-interruptible `Semaphore>>wait`, not a
Smalltalk exception — `on: Error do:` does NOT save you). Because `fetch:` is
built on `run:` (`fetch(uri).then(r => r.json())`), it deadlocked on a 404, a
network error, or a non-JSON body.

**Fixed (2026-06-19):** `run:` now also passes a rejection handler that sets the
value to `nil` and signals the same semaphore, via the two-argument form
`somePromise then: [:v | ...] then: [:err | ...]`. The JSObjectProxy DNU maps a
keyword selector to the JS method name **up to the first colon** and passes all
args, so `then:then:` calls `.then(onFulfilled, onRejected)`. So `run:` (and
thus `fetch:`) now answers `nil` when the promise rejects.

This `run:` fix lives only in the running image; it must be snapshotted to
survive a page reload (don't snapshot yourself — steering prohibition).

Recovery if you ever re-introduce a deadlock: `Process allInstances select:` on
`suspendedContext printString` matching `'run:'`, then `terminate`.
