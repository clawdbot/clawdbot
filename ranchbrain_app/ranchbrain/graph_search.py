import json
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from .memory_store import MEMORIES_DIR
from .models import Memory


@dataclass
class GraphNode:
    memory: Memory
    path: Path
    depth: int
    direction: str
    relationship_type: str = ""
    parent_id: str = ""
    note: str = ""


def _active_memories() -> dict[str, tuple[Path, Memory]]:
    items: dict[str, tuple[Path, Memory]] = {}

    if not MEMORIES_DIR.exists():
        return items

    for path in MEMORIES_DIR.rglob("*.json"):
        if "_archive" in path.parts:
            continue

        try:
            data = json.loads(path.read_text())
            memory = Memory.from_dict(data)
        except Exception:
            continue

        items[memory.id] = (path, memory)

    return items


def _memory_matches(memory: Memory, query: str) -> bool:
    q = query.casefold()

    values = [
        memory.id,
        memory.module,
        memory.category,
        memory.title,
        memory.body,
        memory.memory_type,
        " ".join(memory.tags),
    ]

    for ref in memory.references:
        values.extend([ref.type, ref.title, ref.value])

    return any(q in str(value).casefold() for value in values)


def graph_search(query: str, max_depth: int = 1) -> list[GraphNode]:
    """Search structured memories, then traverse relationships using BFS."""
    if max_depth < 0:
        raise ValueError("Depth must be zero or greater.")

    if max_depth > 5:
        raise ValueError("Maximum graph-search depth is 5.")

    memories = _active_memories()
    nodes: list[GraphNode] = []
    queue: deque[tuple[str, int]] = deque()
    visited: set[str] = set()

    # Build incoming relationship lookup.
    backlinks: dict[str, list[tuple[str, object]]] = {}

    for source_id, (_, source_memory) in memories.items():
        for rel in source_memory.relationships:
            backlinks.setdefault(rel.target_id, []).append((source_id, rel))

    # Direct query matches are depth zero.
    for memory_id, (path, memory) in memories.items():
        if not _memory_matches(memory, query):
            continue

        nodes.append(
            GraphNode(
                memory=memory,
                path=path,
                depth=0,
                direction="direct",
            )
        )
        visited.add(memory_id)
        queue.append((memory_id, 0))

    while queue:
        current_id, current_depth = queue.popleft()

        if current_depth >= max_depth:
            continue

        current_path, current_memory = memories[current_id]
        next_depth = current_depth + 1

        # Outgoing relationships.
        for rel in current_memory.relationships:
            target = memories.get(rel.target_id)
            if not target:
                continue

            target_path, target_memory = target

            if target_memory.id in visited:
                continue

            visited.add(target_memory.id)
            nodes.append(
                GraphNode(
                    memory=target_memory,
                    path=target_path,
                    depth=next_depth,
                    direction="outgoing",
                    relationship_type=rel.relationship_type,
                    parent_id=current_id,
                    note=rel.note,
                )
            )
            queue.append((target_memory.id, next_depth))

        # Incoming relationships.
        for source_id, rel in backlinks.get(current_id, []):
            source = memories.get(source_id)
            if not source:
                continue

            source_path, source_memory = source

            if source_memory.id in visited:
                continue

            visited.add(source_memory.id)
            nodes.append(
                GraphNode(
                    memory=source_memory,
                    path=source_path,
                    depth=next_depth,
                    direction="incoming",
                    relationship_type=rel.relationship_type,
                    parent_id=current_id,
                    note=rel.note,
                )
            )
            queue.append((source_memory.id, next_depth))

    return nodes
