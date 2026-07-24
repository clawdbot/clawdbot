from ranchbrain.memory_store import remember, find_memory_by_id

def test_find_memory_by_id():
    result = remember(
        module="property",
        category="test",
        title="Memory show test",
        body="This memory should be retrievable by ID.",
        memory_type="event",
        tags=["show", "test"],
    )

    found = find_memory_by_id(result.memory_id)
    assert found is not None

    path, memory = found
    assert memory.id == result.memory_id
    assert "Memory show test" in memory.title
