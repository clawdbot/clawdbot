from ranchbrain.indexer import index_status

def test_index_status():
    status = index_status()
    assert isinstance(status, list)
    assert any(item["profile"] == "knowledge" for item in status)
    assert any(item["profile"] == "code" for item in status)
    assert any(item["profile"] == "all" for item in status)
