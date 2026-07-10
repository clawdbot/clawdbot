#!/usr/bin/env python3
import sys
from pathlib import Path

BASE = Path.home() / "ai/projects/openclaw"
RB = BASE / "ranchbrain"

def status():
    print("RanchBrain Status")
    print(f"Base: {RB}")
    for name in ["system", "budget", "health", "property", "projects", "homeassistant"]:
        p = RB / "modules" / name
        count = len(list(p.rglob("*"))) if p.exists() else 0
        print(f"{name}: {count} items")

def ingest_system():
    sources = [
        BASE / "reports/daily-briefings",
        BASE / "reports/system_manager",
        BASE / "reports/watchdog",
    ]
    out = RB / "modules/system/import-log.md"
    out.parent.mkdir(parents=True, exist_ok=True)

    lines = ["# System Import Log", ""]
    total = 0

    for src in sources:
        lines.append(f"## {src}")
        if not src.exists():
            lines.append("- missing")
            lines.append("")
            continue

        files = sorted([x for x in src.rglob("*") if x.is_file()])
        for f in files:
            total += 1
            lines.append(f"- {f.relative_to(BASE)}")
        lines.append("")

    out.write_text("\n".join(lines))
    print(f"Imported {total} system files.")
    print(f"Wrote: {out}")

def search(query):
    q = query.lower()
    hits = []

    for f in RB.rglob("*"):
        if not f.is_file():
            continue
        try:
            text = f.read_text(errors="ignore")
        except Exception:
            continue

        for i, line in enumerate(text.splitlines(), start=1):
            if q in line.lower():
                hits.append((f, i, line.strip()))

    for f, line_no, line in hits[:25]:
        print(f"{f.relative_to(BASE)}:{line_no}: {line}")

    if not hits:
        print("No matches found.")
    else:
        print(f"\nShowing {min(len(hits), 25)} of {len(hits)} matches.")

def main():
    if len(sys.argv) < 2:
        status()
        return

    cmd = sys.argv[1]
    if cmd == "status":
        status()
    elif cmd == "ingest" and len(sys.argv) >= 3 and sys.argv[2] == "system":
        ingest_system()
    elif cmd == "search" and len(sys.argv) >= 3:
        search(" ".join(sys.argv[2:]))
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)

if __name__ == "__main__":
    main()
