from dataclasses import dataclass

@dataclass(frozen=True)
class IndexProfile:
    name: str
    include_top: set[str]
    exclude_top: set[str]
    exclude_any: set[str]

PROFILES = {
    "knowledge": IndexProfile(
        name="knowledge",
        include_top={"memories", "notes", "documents", "manuals", "modules", "reports"},
        exclude_top={"index", "logs", "scripts", "src", "tests", "docs"},
        exclude_any={"_archive", ".venv", "__pycache__"},
    ),
    "code": IndexProfile(
        name="code",
        include_top=set(),
        exclude_top={"index", "logs", "memories", "documents", "manuals", "modules", "notes", "reports"},
        exclude_any={"_archive", ".venv", "__pycache__"},
    ),
    "all": IndexProfile(
        name="all",
        include_top=set(),
        exclude_top={"index", "logs"},
        exclude_any={"_archive", ".venv", "__pycache__"},
    ),
}

DEFAULT_PROFILE = "knowledge"

def get_profile(name: str | None = None) -> IndexProfile:
    profile_name = name or DEFAULT_PROFILE
    if profile_name not in PROFILES:
        raise ValueError(f"Unknown index profile: {profile_name}")
    return PROFILES[profile_name]
