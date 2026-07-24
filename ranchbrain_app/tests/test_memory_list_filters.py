from ranchbrain.memory_store import remember, list_memories

def test_list_memories_filters():
    remember(
        module="property",
        category="maintenance",
        title="Filter test memory",
        body="This memory tests list filters.",
        memory_type="event",
        tags=["filter-test", "property"],
    )

    items = list_memories(
        module="property",
        memory_type="event",
        category="maintenance",
        tag="filter-test",
        limit=10,
    )

    assert len(items) >= 1
    assert all(memory.module == "property" for _, memory in items)
    assert all(memory.memory_type == "event" for _, memory in items)
    assert all(memory.category == "maintenance" for _, memory in items)
    assert all("filter-test" in memory.tags for _, memory in items)
