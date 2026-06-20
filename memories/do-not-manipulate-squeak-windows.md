# Never manipulate Squeak windows

The user directive (2026-06-19): **do not ever manipulate Squeak windows.**

This means: do not open, close, move, resize, or `delete` SystemWindows /
notifiers / debuggers in the SqueakJS (Caffeine) world — not via
`mcp_caffeine_evaluate`, not via Playwright, not via any other route. The
SqueakJS world is the user's live environment; leave its windows exactly as
they are.

Specifically forbidden patterns (these were a mistake):

```smalltalk
"DON'T: closing notifiers/debuggers as 'cleanup'"
(Project current world submorphs select: [:m | (m isKindOf: SystemWindow) and: [m label beginsWith: 'Halt']])
  do: [:w | w delete].
```

It is fine to **read** world state (e.g. count windows, read labels) for
verification. Just don't change it.

When a test produces window debris (e.g. `Lam2300 class>>undo:` runs `3 halt`,
popping a `Halt:` notifier), leave it for the user to clear. Verify success by
reading state (window counts/labels), not by tidying up afterward.
