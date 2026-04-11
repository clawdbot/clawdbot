#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
LIVE_IMAGE_NAME="${OPENCLAW_LIVE_IMAGE:-${IMAGE_NAME}-live}"
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
PROFILE_FILE="${OPENCLAW_PROFILE_FILE:-$HOME/.profile}"
CLI_TOOLS_DIR="${OPENCLAW_DOCKER_CLI_TOOLS_DIR:-$HOME/.cache/openclaw/docker-cli-tools}"

mkdir -p "$CLI_TOOLS_DIR"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

AUTH_FILES=()
while IFS= read -r auth_file; do
  [[ -n "$auth_file" ]] || continue
  AUTH_FILES+=("$auth_file")
done < <(openclaw_live_collect_auth_files_from_csv "openai-codex")

AUTH_FILES_CSV=""
if ((${#AUTH_FILES[@]} > 0)); then
  AUTH_FILES_CSV="$(openclaw_live_join_csv "${AUTH_FILES[@]}")"
fi

EXTERNAL_AUTH_MOUNTS=()
if ((${#AUTH_FILES[@]} > 0)); then
  for auth_file in "${AUTH_FILES[@]}"; do
    host_path="$HOME/$auth_file"
    if [[ -f "$host_path" ]]; then
      EXTERNAL_AUTH_MOUNTS+=(-v "$host_path":/host-auth-files/"$auth_file":ro)
    fi
  done
fi

read -r -d '' LIVE_TEST_CMD <<'EOF' || true
set -euo pipefail
[ -f "$HOME/.profile" ] && source "$HOME/.profile" || true
export PATH="$HOME/.npm-global/bin:$PATH"
IFS=',' read -r -a auth_files <<<"${OPENCLAW_DOCKER_AUTH_FILES_RESOLVED:-}"
if ((${#auth_files[@]} > 0)); then
  for auth_file in "${auth_files[@]}"; do
    [ -n "$auth_file" ] || continue
    if [ -f "/host-auth-files/$auth_file" ]; then
      mkdir -p "$(dirname "$HOME/$auth_file")"
      cp "/host-auth-files/$auth_file" "$HOME/$auth_file"
      chmod u+rw "$HOME/$auth_file" || true
    fi
  done
fi
if [ ! -x "$HOME/.npm-global/bin/codex" ]; then
  npm_config_prefix="$HOME/.npm-global" npm install -g @openai/codex
fi
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
source /src/scripts/lib/live-docker-stage.sh
openclaw_live_stage_source_tree "$tmp_dir"
mkdir -p "$tmp_dir/node_modules"
cp -aRs /app/node_modules/. "$tmp_dir/node_modules"
rm -rf "$tmp_dir/node_modules/.vite-temp"
mkdir -p "$tmp_dir/node_modules/.vite-temp"
openclaw_live_link_runtime_tree "$tmp_dir"
openclaw_live_stage_state_dir "$tmp_dir/.openclaw-state"
openclaw_live_prepare_staged_config
cd "$tmp_dir"
pnpm test:live src/gateway/gateway-codex-harness.live.test.ts
EOF

"$ROOT_DIR/scripts/test-live-build-docker.sh"

echo "==> Run Codex harness live test in Docker"
echo "==> Model: ${OPENCLAW_LIVE_CODEX_HARNESS_MODEL:-codex/gpt-5.4}"
echo "==> Image probe: ${OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE:-1}"
echo "==> MCP probe: ${OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE:-1}"
echo "==> Harness fallback: none"
echo "==> Auth files: ${AUTH_FILES_CSV:-none}"
docker run --rm -t \
  -u node \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e OPENAI_API_KEY \
  -e OPENCLAW_AGENT_HARNESS_FALLBACK=none \
  -e OPENCLAW_CODEX_APP_SERVER_BIN="${OPENCLAW_CODEX_APP_SERVER_BIN:-codex}" \
  -e OPENCLAW_DOCKER_AUTH_FILES_RESOLVED="$AUTH_FILES_CSV" \
  -e OPENCLAW_LIVE_CODEX_HARNESS=1 \
  -e OPENCLAW_LIVE_CODEX_HARNESS_DEBUG="${OPENCLAW_LIVE_CODEX_HARNESS_DEBUG:-}" \
  -e OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE="${OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE:-1}" \
  -e OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE="${OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE:-1}" \
  -e OPENCLAW_LIVE_CODEX_HARNESS_MODEL="${OPENCLAW_LIVE_CODEX_HARNESS_MODEL:-codex/gpt-5.4}" \
  -e OPENCLAW_LIVE_TEST=1 \
  -e OPENCLAW_VITEST_FS_MODULE_CACHE=0 \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.openclaw \
  -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace \
  -v "$CLI_TOOLS_DIR":/home/node/.npm-global \
  "${EXTERNAL_AUTH_MOUNTS[@]}" \
  "${PROFILE_MOUNT[@]}" \
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD"
