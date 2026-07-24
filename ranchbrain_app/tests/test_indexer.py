from ranchbrain.indexer import build_index, load_index, INDEX_PATH

def test_build_index_creates_json():
    records = build_index()
    assert isinstance(records, list)
    assert INDEX_PATH.exists()

def test_load_index_returns_list():
    records = load_index()
    assert isinstance(records, list)
