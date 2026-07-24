from ranchbrain.profile_manager import get_profile

def test_get_knowledge_profile():
    p = get_profile("knowledge")
    assert p.name == "knowledge"
    assert p.roots

def test_get_code_profile():
    p = get_profile("code")
    assert p.name == "code"
    assert p.roots
