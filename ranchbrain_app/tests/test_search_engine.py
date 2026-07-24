from ranchbrain.search_engine import search

def test_search_returns_line_matches():
    hits, total = search("backup")
    assert isinstance(hits, list)
    assert isinstance(total, int)
    if hits:
        path, line_no, line = hits[0]
        assert isinstance(path, str)
        assert isinstance(line_no, int)
        assert isinstance(line, str)
