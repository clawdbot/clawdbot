from ranchbrain.search_engine import search

def test_profile_search_knowledge():
    hits, total = search("Time Machine", profile="knowledge")
    assert isinstance(hits, list)
    assert isinstance(total, int)

def test_profile_search_code():
    hits, total = search("MemoryResult", profile="code")
    assert isinstance(hits, list)
    assert isinstance(total, int)
