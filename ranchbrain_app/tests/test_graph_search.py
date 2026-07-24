import pytest

from ranchbrain.graph_search import graph_search


def test_graph_search_returns_nodes():
    nodes = graph_search("Burned large stump", max_depth=1)

    assert isinstance(nodes, list)
    assert any(
        node.memory.title == "Burned large stump"
        and node.depth == 0
        for node in nodes
    )


def test_graph_search_expands_one_hop():
    nodes = graph_search("Burned large stump", max_depth=1)

    assert any(node.depth == 1 for node in nodes)


def test_graph_search_depth_zero():
    nodes = graph_search("Burned large stump", max_depth=0)

    assert nodes
    assert all(node.depth == 0 for node in nodes)


def test_graph_search_rejects_large_depth():
    with pytest.raises(ValueError):
        graph_search("Burned large stump", max_depth=6)


def test_graph_search_rejects_negative_depth():
    with pytest.raises(ValueError):
        graph_search("Burned large stump", max_depth=-1)
