from pathlib import Path
import yaml

CONFIG_PATH = Path.home() / "ai/projects/openclaw/ranchbrain/ranchbrain.yaml"

def expand_path(value: str) -> Path:
    return Path(value).expanduser()

def load_settings() -> dict:
    if not CONFIG_PATH.exists():
        return {}

    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}

def get_path(name: str) -> Path:
    settings = load_settings()
    return expand_path(settings["paths"][name])
