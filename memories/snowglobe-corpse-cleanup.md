# Snowglobe corpse cleanup (Caffeine side)

Symptom: `Snowglobe allInstances` reports many `a Snowglobe which was never
connected` instances, suggesting a leak.

**Most of them are not leaked — they are uncollected garbage.** `allInstances`
in SqueakJS returns objects that are unreachable but not yet swept. Always
`Smalltalk garbageCollect` *before* counting. On 2026-07-29 this took 9
instances down to 1 in a single GC.

Two real retainers were found:

1. **`AIToolCall` classVar `Calls`** — the MCP tool-call cache. It holds the
   argument/result graph of past `evaluate` calls, so anything you merely
   *mentioned* in an earlier evaluation stays reachable. Clear it before
   concluding that an object is leaked. (Symptom: `Utilities pointersTo:`
   shows only Arrays and `AgentSession_<id>>>DoIt` contexts, with no named
   binding anywhere, yet the object survives GC.)

2. **`SnowglobeMorphicService` classVar `LoopbackSnowglobes`** — lazily
   created by `SnowglobeMorphicService class>>loopbackSnowglobes`, added to
   by `markSnowglobeAsLoopback:` (from `snowglobe:`), and **never removed
   from**, so a stopped loopback service pinned a dead Snowglobe forever.

   Fixed 2026-07-29: `loopbackSnowglobes` now backs the set with a `WeakSet`
   (migrating an existing `IdentitySet`'s contents on first access). Weak
   rather than an `isOpen not` prune, because `SnowglobeMorphicService
   class>>on:` marks a Snowglobe *before* it connects — an `isOpen not` sweep
   triggered by an unrelated `Snowglobe>>mapWindow:` (which calls
   `isLoopback`) could drop the marker mid-setup and give the loopback
   windows doubled chrome. A live loopback Snowglobe is held strongly by its
   service, so weak storage can't lose it.

   Caffeine's `WeakSet` has no `finalizeValues` and its `size` (tally) goes
   stale after a slot dies; `do:`/`includes:` are correct. Count live entries
   with `set inject: 0 into: [:a :e | a + 1]`, not `set size`.

## Finding retainers: `Utilities pointersTo:`

`Utilities pointersTo: anObject` answers an Array of direct referrers. Useful
for a 2-level walk, but note:

- It's a full-heap scan; two or three nested calls will exceed the MCP
  `evaluate` fast path and return a `taskId` (poll `getTaskStatus`).
- Results are dominated by your own evaluation debris: the
  `AgentSession_<sessionId>>>DoIt` `MethodContext`, the `#result-><value>`
  `Association` the harness retains for the previous call, the `AIToolCall`
  `Calls` cache, and the Arrays `pointersTo:` itself just built. Ignore
  anything whose chain bottoms out in those; look for a named
  classVar/global binding (that's how `#LoopbackSnowglobes->an
  IdentitySet(...)` was spotted).
- Locate the owner of a classVar you find with
  `Smalltalk allClassesDo: [:c | (c classPool includesKey: #Name) ifTrue: [...]]`.

## Don't source-scan the whole image

`Smalltalk allClassesDo:` + `(c >> sel) getSource` to find senders takes long
enough to become a long-running task and then some — one such scan had to be
killed with `cancelEvaluation`. Search literals instead
(`(c >> sel) literals includes: #someSelector`), which is fast, or use
`findClassNames` when you only need to locate a class.

## Gotchas hit along the way

- VisualWorks has no `instVarNamed:` — use `instVarAt:` with an index from
  `allInstVarNames`. Class-side ivars: `TheClass instVarAt: (TheClass class
  allInstVarNames indexOf: 'exit')`. Caffeine/Squeak *does* have
  `instVarNamed:`.
- Caffeine `ByteString` has no `includesSubstring:`; use
  `includesSubstring:caseSensitive:`.
