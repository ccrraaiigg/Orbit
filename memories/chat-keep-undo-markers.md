# Hooking chat Keep/Undo for MCP `evaluate` calls

## Core finding (empirically confirmed 2026-06-18)

VS Code's chat **Keep/Undo** buttons come **only** from Copilot's chat
editing session, which tracks edits made by **Copilot's own
instrumented tools** (its edit/create-file tools, and its terminal
tool, which snapshots files before/after itself).

- Copilot does **NOT** run a generic filesystem watcher over the
  workspace during a turn.
- An edit written by the Orbit **extension** (`fs.writeFileSync`) is
  invisible to the editing session → **no buttons**. (We tried the
  proxy-intercept-and-write approach first; it produced the marker
  file but no buttons.)
- An MCP tool's on-disk side effects are equally opaque to Copilot →
  no buttons.
- Only an edit the **agent** makes with its own edit/create-file tool
  produces buttons.

There is **no public API** for a third-party extension to add entries
to Copilot's editing session, and **no "Undo clicked" event**.

## Working design (the one in the tree)

To get native Keep/Undo tied to a remote `evaluate` call **and** react
to Undo:

1. **Agent writes the marker** (steering in
   `.github/copilot-instructions.md`, section "Always write an undo
   marker before an 'evaluate' tool call"): before each
   `mcp_2300-*_evaluate` call, the agent creates a per-call file
   `.orbit/toolLogs/evaluate/<id>.json` with its create-file tool.
   Creating it yields the Keep/Undo control.

2. **Undo = file deletion.** Pressing Undo on a *created* file deletes
   it. The `<id>` is in the filename, so detection is unambiguous (no
   content-diffing, no LIFO guessing).

3. **Extension watches the directory.** `setupEvalUndoWatcher(context)`
   in `extension-impl.js` arms a `createFileSystemWatcher` on
   `.orbit/toolLogs/evaluate/*.json`:
   - `onDidCreate` → record `id -> {backend, at}` (read from file).
   - `onDidDelete` → `signalEvaluateUndo({callId, backend})`.

4. `signalEvaluateUndo` is the **seam** that will deliver the undo to
   the remote image (the remote tracks each call's effect itself and
   only needs the `<id>`). Transport TBD (WebDAV action file or MCP
   tools/call); currently just logs to the Orbit output channel.

`.orbit/toolLogs/evaluate` must be a **directory**, not a file.

## Things that did NOT work / pitfalls

- Per-call dir + delete detection replaced an earlier single-file
  overwrite design whose watcher treated *any* external change as
  undo (false positives, e.g. an unrelated agent edit).
- The proxy-side `onToolCall` hook in `mcp-proxy.js` was reverted —
  it's useless for button production since the extension can't make
  Copilot track its writes.

## Reliability caveat

This is **steering-driven**: the model must remember to write the
marker before every evaluate. It will occasionally forget. Accepted
trade-off for using the native buttons. (A fully reliable alternative
would be an Orbit-owned affordance — CodeLens / status-bar / page UI —
but that isn't the chat Keep/Undo control.)
