"""Run one configured hook without initializing unrelated repositories."""

from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


def main():
    from pre_commit.clientlib import load_config
    from pre_commit.yaml import yaml_dump, yaml_load

    config_path, selected, *arguments = sys.argv[1:]
    # Validate the entire original config before dropping anything. Keep the raw
    # stanzas so pre-commit still owns manifest merging, defaults, and filters.
    load_config(config_path)
    config = yaml_load(Path(config_path).read_text(encoding="utf-8"))
    repos = []
    for repo in config["repos"]:
        hooks = [hook for hook in repo["hooks"]
                 if hook["id"] == selected or hook.get("alias") == selected]
        if hooks:
            repos.append({**repo, "hooks": hooks})
    if not repos:
        raise ValueError(f"No hook with id or alias {selected!r} in {config_path}")
    config["repos"] = repos

    # pre-commit 4.6.2 clones all configured repos before selecting a hook.
    # Both this script and its child use -I to exclude candidate Python imports.
    with TemporaryDirectory(prefix="pre-commit-selected-") as directory:
        projected = Path(directory) / "config.yaml"
        projected.write_text(yaml_dump(config), encoding="utf-8")
        result = subprocess.run([
            sys.executable, "-I", "-m", "pre_commit", "run", "--config",
            str(projected), selected, *arguments,
        ])
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    try:
        code = main()
    except KeyboardInterrupt:
        code = 130
    except Exception as error:
        print(f"[pre-commit-selected] {error}", file=sys.stderr)
        code = 1
    if code:
        print(f"[pre-commit-selected] FAILED (exit {code})", file=sys.stderr)
    raise SystemExit(code)
