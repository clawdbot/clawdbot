from ranchbrain.memory_store import find_memory_by_id

def test_relationships_field_exists():
    result = find_memory_by_id("c6960f30")
    if result:
        _, memory = result
        assert hasattr(memory, "relationships")
