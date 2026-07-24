from ranchbrain.memory_store import remember, memory_stats

def test_memory_stats():
    remember(
        module="property",
        category="test",
        title="Memory stats test",
        body="This memory should be included in stats.",
        memory_type="event",
        tags=["stats-test"],
    )

    stats = memory_stats()
    assert stats["total"] >= 1
    assert "property" in stats["modules"]
    assert "event" in stats["types"]
