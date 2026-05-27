#!/usr/bin/env python3
"""Rank Copilot chat sessions in this workspace by transcript word count
and show their user-facing titles.

Word count = whitespace-delimited tokens in the raw transcript .jsonl
(includes JSON structural tokens — useful for relative comparison only).

Title resolution, in order:
  1. `customTitle` from the chatSessions/<sid>.jsonl event log (latest wins).
  2. First user message text from a `requests` entry.
  3. "(no title)".
"""
import json, os, re, sys

WS = "/Users/craig/Library/Application Support/Code/User/workspaceStorage/f2e99a27b072f4f84da16eb0ecb08967"
TRANS = f"{WS}/GitHub.copilot-chat/transcripts"
SESS = f"{WS}/chatSessions"


def words(path):
    n = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            n += len(chunk.split())
    return n


def extract_user_text(req):
    msg = req.get("message")
    if isinstance(msg, dict):
        if msg.get("text"):
            return msg["text"]
        for p in msg.get("parts") or []:
            if isinstance(p, dict) and p.get("text"):
                return p["text"]
    for k in ("text", "messageText", "userQuery"):
        v = req.get(k)
        if isinstance(v, str) and v:
            return v
    return None


def title(sid):
    p = os.path.join(SESS, sid + ".jsonl")
    if not os.path.exists(p):
        return "(no session file)"
    custom = None
    first_user_text = None
    first = True
    with open(p, "r", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if first:
                first = False
                v0 = d.get("v")
                if isinstance(v0, dict):
                    if v0.get("customTitle"):
                        custom = v0["customTitle"]
                    for r in v0.get("requests") or []:
                        t = extract_user_text(r)
                        if t and first_user_text is None:
                            first_user_text = t
                continue
            k, v = d.get("k"), d.get("v")
            if k == ["customTitle"] and isinstance(v, str):
                custom = v
            elif k == ["requests"] and isinstance(v, list):
                for r in v:
                    t = extract_user_text(r)
                    if t and first_user_text is None:
                        first_user_text = t
                        break
    if custom:
        return custom
    if first_user_text:
        s = re.sub(r"\s+", " ", first_user_text).strip()
        return s[:90] + ("…" if len(s) > 90 else "")
    return "(no title)"


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    rows = []
    for fn in os.listdir(TRANS):
        if not fn.endswith(".jsonl"):
            continue
        sid = fn[:-6]
        rows.append((words(os.path.join(TRANS, fn)), sid))
    rows.sort(reverse=True)
    if limit:
        rows = rows[:limit]
    print(f"{'words':>8}  {'session':36}  title")
    for w, sid in rows:
        print(f"{w:>8}  {sid}  {title(sid)}")


if __name__ == "__main__":
    main()
