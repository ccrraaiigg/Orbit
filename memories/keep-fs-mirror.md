# Keep note filesystem mirror

Since v1.221.0 (2026-07-01), every Keep *mutation* that flows through
the `CaffeineBridge` is mirrored to the OS filesystem under
`.orbit/keep/`, so agent memory survives image loss and is
diffable/greppable. Design: `designs/keep-fs-persistence.md`.

- **`ops.jsonl`** — append-only, event-sourced mutation log (durable
  source of truth on disk). Records `{seq, at, tool, id, agent, args,
  result}`, one per line, newest appended at end.
- **`notes/<safeId>.md`** — per-note projection: JSON-encoded-scalar
  YAML front-matter (id, agent, createdAt, summary, tags) + content
  body. Regenerable from the log; NOT the source of truth.
- **`edge-tags.json`** — declared edge-tag forward/inverse pairs.

Mechanism:
- `CaffeineBridge` (`website/src/caffeine-bridge.js`) has a new
  `onKeepMutation(params, decodedResult)` hook, sibling to
  `onEvaluateCall`, fired from the `tools/call` case for the mutation
  tools in `KEEP_MUTATION_TOOLS` (`keepPut`, `keepTag`, `keepRemove`,
  `keepNow`-*with-content*, `keepArchive`, `keepDeclareEdgeTag`). Reads
  and `keepNow` without content are skipped (`isKeepMutationCall`).
- `website/src/extension-impl.js` wires the hook to `mirrorKeepMutation`
  (defined right after `caffeineSnapshotCommand`), which the *extension*
  runs with plain `fs` — never the image, never an agent edit tool — so
  no chat Keep/Undo controls attach (same discipline as the Evaluate
  ledger).

Projection rules: put/tag/now-write → write `notes/<id>.md` from full
`result.note`; remove → delete the file; declareEdgeTag → merge into
`edge-tags.json`; archive → op-log only (per-note `archived` flag lags
until the note is next put/tagged — known limitation).

Best-effort: wrapped in try/catch on both sides; a filesystem error
degrades to "not mirrored", never a failed MCP call.

Not yet built: write-back/replay recovery tool, op-log compaction,
SQLite mirror.
