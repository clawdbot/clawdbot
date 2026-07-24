from ranchbrain.profile_manager import PROFILES

def test_profiles_defined():
    assert "knowledge" in PROFILES
    assert "code" in PROFILES
    assert "all" in PROFILES
