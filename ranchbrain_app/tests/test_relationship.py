from ranchbrain.models import Memory, MemoryRelationship

def test_memory_relationship_roundtrip():
    m = Memory(
        module="property",
        category="maintenance",
        title="Relationship test",
        body="Testing relationships.",
        relationships=[
            MemoryRelationship(
                target_id="abc123",
                relationship_type="related",
                note="Related test memory",
            )
        ],
    )

    restored = Memory.from_dict(m.to_dict())
    assert restored.relationships[0].target_id == "abc123"
    assert restored.relationships[0].relationship_type == "related"
