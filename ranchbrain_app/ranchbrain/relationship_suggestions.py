import re
from dataclasses import dataclass
from pathlib import Path

from .memory_store import find_memory_by_id, list_memories
from .models import Memory


STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for",
    "from", "in", "is", "it", "of", "on", "or", "that", "the",
    "this", "to", "was", "were", "with",
}


@dataclass
class RelationshipSuggestion:
    memory: Memory
    path: Path
    score: int
    reasons: list[str]


def _title_words(title: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", title.casefold())
    return {
        word
        for word in words
        if len(word) >= 3 and word not in STOP_WORDS
    }


def _reference_values(memory: Memory) -> set[str]:
    return {
        ref.value.strip().casefold()
        for ref in memory.references
        if ref.value.strip()
    }


def _is_test_memory(memory: Memory) -> bool:
    """Return True for development/test memories hidden by default."""
    category = memory.category.strip().casefold()
    title = memory.title.strip().casefold()
    tags = {
        tag.strip().casefold()
        for tag in memory.tags
        if tag.strip()
    }

    if category == "test":
        return True

    if "test" in _title_words(title):
        return True

    if any(
        tag == "test"
        or tag.endswith("-test")
        or tag.startswith("test-")
        for tag in tags
    ):
        return True

    return False


def suggest_relationships(
    memory_id: str,
    limit: int = 10,
    min_score: int = 20,
    include_tests: bool = False,
) -> list[RelationshipSuggestion]:
    found = find_memory_by_id(memory_id)

    if not found:
        raise ValueError(f"Memory not found: {memory_id}")

    _, source = found

    source_tags = {
        tag.strip().casefold()
        for tag in source.tags
        if tag.strip()
    }
    source_words = _title_words(source.title)
    source_refs = _reference_values(source)
    existing_targets = {
        relationship.target_id
        for relationship in source.relationships
    }

    suggestions: list[RelationshipSuggestion] = []

    for path, candidate in list_memories(limit=100000):
        if candidate.id == source.id:
            continue

        if not include_tests and _is_test_memory(candidate):
            continue

        if candidate.id in existing_targets:
            continue

        score = 0
        reasons: list[str] = []

        candidate_tags = {
            tag.strip().casefold()
            for tag in candidate.tags
            if tag.strip()
        }

        shared_tags = sorted(source_tags & candidate_tags)
        if shared_tags:
            points = 30 * len(shared_tags)
            score += points
            reasons.append(
                f"shared tags: {', '.join(shared_tags)} (+{points})"
            )

        shared_words = sorted(
            source_words & _title_words(candidate.title)
        )
        if shared_words:
            points = 10 * len(shared_words)
            score += points
            reasons.append(
                f"shared title words: {', '.join(shared_words)} (+{points})"
            )

        shared_refs = source_refs & _reference_values(candidate)
        if shared_refs:
            points = 40 * len(shared_refs)
            score += points
            reasons.append(
                f"shared references: {len(shared_refs)} (+{points})"
            )

        if source.module == candidate.module:
            score += 5
            reasons.append("same module (+5)")

        if source.category == candidate.category:
            score += 5
            reasons.append("same category (+5)")

        if score < min_score:
            continue

        suggestions.append(
            RelationshipSuggestion(
                memory=candidate,
                path=path,
                score=score,
                reasons=reasons,
            )
        )

    suggestions.sort(
        key=lambda item: (
            -item.score,
            item.memory.title.casefold(),
            item.memory.id,
        )
    )

    return suggestions[:limit]
