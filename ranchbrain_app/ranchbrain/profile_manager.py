from dataclasses import dataclass
from pathlib import Path
from .config import OPENCLAW_BASE, RANCHBRAIN_DATA

@dataclass(frozen=True)
class IndexProfile:
    name: str
    roots: tuple[Path, ...]
    include_top: set[str]
    exclude_top: set[str]
    exclude_any: set[str]

PROFILES = {
    "knowledge": IndexProfile(
        name="knowledge",
        roots=(RANCHBRAIN_DATA,),
        include_top={"memories", "notes", "documents", "manuals", "modules", "reports"},
        exclude_top={"index", "logs", "scripts", "src", "tests", "docs"},
        exclude_any={"_archive", ".venv", "__pycache__"},
    ),
    "code": IndexProfile(
        name="code",
        roots=(OPENCLAW_BASE / "ranchbrain_app",),
        include_top=set(),
        exclude_top=set(),
        exclude_any={".venv", "__pycache__", ".pytest_cache"},
    ),
    "all": IndexProfile(
        name="all",
        roots=(RANCHBRAIN_DATA, OPENCLAW_BASE / "ranchbrain_app"),
        include_top=set(),
        exclude_top={"index", "logs"},
        exclude_any={"_archive", ".venv", "__pycache__", ".pytest_cache"},
    ),
}

DEFAULT_PROFILE = "knowledge"

def get_profile(name: str | None = None) -> IndexProfile:
    profile_name = name or DEFAULT_PROFILE
    if profile_name not in PROFILES:
        raise ValueError(f"Unknown index profile: {profile_name}")
    return PROFILES[profile_name]

def should_index_path(path: Path, root: Path, profile: IndexProfile) -> bool:
    if not path.is_file():
        return False

    rel = path.relative_to(root)

    if rel.parts and rel.parts[0] in profile.exclude_top:
        return False

    if any(part in profile.exclude_any for part in rel.parts):
        return False

    if profile.include_top and rel.parts and rel.parts[0] not in profile.include_top:
        return False

    return True
