#!/usr/bin/env bash
set -euo pipefail

profile_path="${1:-$HOME/.openclaw-testbox-live.profile}"
helper_path="${2:-$HOME/.local/bin/openclaw-testbox-env}"

mkdir -p "$(dirname "$helper_path")"

bash scripts/ci-hydrate-live-auth.sh "$profile_path"

cat >"$helper_path" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

profile_path="${OPENCLAW_TESTBOX_PROFILE_FILE:-$HOME/.openclaw-testbox-live.profile}"
if [[ ! -f "$profile_path" ]]; then
  echo "Missing Testbox provider env profile: $profile_path" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$profile_path"
set +a

if [[ "$#" -eq 0 ]]; then
  exec "${SHELL:-/bin/bash}"
fi

exec "$@"
SH
chmod 700 "$helper_path"
