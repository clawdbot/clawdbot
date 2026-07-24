from ranchbrain.models import Memory, Reference

def test_memory_can_store_url_reference():
    ref = Reference(
        type="url",
        title="Apple Time Machine",
        value="https://support.apple.com/",
        confidence=1.0,
    )

    m = Memory(
        module="system",
        category="backup",
        title="Time Machine reference",
        body="Official Apple support reference for Time Machine.",
        memory_type="document",
        tags=["time-machine", "apple"],
        references=[ref],
    )

    assert m.references[0].type == "url"
    assert "support.apple.com" in m.references[0].value

def test_memory_reference_roundtrip():
    m = Memory(
        module="property",
        category="manual",
        title="Generator manual",
        body="Reference to generator manual.",
        references=[
            Reference(type="url", title="Generac", value="https://www.generac.com/")
        ],
    )

    restored = Memory.from_dict(m.to_dict())
    assert restored.references[0].title == "Generac"
    assert restored.references[0].type == "url"
