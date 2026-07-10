#!/usr/bin/env python3

import sys
from pathlib import Path

BASE = Path("/mnt/ai-storage/ranchbrain")

def files_under(folder):
    return [x for x in folder.rglob("*") if x.is_file()]

def status():
    docs = files_under(BASE / "documents")
    notes = files_under(BASE / "notes")
    print("========== RanchBrain ==========")
    print(f"Documents : {len(docs)}")
    print(f"Notes     : {len(notes)}")
    print("Status    : Online")

def search(query):
    targets = files_under(BASE / "documents") + files_under(BASE / "notes")
    found = 0
    for path in targets:
        text = path.read_text(errors="ignore")
        for i, line in enumerate(text.splitlines(), start=1):
            if query.lower() in line.lower():
                print(f"{path}:{i}: {line}")
                found += 1
                if found >= 40:
                    return

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        status()
    elif cmd == "search":
        search(" ".join(sys.argv[2:]))
    else:
        print("Usage: python3 ranchbrain/src/ranchbrain/main.py [status|search TERM]")

if __name__ == "__main__":
    main()
