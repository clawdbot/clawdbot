#!/usr/bin/env python3

import subprocess
from pathlib import Path

DATA = Path("/mnt/ai-storage/ranchbrain")

EXTENSIONS = {
    ".pdf",
    ".md",
    ".txt",
    ".docx",
    ".xlsx",
    ".pptx",
    ".jpg",
    ".jpeg",
    ".png"
}

count = 0

for f in DATA.rglob("*"):
    if not f.is_file():
        continue

    if f.suffix.lower() not in EXTENSIONS:
        continue

    if f.name.endswith(".metadata.json"):
        continue

    meta = f.with_suffix(f.suffix + ".metadata.json")

    if meta.exists():
        continue

    subprocess.run([
        "python3",
        str(Path.home() / "ai/projects/openclaw/ranchbrain/src/ranchbrain/create_metadata.py"),
        str(f)
    ])

    count += 1

print(f"Created {count} metadata files.")
