from ranchbrain.memory_store import remember

def test_remember_deduplicates_identical_memory():
    first = remember(
        module="property",
        category="test",
        title="Dedup test memory",
        body="This memory should not be duplicated.",
        memory_type="event",
        tags=["dedup", "test"],
    )

    second = remember(
        module="property",
        category="test",
        title="Dedup test memory",
        body="This memory should not be duplicated.",
        memory_type="event",
        tags=["test", "dedup"],
    )

    assert first.path == second.path
    assert second.status == 'duplicate'
