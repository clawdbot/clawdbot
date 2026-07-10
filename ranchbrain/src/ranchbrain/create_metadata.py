#!/usr/bin/env python3

import json
import sys
from datetime import datetime
from pathlib import Path

DATA = Path("/mnt/ai-storage/ranchbrain")
TEMPLATE = DATA / "templates/document.metadata.template.json"

def main():
    if len(sys.argv) < 2:
        print("Usage: create_metadata.py path/to/document")
        sys.exit(1)

    doc = Path(sys.argv[1]).expanduser().resolve()

    if not doc.exists():
        print(f"File not found: {doc}")
        sys.exit(1)

    if not str(doc).startswith(str(DATA)):
        print(f"Document must be under {DATA}")
        sys.exit(1)

    meta_path = doc.with_suffix(doc.suffix + ".metadata.json")

    if meta_path.exists():
        print(f"Metadata already exists: {meta_path}")
        return

    meta = json.loads(TEMPLATE.read_text())
    meta["title"] = doc.stem.replace("-", " ").replace("_", " ")
    meta["date_added"] = datetime.now().strftime("%Y-%m-%d")
    meta["source_path"] = str(doc.relative_to(DATA))

    meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"Created metadata: {meta_path}")

if __name__ == "__main__":
    main()
