from pathlib import Path
from ranchbrain.memory_store import remember

def test_remember_creates_memory_file():
    result = remember(
        module="system",
        category="test",
        title="Test memory",
        body="This is a test memory.",
        memory_type="event",
        tags=["test"],
        url="https://example.com",
    )
    assert Path(result.path).exists()
    text = Path(result.path).read_text()
    assert "Test memory" in text
    assert "https://example.com" in text
