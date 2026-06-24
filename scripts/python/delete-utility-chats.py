#!/usr/bin/env python3
"""
Delete VS Code chat sessions whose title is one of TARGET_TITLES.

Run this with VS Code CLOSED. While VS Code is running it keeps the
workspace state DB (state.vscdb) cached in memory and rewrites it on
flush/shutdown, which would clobber any edits made here.

What it does, for the given workspace storage folder:
  1. Reads the chat session index from state.vscdb
     (key: chat.ChatSessionStore.index).
  2. Selects entries whose "title" is in TARGET_TITLES.
  3. Removes those entries from the index and writes it back.
  4. Moves the matching chatSessions/<id>.jsonl files and
     chatEditingSessions/<id>/ folders into a timestamped trash folder.
  5. Backs up state.vscdb (pre-edit) into the same trash folder.

Nothing is hard-deleted: everything removed is preserved in the trash
folder so the operation can be undone manually if needed.

Usage:
  python3 delete-orbit-sharing-chats.py [--workspace-storage DIR] [--force] [--dry-run]

Defaults to the orbit workspace storage folder detected at authoring time.
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time

DEFAULT_WORKSPACE_STORAGE = (
    "/Users/craig/Library/Application Support/Code/User/workspaceStorage/"
    "f2e99a27b072f4f84da16eb0ecb08967"
)

TARGET_TITLES = {
    "Orbit webapp page sharing process",
    "Orbit webapp sharing process",
    "Rebuild extension",
}

INDEX_KEY = "chat.ChatSessionStore.index"


def vscode_running() -> bool:
    """Best-effort check for a running VS Code (macOS / Linux)."""
    try:
        out = subprocess.run(
            ["pgrep", "-f", "Visual Studio Code"],
            capture_output=True,
            text=True,
        )
        return out.returncode == 0 and out.stdout.strip() != ""
    except FileNotFoundError:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workspace-storage", default=DEFAULT_WORKSPACE_STORAGE)
    ap.add_argument(
        "--force",
        action="store_true",
        help="Proceed even if VS Code appears to be running (NOT recommended).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be deleted without changing anything.",
    )
    args = ap.parse_args()

    ws = os.path.abspath(args.workspace_storage)
    db_path = os.path.join(ws, "state.vscdb")
    sessions_dir = os.path.join(ws, "chatSessions")
    editing_dir = os.path.join(ws, "chatEditingSessions")

    if not os.path.isfile(db_path):
        print(f"ERROR: state.vscdb not found at {db_path}", file=sys.stderr)
        return 1

    if vscode_running() and not args.force:
        print(
            "ERROR: VS Code appears to be running. Quit VS Code completely "
            "(Cmd-Q), then re-run. Use --force to override.",
            file=sys.stderr,
        )
        return 2

    # --- read the index ------------------------------------------------
    con = sqlite3.connect(db_path)
    try:
        row = con.execute(
            "SELECT value FROM ItemTable WHERE key=?", (INDEX_KEY,)
        ).fetchone()
    finally:
        con.close()

    if row is None:
        print(f"ERROR: key {INDEX_KEY!r} not found in state.vscdb", file=sys.stderr)
        return 1

    index = json.loads(row[0])
    entries = index.get("entries", {})

    targets = {
        sid: ent
        for sid, ent in entries.items()
        if ent.get("title") in TARGET_TITLES
    }

    if not targets:
        print("No matching sessions found. Nothing to do.")
        return 0

    print(f"Found {len(targets)} matching session(s):")
    for sid, ent in sorted(targets.items(), key=lambda kv: kv[1].get("title", "")):
        print(f"  {sid}  {ent.get('title')!r}")

    if args.dry_run:
        print("\n--dry-run: no changes made.")
        return 0

    # --- prepare trash folder -----------------------------------------
    stamp = time.strftime("%Y%m%d-%H%M%S")
    trash = os.path.join(ws, f"orbit-chat-deletion-trash-{stamp}")
    os.makedirs(trash, exist_ok=True)
    os.makedirs(os.path.join(trash, "chatSessions"), exist_ok=True)
    os.makedirs(os.path.join(trash, "chatEditingSessions"), exist_ok=True)

    # back up the DB before editing
    shutil.copy2(db_path, os.path.join(trash, "state.vscdb.backup"))

    # --- move session files / editing-session folders ------------------
    moved_files = 0
    moved_dirs = 0
    for sid in targets:
        jsonl = os.path.join(sessions_dir, f"{sid}.jsonl")
        if os.path.isfile(jsonl):
            shutil.move(jsonl, os.path.join(trash, "chatSessions", f"{sid}.jsonl"))
            moved_files += 1

        edir = os.path.join(editing_dir, sid)
        if os.path.isdir(edir):
            shutil.move(edir, os.path.join(trash, "chatEditingSessions", sid))
            moved_dirs += 1

    # --- rewrite the index --------------------------------------------
    for sid in targets:
        entries.pop(sid, None)
    index["entries"] = entries

    con = sqlite3.connect(db_path)
    try:
        con.execute(
            "UPDATE ItemTable SET value=? WHERE key=?",
            (json.dumps(index, separators=(",", ":")), INDEX_KEY),
        )
        con.commit()
    finally:
        con.close()

    print()
    print(f"Removed {len(targets)} index entr(y/ies).")
    print(f"Moved {moved_files} session file(s) and {moved_dirs} editing folder(s).")
    print(f"Backup + removed files preserved in:\n  {trash}")
    print("\nDone. You can reopen VS Code.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
