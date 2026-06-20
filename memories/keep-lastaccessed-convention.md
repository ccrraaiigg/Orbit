# Keep lastAccessed tracking convention

Active since 2026-05-31. Tag-based (option 1 from designs/keep-notebook-plan.md).

## Rule
When a Keep note's content is **actively used** in a session (informed a decision, answered a question, guided code), stamp it:
```
keepTag(id, {"lastAccessed":"YYYY-MM-DD"})
```

## What counts as "active use"
- Reading and relying on the note's content
- Updating the note (also bumps versionCount)
- NOT: merely seeing it listed in keepOrient or keepQuery results

## Session-start protocol
At session start, after `keepOrient`:
- Report notes with lastAccessed >30 days as "cooling"
- Report notes with lastAccessed >90 days as "archive-eligible"
- Notes with `pinned:true` are exempt from warnings (still get stamped on use)

## ID naming convention
Do NOT recapitulate the note's type in its ID. The `type` tag already carries
that information. Use descriptive topic-based IDs instead (e.g. `mapped-aspect`
not `critique-mapped-aspect`, `snowglobe-loopback` not `arch-snowglobe-loopback`).

IDs need not be globally unique — two notes may share the same ID if their
`type` tag distinguishes them (e.g. an index and a synthesis both called
`ctroc` are fine).

## Current store (13 notes)
IDs (after 2026-06-12 rename to remove type prefixes):
- orbit, controlworks (groups)
- snowglobe-loopback, web-component-callbacks (orbit synthesis)
- controlworks-devguide, objmodel, remote-obj-comm, development-tools (indexes)
- domain-overview, cwadaptor, ctroc (controlworks synthesis)
- mapped-aspect (critique)
- font-cipher (discovery)
