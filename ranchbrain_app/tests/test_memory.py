from ranchbrain.models import Memory

def test_memory_creates_id():
    m = Memory(
        module="system",
        category="backup",
        title="Backup fixed",
        body="Backup watchdog path was corrected.",
        memory_type="event",
        tags=["backup", "watchdog"],
    )
    assert m.id
    assert m.module == "system"
    assert "backup" in m.tags

def test_memory_json_roundtrip():
    m = Memory(
        module="property",
        category="maintenance",
        title="Stump burned",
        body="Large stump was burned successfully using a fire ring.",
        memory_type="event",
        tags=["property", "stump"],
    )
    data = m.to_dict()
    restored = Memory.from_dict(data)
    assert restored.title == m.title
    assert restored.id == m.id
