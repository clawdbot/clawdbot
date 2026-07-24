from ranchbrain.memory_store import remember, link_memories, find_backlinks

def test_find_backlinks():
    source = remember(
        module="property",
        category="test",
        title="Backlink source test",
        body="Source memory for backlink test.",
        memory_type="event",
        tags=["backlink", "source"],
    )

    target = remember(
        module="property",
        category="test",
        title="Backlink target test",
        body="Target memory for backlink test.",
        memory_type="event",
        tags=["backlink", "target"],
    )

    link_memories(
        source.memory_id,
        target.memory_id,
        relationship_type="related",
        note="Backlink test",
    )

    backlinks = find_backlinks(target.memory_id)

    assert any(memory.id == source.memory_id for _, memory, _ in backlinks)
