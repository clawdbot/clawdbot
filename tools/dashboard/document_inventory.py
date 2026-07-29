from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2
DOCUMENT_SUFFIXES = {".md", ".mdx"}


def _document_paths(documentation_root: Path) -> list[Path]:
    return sorted(
        (
            path
            for path in documentation_root.rglob("*")
            if path.is_file() and path.suffix.lower() in DOCUMENT_SUFFIXES
        ),
        key=lambda path: path.relative_to(documentation_root).as_posix().casefold(),
    )


def _frontmatter_and_title(text: str, fallback: str) -> tuple[dict[str, str], str]:
    metadata: dict[str, str] = {}
    lines = text.splitlines()
    body_start = 0
    if lines and lines[0].strip() == "---":
        for index, line in enumerate(lines[1:], start=1):
            if line.strip() == "---":
                body_start = index + 1
                break
            key, separator, value = line.partition(":")
            if separator and key.strip():
                metadata[key.strip()] = value.strip().strip("\"'")

    title = metadata.get("title", "")
    if not title:
        for line in lines[body_start:]:
            if line.startswith("# "):
                title = line[2:].strip()
                break
    return metadata, title or fallback


def _category(relative_path: Path, metadata: dict[str, str]) -> str:
    if metadata.get("category"):
        return metadata["category"]
    if len(relative_path.parts) > 1:
        return relative_path.parts[0].replace("-", " ").replace("_", " ").title()
    return "Docs"


def build_document_inventory(documentation_root: Path) -> dict[str, Any]:
    documentation_root = documentation_root.resolve()
    documents: list[dict[str, Any]] = []
    fingerprint = hashlib.sha256()

    for source_path in _document_paths(documentation_root):
        relative_path = source_path.relative_to(documentation_root)
        relative_text = relative_path.as_posix()
        content = source_path.read_bytes()
        fingerprint.update(relative_text.encode("utf-8"))
        fingerprint.update(b"\0")
        fingerprint.update(content)
        fingerprint.update(b"\0")

        text = content.decode("utf-8", errors="replace")
        fallback_title = source_path.stem.replace("_", " ").replace("-", " ").title()
        metadata, title = _frontmatter_and_title(text, fallback_title)
        stat = source_path.stat()
        documents.append(
            {
                "path": f"docs/{relative_text}",
                "relative_path": relative_text,
                "title": title,
                "version": metadata.get("version", "Unknown"),
                "status": metadata.get("status", "Unknown"),
                "owner": metadata.get("owner", "Unknown"),
                "last_reviewed": metadata.get("last_reviewed", "Unknown"),
                "category": _category(relative_path, metadata),
                "metadata_present": bool(metadata),
                "size_bytes": len(content),
                "modified_epoch": int(stat.st_mtime),
            }
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_fingerprint": fingerprint.hexdigest(),
        "document_count": len(documents),
        "documents": documents,
    }


def _load_inventory(inventory_path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(inventory_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _write_inventory_atomic(inventory_path: Path, inventory: dict[str, Any]) -> None:
    inventory_path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{inventory_path.name}.",
        suffix=".tmp",
        dir=inventory_path.parent,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            json.dump(inventory, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary_path.replace(inventory_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def ensure_document_inventory(
    documentation_root: Path,
    inventory_path: Path,
) -> dict[str, Any]:
    documentation_root = documentation_root.resolve()
    lock_key = hashlib.sha256(str(documentation_root).encode("utf-8")).hexdigest()[:16]
    lock_path = Path(tempfile.gettempdir()) / f"openclaw-document-inventory-{lock_key}.lock"

    with lock_path.open("a+", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        generated = build_document_inventory(documentation_root)
        existing = _load_inventory(inventory_path)
        if (
            existing is None
            or existing.get("schema_version") != SCHEMA_VERSION
            or existing.get("source_fingerprint") != generated["source_fingerprint"]
            or existing.get("document_count") != generated["document_count"]
        ):
            try:
                _write_inventory_atomic(inventory_path, generated)
            except OSError:
                # The dashboard still receives a fresh in-memory inventory if
                # the deployed documentation directory is unexpectedly read-only.
                return generated
            return generated
        return existing


def inventory_is_current(documentation_root: Path, inventory_path: Path) -> bool:
    existing = _load_inventory(inventory_path)
    if existing is None:
        return False
    generated = build_document_inventory(documentation_root)
    return (
        existing.get("schema_version") == SCHEMA_VERSION
        and existing.get("source_fingerprint") == generated["source_fingerprint"]
        and existing.get("document_count") == generated["document_count"]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage the dashboard document inventory.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--write", action="store_true")
    action.add_argument("--check", action="store_true")
    parser.add_argument("--docs-root", type=Path, default=Path("docs"))
    parser.add_argument(
        "--inventory",
        type=Path,
        default=Path("docs/document-inventory.json"),
    )
    args = parser.parse_args()

    if args.check:
        if inventory_is_current(args.docs_root, args.inventory):
            print("Document inventory is current.")
            return 0
        print("Document inventory is stale. Run the write command.")
        return 1

    inventory = build_document_inventory(args.docs_root)
    _write_inventory_atomic(args.inventory, inventory)
    print(f"Wrote {inventory['document_count']} documents to {args.inventory}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
