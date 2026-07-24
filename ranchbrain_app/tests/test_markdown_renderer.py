from ranchbrain.models import Memory, Reference
from ranchbrain.renderers import render_memory_markdown

def test_render_memory_markdown(tmp_path):
    memory = Memory(
        module="property",
        category="maintenance",
        title="Test Markdown Memory",
        body="This is a rendered memory.",
        memory_type="event",
        tags=["test", "markdown"],
        references=[
            Reference(type="url", title="Example", value="https://example.com")
        ],
    )

    json_path = tmp_path / "memory.json"
    json_path.write_text(memory.to_json())

    md_path = render_memory_markdown(memory, json_path)

    assert md_path.exists()
    text = md_path.read_text()
    assert "# Test Markdown Memory" in text
    assert "https://example.com" in text
    assert "Generated automatically by RanchBrain" in text
