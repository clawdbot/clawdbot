"""Install pinned zizmor and prepare its local-only pre-commit hook."""

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


def main():
    policy_path, = sys.argv[1:]
    policy = Path(policy_path).absolute()
    if not policy.is_file():
        raise FileNotFoundError(f"Trusted zizmor policy is unavailable: {policy}")
    runner_temp = Path(os.environ["RUNNER_TEMP"]).absolute()
    venv = runner_temp / "pre-commit-venv"
    python = str(venv / "bin/python")
    subprocess.run([sys.executable, "-I", "-m", "venv", str(venv)], check=True)
    subprocess.run([
        python, "-I", "-m", "pip", "install", "--disable-pip-version-check",
        "pre-commit==4.6.2", "zizmor==1.29.0",
    ], check=True)

    hooks = [
        {
            "id": "zizmor", "name": "zizmor",
            "entry": shlex.join([str(venv / "bin/zizmor")]),
            "language": "system", "types": ["yaml"],
            "files": r"(\.github/(workflows/.*|dependabot.ya?ml))|(action\.ya?ml)$",
            "require_serial": True,
            "args": ["--config", str(policy), "--persona=regular",
                     "--min-severity=medium", "--min-confidence=medium"],
            "exclude": "^(vendor/|apps/swabble/)",
        },
    ]
    config = runner_temp / "security-scanners-pre-commit.yaml"
    # JSON is valid YAML; the bootstrap interpreter needs only the standard library.
    config.write_text(json.dumps({"repos": [{"repo": "local", "hooks": hooks}]}), encoding="utf-8")
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as output:
        output.write(f"PRE_COMMIT_CONFIG_PATH={config}\n")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except KeyboardInterrupt:
        code = 130
    except subprocess.CalledProcessError as error:
        print(f"[setup-scanners] {error}", file=sys.stderr)
        code = error.returncode if error.returncode >= 0 else 128 - error.returncode
    except Exception as error:
        print(f"[setup-scanners] {error}", file=sys.stderr)
        code = 1
    if code:
        print(f"[setup-scanners] FAILED (exit {code})", file=sys.stderr)
    raise SystemExit(code)
