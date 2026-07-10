#!/usr/bin/env python3

import hashlib
import subprocess
from pathlib import Path

BASE = Path("/mnt/ai-storage/ranchbrain")
TARGETS = [
    BASE / "notes",
    BASE / "documents",
    BASE / "manuals",
]

CHUNK_SIZE = 1200
OVERLAP = 200


def run_psql(sql: str) -> None:
    subprocess.run(
        ["docker", "exec", "-i", "postgres", "psql", "-U", "openclaw", "-d", "openclaw"],
        input=sql,
        text=True,
        check=True,
    )


def sql_escape(value: str) -> str:
    return value.replace("'", "''")


def chunk_text(text: str):
    text = text.strip()
    if not text:
        return []

    chunks = []
    start = 0

    while start < len(text):
        end = start + CHUNK_SIZE
        chunks.append(text[start:end])
        start = end - OVERLAP

        if start < 0:
            start = 0

        if start >= len(text):
            break

    return chunks


def source_type(path: Path) -> str:
    parts = path.parts
    if "notes" in parts:
        return "note"
    if "documents" in parts:
        return "document"
    return "unknown"


def index_file(path: Path) -> int:
    text = path.read_text(errors="ignore")
    chunks = chunk_text(text)
    rel = str(path.relative_to(BASE))
    stype = source_type(path)

    values = []
    for i, chunk in enumerate(chunks):
        values.append(
            f"('{sql_escape(rel)}', '{sql_escape(stype)}', {i}, '{sql_escape(chunk)}')"
        )

    if not values:
        return 0

    sql = f"""
INSERT INTO ranchbrain_chunks (source_path, source_type, chunk_index, content)
VALUES
{",\n".join(values)}
ON CONFLICT (source_path, chunk_index)
DO UPDATE SET
    content = EXCLUDED.content,
    updated_at = now();
"""
    run_psql(sql)
    return len(chunks)


def main():
    files = []
    for target in TARGETS:
        if target.exists():
            files.extend([p for p in target.rglob("*") if p.is_file()])

    total_chunks = 0
    for path in sorted(files):
        count = index_file(path)
        total_chunks += count
        print(f"Indexed {count:3d} chunks: {path.relative_to(BASE)}")

    print()
    print(f"Indexed files : {len(files)}")
    print(f"Indexed chunks: {total_chunks}")


if __name__ == "__main__":
    main()
