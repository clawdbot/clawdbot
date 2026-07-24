from ranchbrain.indexer import load_index

def test_profile_indexes_exist():
    assert len(load_index("knowledge")) > 0
    assert len(load_index("code")) > 0
    assert len(load_index("all")) > 0
