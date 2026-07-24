import json
import hashlib
from pathlib import Path
from .config import RANCHBRAIN_DATA
from .models import Memory, Reference, MemoryResult
from .logging_config import get_logger
from .indexer import build_index
from .renderers import render_memory_markdown

logger = get_logger(__name__)

MEMORIES_DIR = RANCHBRAIN_DATA / "memories"

def memory_fingerprint(memory: Memory) -> str:
    seed = "|".join([
        memory.module.strip().lower(),
        memory.category.strip().lower(),
        memory.memory_type.strip().lower(),
        memory.title.strip().lower(),
        memory.body.strip().lower(),
        ",".join(sorted([t.strip().lower() for t in memory.tags])),
    ])
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]

def find_duplicate(memory: Memory) -> Path | None:
    fingerprint = memory_fingerprint(memory)

    if not MEMORIES_DIR.exists():
        return None

    for path in MEMORIES_DIR.rglob("*.json"):
        if "_archive" in path.parts:
            continue
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue

        existing = Memory.from_dict(data)
        if memory_fingerprint(existing) == fingerprint:
            return path

    return None

def save_memory(memory: Memory) -> MemoryResult:
    duplicate = find_duplicate(memory)
    if duplicate:
        existing_id = memory.id
        try:
            existing_data = json.loads(duplicate.read_text())
            existing_id = existing_data.get("id", memory.id)
        except Exception:
            pass

        logger.info(f"Duplicate memory skipped attempted_id={memory.id} existing_id={existing_id} existing={duplicate}")
        return MemoryResult(
            status="duplicate",
            path=str(duplicate),
            memory_id=existing_id,
            message="Memory already exists",
        )

    year = memory.created_at[:4]
    month = memory.created_at[5:7]
    module_dir = MEMORIES_DIR / memory.module / year / month
    module_dir.mkdir(parents=True, exist_ok=True)

    safe_title = "".join(
        c.lower() if c.isalnum() else "-"
        for c in memory.title
    ).strip("-")

    path = module_dir / f"{memory.created_at[:10]}-{safe_title}-{memory.id}.json"
    path.write_text(memory.to_json())
    md_path = render_memory_markdown(memory, path)

    logger.info(f"Saved memory id={memory.id} path={path} markdown={md_path}")
    build_index()
    return MemoryResult(
        status="created",
        path=str(path),
        memory_id=memory.id,
        message="Memory created",
    )

def remember(
    module: str,
    category: str,
    title: str,
    body: str,
    memory_type: str = "event",
    tags: list[str] | None = None,
    url: str | None = None,
) -> MemoryResult:
    refs = []
    if url:
        refs.append(Reference(type="url", value=url, title=url))

    memory = Memory(
        module=module,
        category=category,
        title=title,
        body=body,
        memory_type=memory_type,
        tags=tags or [],
        references=refs,
    )

    return save_memory(memory)

def find_memory_by_id(memory_id: str):
    if not MEMORIES_DIR.exists():
        return None

    for path in MEMORIES_DIR.rglob("*.json"):
        if "_archive" in path.parts:
            continue
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue

        if data.get("id", "").startswith(memory_id):
            return path, Memory.from_dict(data)

    return None

def list_memories(
    module: str | None = None,
    limit: int = 25,
    memory_type: str | None = None,
    category: str | None = None,
    tag: str | None = None,
):
    base = MEMORIES_DIR / module if module else MEMORIES_DIR
    results = []

    if not base.exists():
        return results

    for path in sorted(base.rglob("*.json"), reverse=True):
        try:
            data = json.loads(path.read_text())
            memory = Memory.from_dict(data)
        except Exception:
            continue

        if memory_type and memory.memory_type != memory_type:
            continue

        if category and memory.category != category:
            continue

        if tag and tag not in memory.tags:
            continue

        results.append((path, memory))

        if len(results) >= limit:
            break

    return results

def memory_stats():
    stats = {
        "total": 0,
        "modules": {},
        "types": {},
        "categories": {},
        "tags": {},
    }

    if not MEMORIES_DIR.exists():
        return stats

    for path in MEMORIES_DIR.rglob("*.json"):
        if "_archive" in path.parts:
            continue
        try:
            data = json.loads(path.read_text())
            memory = Memory.from_dict(data)
        except Exception:
            continue

        stats["total"] += 1
        stats["modules"][memory.module] = stats["modules"].get(memory.module, 0) + 1
        stats["types"][memory.memory_type] = stats["types"].get(memory.memory_type, 0) + 1
        stats["categories"][memory.category] = stats["categories"].get(memory.category, 0) + 1

        for tag in memory.tags:
            stats["tags"][tag] = stats["tags"].get(tag, 0) + 1

    return stats


def link_memories(source_id: str,
                  target_id: str,
                  relationship_type: str = "related",
                  note: str = ""):
    """Create a relationship from one memory to another."""

    source = find_memory_by_id(source_id)
    target = find_memory_by_id(target_id)

    if not source:
        raise ValueError(f"Memory not found: {source_id}")

    if not target:
        raise ValueError(f"Memory not found: {target_id}")

    source_path, memory = source

    from .models import MemoryRelationship

    for rel in memory.relationships:
        if (
            rel.target_id == target[1].id
            and rel.relationship_type == relationship_type
        ):
            return False

    memory.relationships.append(
        MemoryRelationship(
            target_id=target[1].id,
            relationship_type=relationship_type,
            note=note,
        )
    )

    source_path.write_text(memory.to_json())
    build_index()

    logger.info(
        "Linked memory %s -> %s (%s)",
        memory.id,
        target[1].id,
        relationship_type,
    )

    return True


def find_backlinks(target_id: str):
    """Return memories that point to the target memory."""
    target = find_memory_by_id(target_id)

    if not target:
        raise ValueError(f"Memory not found: {target_id}")

    target_full_id = target[1].id
    backlinks = []

    if not MEMORIES_DIR.exists():
        return backlinks

    for path in MEMORIES_DIR.rglob("*.json"):
        if "_archive" in path.parts:
            continue

        try:
            data = json.loads(path.read_text())
            memory = Memory.from_dict(data)
        except Exception:
            continue

        for rel in memory.relationships:
            if rel.target_id == target_full_id:
                backlinks.append((path, memory, rel))

    return backlinks
