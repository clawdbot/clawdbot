from ranchbrain.memory_store import remember

def test_duplicate_returns_existing_memory_id():
    first = remember(
        module="property",
        category="test",
        title="Duplicate ID accuracy test",
        body="Duplicate should return the original memory ID.",
        memory_type="event",
        tags=["duplicate", "id"],
    )

    second = remember(
        module="property",
        category="test",
        title="Duplicate ID accuracy test",
        body="Duplicate should return the original memory ID.",
        memory_type="event",
        tags=["id", "duplicate"],
    )

    assert second.status == "duplicate"
    assert second.path == first.path
    assert second.memory_id == first.memory_id
