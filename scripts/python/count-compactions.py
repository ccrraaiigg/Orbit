#!/usr/bin/env python3
"""Count how many times a Copilot chat session was compacted.

A "compaction" here is a Copilot-generated conversation summary attached
to a request's result metadata. They appear in chatSessions/<sid>.jsonl
as `requests[N].result.metadata.summaries`, each carrying a distinct
`toolCallRoundId` and a "1. Conversation Overview:" body.

Usage:
    count-compactions.py <session-uuid>
"""
import json, os, sys

WS = "/Users/craig/Library/Application Support/Code/User/workspaceStorage/f2e99a27b072f4f84da16eb0ecb08967"


def count(sid):
    path = f"{WS}/chatSessions/{sid}.jsonl"
    if not os.path.exists(path):
        sys.exit(f"no chatSessions file for {sid}")

    summaries_per_request = {}
    toolround_ids = set()

    def ingest(idx, result):
        md = ((result or {}).get("metadata")) or {}
        ss = md.get("summaries") or []
        if ss:
            summaries_per_request[idx] = len(ss)
            for s in ss:
                rid = s.get("toolCallRoundId")
                if rid:
                    toolround_ids.add(rid)

    with open(path, "r", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            kind, k, v = d.get("kind"), d.get("k"), d.get("v")
            if kind == 0 and isinstance(v, dict):
                for idx, r in enumerate(v.get("requests") or []):
                    ingest(idx, (r or {}).get("result"))
            elif isinstance(k, list) and len(k) == 3 and k[0] == "requests" and k[2] == "result":
                ingest(k[1], v)

    return summaries_per_request, toolround_ids


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sid = sys.argv[1]
    per_req, rounds = count(sid)
    print(f"Session: {sid}")
    print(f"Requests with at least one summary: {len(per_req)}")
    print(f"Total summary entries: {sum(per_req.values())}")
    print(f"Distinct toolCallRoundIds (≈ compactions): {len(rounds)}")
    if per_req:
        print("\nPer-request summary counts:")
        for idx in sorted(per_req):
            n = per_req[idx]
            print(f"  request {idx}: {n} summary entr{'y' if n == 1 else 'ies'}")


if __name__ == "__main__":
    main()
