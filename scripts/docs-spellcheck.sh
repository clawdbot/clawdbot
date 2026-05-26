#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
write_flag=()
if [[ "$mode" == "--write" ]]; then
  write_flag=(-w)
fi

args=(
  README.md
  docs
  --skip=*.png,*.jpg,*.jpeg,*.gif,*.svg
  -D
  -
  -D
  scripts/codespell-dictionary.txt
  -I
  scripts/codespell-ignore.txt
  ${write_flag[@]+"${write_flag[@]}"}
)

if command -v codespell >/dev/null 2>&1; then
  codespell "${args[@]}"
  exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  python3 -m pip install --user --disable-pip-version-check --break-system-packages codespell >/dev/null 2>&1 || \
    python3 -m pip install --user --disable-pip-version-check codespell >/dev/null 2>&1

  user_bin="$(python3 - <<'PY'
import site
print(f"{site.USER_BASE}/bin")
PY
)"
  if [[ -x "${user_bin}/codespell" ]]; then
    "${user_bin}/codespell" "${args[@]}"
    exit 0
  fi
fi

echo "codespell unavailable: install codespell or python3" >&2
exit 1
