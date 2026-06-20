# Keep audit trail convention

Since 2026-06-12, the Keep MCP tools handle audit logging internally
(persisted to IndexedDB by the Caffeine image). Agents do NOT need to
maintain a separate `./audit/` JSONL file for Keep operations.

The tools write each mutation to an IndexedDB-backed log before
applying it, enabling crash recovery without agent cooperation.
