import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from .config import RANCHBRAIN_DATA
from .logging_config import get_logger
from .profile_manager import get_profile, should_index_path

logger = get_logger(__name__)

INDEX_PATH = RANCHBRAIN_DATA / "index" / "index.json"

def index_path_for_profile(profile_name: str) -> Path:
    return RANCHBRAIN_DATA / "index" / f"{profile_name}.json"

def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def build_index(profile_name: str = "knowledge", incremental: bool = True) -> list[dict]:
    profile = get_profile(profile_name)
    records = []
    old_records = {}
    out_path = index_path_for_profile(profile.name)

    if incremental and out_path.exists():
        try:
            old_records = {
                r.get("root", "") + "|" + r.get("relative_path", ""): r
                for r in json.loads(out_path.read_text())
            }
        except Exception:
            old_records = {}

    out_path.parent.mkdir(parents=True, exist_ok=True)

    for root in profile.roots:
        if not root.exists():
            continue

        for path in root.rglob("*"):
            if not should_index_path(path, root, profile):
                continue

            rel = str(path.relative_to(root))
            display_path = f"{root.name}/{rel}"
            stat = path.stat()
            key = str(root) + "|" + rel
            old = old_records.get(key)

            if (
                incremental
                and old
                and old.get("mtime") == stat.st_mtime
                and old.get("size_bytes") == stat.st_size
            ):
                records.append(old)
                continue

            try:
                text = path.read_text(errors="ignore")
            except Exception:
                continue

            lines = []
            for line_no, line in enumerate(text.splitlines(), start=1):
                stripped = line.strip()
                if stripped:
                    lines.append({"line": line_no, "text": stripped[:500]})

            records.append({
                "path": display_path,
                "root": str(root),
                "relative_path": rel,
                "module": rel.split("/", 1)[0] if "/" in rel else "root",
                "profile": profile.name,
                "title": path.name,
                "size_bytes": stat.st_size,
                "mtime": stat.st_mtime,
                "sha256": file_sha256(path),
                "indexed_at": datetime.now(timezone.utc).isoformat(),
                "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "preview": text[:300].replace("\n", " "),
                "lines": lines,
            })

    out_path.write_text(json.dumps(records, indent=2, ensure_ascii=False))

    if profile.name == "knowledge":
        INDEX_PATH.write_text(json.dumps(records, indent=2, ensure_ascii=False))

    logger.info(f"Indexed {len(records)} files profile={profile.name} path={out_path}")
    return records

def load_index(profile_name: str = "knowledge") -> list[dict]:
    path = index_path_for_profile(profile_name)
    if not path.exists() and profile_name == "knowledge" and INDEX_PATH.exists():
        path = INDEX_PATH
    if not path.exists():
        return []
    return json.loads(path.read_text())


def index_status() -> list[dict]:
    """Return status information for every index profile."""
    from .profile_manager import PROFILES

    results = []

    for profile_name in PROFILES:
        path = index_path_for_profile(profile_name)

        if path.exists():
            try:
                records = json.loads(path.read_text())
                count = len(records)
            except Exception:
                count = -1

            latest = ""
            if records:
                latest = max(
                    (r.get("indexed_at", "") for r in records),
                    default=""
                )

            results.append({
                "profile": profile_name,
                "exists": True,
                "records": count,
                "size": path.stat().st_size,
                "indexed_at": latest,
                "path": str(path),
            })
        else:
            results.append({
                "profile": profile_name,
                "exists": False,
                "records": 0,
                "size": 0,
                "path": str(path),
            })

    return results
