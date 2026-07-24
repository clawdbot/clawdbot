from ranchbrain.models import MemoryResult

def test_memory_result_created():
    r = MemoryResult(status="created", path="/tmp/example.json", memory_id="abc123")
    assert r.created
    assert not r.duplicate
    assert "created" in r.to_json()
