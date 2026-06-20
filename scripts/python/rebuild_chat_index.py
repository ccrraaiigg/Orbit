#!/usr/bin/env python3
"""Rebuild the Copilot chat history index from the session files on disk.

VS Code shows the chat history from `chat.ChatSessionStore.index` in
state.vscdb. If that index was truncated, sessions whose .jsonl files still
exist won't appear. This rebuilds the index to include every session file.

SAFETY:
  * Refuses to run while VS Code ("Code Helper"/Electron) is running, because
    the app holds state.vscdb open and would clobber the result on exit.
  * Backs up state.vscdb before writing.
  * Merges: keeps existing index entries, adds any missing ones. Never deletes.

Usage:
  python3 rebuild_chat_index.py            # dry run (prints what it would add)
  python3 rebuild_chat_index.py --apply    # write the index
"""
import json, os, sqlite3, sys, glob, subprocess, shutil, time

HOME = os.path.expanduser("~")
WS = os.path.join(
    HOME,
    "Library/Application Support/Code/User/workspaceStorage/"
    "f2e99a27b072f4f84da16eb0ecb08967",
)
DB = os.path.join(WS, "state.vscdb")
SESSIONS = os.path.join(WS, "chatSessions")
KEY = "chat.ChatSessionStore.index"
APPLY = "--apply" in sys.argv
FORCE = "--force" in sys.argv


def db_open_pids():
    """Return PIDs that currently have state.vscdb (or its -wal/-shm) open.

    This is the precise question that matters: if no process holds the DB
    open, writing it can't be clobbered. Avoids fragile process-name matching.
    """
    pids = set()
    for path in (DB, DB + "-wal", DB + "-shm"):
        if not os.path.exists(path):
            continue
        try:
            out = subprocess.run(["lsof", "-t", path],
                                 capture_output=True, text=True).stdout
        except FileNotFoundError:
            return set()  # no lsof; can't check, assume safe
        for line in out.split():
            line = line.strip()
            if line.isdigit():
                pids.add(line)
    return pids


def _apply_delta(state, k, v, kind):
    """Apply one delta op to the reconstructed session state in place."""
    if not k:
        return
    cur = state
    for key in k[:-1]:
        if isinstance(cur, list) and isinstance(key, int):
            if 0 <= key < len(cur):
                cur = cur[key]
            else:
                return
        elif isinstance(cur, dict):
            cur = cur.setdefault(key, {})
        else:
            return
    last = k[-1]
    if isinstance(cur, list) and isinstance(last, int):
        if kind == 1 and 0 <= last < len(cur):
            cur[last] = v
        return
    if not isinstance(cur, dict):
        return
    if kind == 1:  # set/replace
        cur[last] = v
    elif kind == 2:  # append/extend array
        arr = cur.get(last)
        if not isinstance(arr, list):
            arr = []
            cur[last] = arr
        if isinstance(v, list):
            arr.extend(v)
        else:
            arr.append(v)


def parse_session(path):
    """Return an index entry dict for a session .jsonl file, or None.

    Reconstructs session state from the kind:0 snapshot plus kind:1 (set) and
    kind:2 (append) delta lines.
    """
    sid = os.path.splitext(os.path.basename(path))[0]
    state = None
    try:
        with open(path) as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    d = json.loads(ln)
                except Exception:
                    continue
                kind = d.get("kind")
                if kind == 0 and "v" in d:
                    state = d["v"]
                elif kind in (1, 2) and state is not None:
                    _apply_delta(state, d.get("k") or [], d.get("v"), kind)
    except Exception:
        return None
    if state is None:
        return None

    created = state.get("creationDate") or 0
    title = state.get("customTitle")
    reqs = state.get("requests") or []
    if not title:
        # fall back to first user message text
        for r in reqs:
            msg = r.get("message") or {}
            txt = msg.get("text") if isinstance(msg, dict) else None
            if txt:
                title = txt.strip().splitlines()[0][:80]
                break
    if not title:
        title = "(untitled chat)"
    max_ts = 0
    for r in reqs:
        ts = r.get("timestamp")
        if isinstance(ts, (int, float)) and ts > max_ts:
            max_ts = ts
    if max_ts == 0:
        max_ts = created or int(os.path.getmtime(path) * 1000)
    header = state

    return {
        "sessionId": sid,
        "title": title,
        "lastMessageDate": max_ts,
        "timing": {
            "created": created or max_ts,
            "lastRequestStarted": max_ts,
            "lastRequestEnded": max_ts,
        },
        "initialLocation": header.get("initialLocation", "panel"),
        "hasPendingEdits": bool(header.get("hasPendingEdits", False)),
        "isEmpty": len(reqs) == 0,
        "isExternal": False,
        "lastResponseState": 1,
        "permissionLevel": "autoApprove",
    }


def _iter_timestamps(obj):
    """Deprecated: kept for compatibility. Not used after delta replay."""
    return ()


def main():
    pids = db_open_pids()
    if pids and not FORCE:
        print(f"REFUSING: state.vscdb is open by PID(s) {', '.join(sorted(pids))} "
              "(VS Code is likely running). Quit VS Code entirely (Cmd-Q) and "
              "re-run. If you're sure nothing is using it, pass --force.\n"
              "  Inspect with:  lsof '" + DB + "'")
        sys.exit(1)
    if not os.path.isfile(DB):
        print(f"state.vscdb not found at {DB}")
        sys.exit(1)

    con = sqlite3.connect(DB)
    cur = con.cursor()
    row = cur.execute(
        "SELECT value FROM ItemTable WHERE key=?", (KEY,)).fetchone()
    index = json.loads(row[0]) if row else {"version": 1, "entries": {}}
    entries = index.setdefault("entries", {})
    before = len(entries)

    added = 0
    skipped_empty = 0
    for path in sorted(glob.glob(os.path.join(SESSIONS, "*.jsonl"))):
        sid = os.path.splitext(os.path.basename(path))[0]
        if sid in entries:
            continue
        entry = parse_session(path)
        if entry is None:
            print(f"  skip (unparseable): {sid}")
            continue
        # drop empty/untitled sessions (no requests, no real title)
        if entry["isEmpty"] or entry["title"] == "(untitled chat)":
            skipped_empty += 1
            continue
        entries[sid] = entry
        added += 1

    print(f"Index entries: {before} -> {before + added}  (+{added}; "
          f"dropped {skipped_empty} empty/untitled)")
    if added == 0:
        print("Nothing to add.")
        con.close()
        return

    if not APPLY:
        # preview a few
        for sid, e in list(entries.items())[-min(added, 10):]:
            print(f"  + {e['title'][:60]}")
        print("\nDry run. Re-run with --apply to write the index.")
        con.close()
        return

    backup = DB + f".prechatrestore-{int(time.time())}"
    shutil.copy2(DB, backup)
    print(f"Backed up state.vscdb -> {os.path.basename(backup)}")
    index["version"] = index.get("version", 1)
    cur.execute(
        "INSERT INTO ItemTable(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (KEY, json.dumps(index)),
    )
    con.commit()
    con.close()
    print("Index written. Reopen VS Code to see all sessions.")


if __name__ == "__main__":
    main()
