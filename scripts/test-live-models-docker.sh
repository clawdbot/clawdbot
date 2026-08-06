#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${OPENCLAW_LIVE_DOCKER_REPO_ROOT:-$SCRIPT_ROOT_DIR}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
TRUSTED_HARNESS_DIR="${OPENCLAW_LIVE_DOCKER_TRUSTED_HARNESS_DIR:-$SCRIPT_ROOT_DIR}"
if [[ -z "$TRUSTED_HARNESS_DIR" || ! -d "$TRUSTED_HARNESS_DIR" ]]; then
  echo "ERROR: trusted live Docker harness directory not found: ${TRUSTED_HARNESS_DIR:-<empty>}." >&2
  exit 1
fi
TRUSTED_HARNESS_DIR="$(cd "$TRUSTED_HARNESS_DIR" && pwd)"
source "$TRUSTED_HARNESS_DIR/scripts/lib/live-docker-auth.sh"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
LIVE_IMAGE_NAME="${OPENCLAW_LIVE_IMAGE:-${IMAGE_NAME}-live}"
PROFILE_FILE="$(openclaw_live_default_profile_file)"
DOCKER_AUTH_PRESTAGED=0
DOCKER_TRUSTED_HARNESS_CONTAINER_DIR="/trusted-harness"
DOCKER_TRUSTED_HARNESS_MOUNT=(-v "$TRUSTED_HARNESS_DIR":"$DOCKER_TRUSTED_HARNESS_CONTAINER_DIR":ro)

LIVE_MAX_MODELS="${OPENCLAW_LIVE_MAX_MODELS:-}"
if [[ -n "$LIVE_MAX_MODELS" && ! "$LIVE_MAX_MODELS" =~ ^\+?[0-9]+$ ]]; then
  echo "invalid OPENCLAW_LIVE_MAX_MODELS: $LIVE_MAX_MODELS" >&2
  exit 2
fi
LIVE_MODEL_TIMEOUT_MS="${OPENCLAW_LIVE_MODEL_TIMEOUT_MS:-}"
if [[ -n "$LIVE_MODEL_TIMEOUT_MS" ]]; then
  LIVE_MODEL_TIMEOUT_MS="$(openclaw_live_read_positive_int_env OPENCLAW_LIVE_MODEL_TIMEOUT_MS "$LIVE_MODEL_TIMEOUT_MS")"
fi
openclaw_live_init_temp_dirs

if openclaw_live_truthy "${OPENCLAW_DOCKER_PROFILE_ENV_ONLY:-}"; then
  CONFIG_DIR="$(mktemp -d)"
  WORKSPACE_DIR="$(mktemp -d)"
  TEMP_DIRS+=("$CONFIG_DIR" "$WORKSPACE_DIR")
  OPENCLAW_DOCKER_AUTH_DIRS=none
else
  CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
  WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
fi
openclaw_live_init_cache_home_dir
openclaw_live_init_managed_home
openclaw_live_init_profile_mount

openclaw_live_collect_auth_for_providers "${OPENCLAW_LIVE_PROVIDERS:-},${OPENCLAW_LIVE_GATEWAY_PROVIDERS:-}"
openclaw_live_finalize_auth_mounts

read -r -d '' LIVE_TEST_CMD <<'EOF' || true
set -euo pipefail
[ -f "$HOME/.profile" ] && [ -r "$HOME/.profile" ] && source "$HOME/.profile" || true
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export COREPACK_HOME="${COREPACK_HOME:-$XDG_CACHE_HOME/node/corepack}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$XDG_CACHE_HOME/npm}"
export npm_config_cache="$NPM_CONFIG_CACHE"
mkdir -p "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE" || true
tmp_dir="$(mktemp -d)"
trusted_scripts_dir="${OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"
source "$trusted_scripts_dir/lib/live-docker-stage.sh"
openclaw_live_stage_mounted_auth
openclaw_live_stage_source_tree "$tmp_dir"
openclaw_live_stage_node_modules "$tmp_dir"
openclaw_live_link_runtime_tree "$tmp_dir"
openclaw_live_stage_state_dir "$tmp_dir/.openclaw-state"
openclaw_live_prepare_staged_config
cd "$tmp_dir"
node scripts/test-live.mjs -- src/agents/models.profiles.live.test.ts
EOF

OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"
if openclaw_live_uses_managed_bind_dirs; then
  openclaw_live_chown_bind_dirs_for_container_user \
    "$LIVE_IMAGE_NAME" \
    "$DOCKER_USER" \
    "$CACHE_HOME_DIR" \
    "${DOCKER_HOME_DIR:-}"
fi

echo "==> Run live model tests (profile keys)"
echo "==> Target: src/agents/models.profiles.live.test.ts"
echo "==> Profile env only: ${OPENCLAW_DOCKER_PROFILE_ENV_ONLY:-0}"
echo "==> Profile file: $PROFILE_STATUS"
echo "==> External auth dirs: ${AUTH_DIRS_CSV:-none}"
echo "==> External auth files: ${AUTH_FILES_CSV:-none}"
DOCKER_RUN_ARGS=()
openclaw_live_init_docker_run_args DOCKER_RUN_ARGS "${OPENCLAW_LIVE_MODELS_DOCKER_RUN_TIMEOUT:-2100s}"
DOCKER_RUN_ARGS+=(--rm -t \
  -u "$DOCKER_USER" \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS="$(openclaw_live_container_node_options)" \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SUPPRESS_NOTES=1 \
  -e OPENCLAW_DOCKER_AUTH_PRESTAGED="$DOCKER_AUTH_PRESTAGED" \
  -e OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED="$AUTH_DIRS_CSV" \
  -e OPENCLAW_DOCKER_AUTH_FILES_RESOLVED="$AUTH_FILES_CSV" \
  -e OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR="${DOCKER_TRUSTED_HARNESS_CONTAINER_DIR}/scripts" \
  -e OPENCLAW_LIVE_DOCKER_SOURCE_STAGE_MODE="${OPENCLAW_LIVE_DOCKER_SOURCE_STAGE_MODE:-copy}" \
  -e OPENCLAW_LIVE_TEST=1 \
  -e OPENCLAW_LIVE_MODELS="${OPENCLAW_LIVE_MODELS:-modern}" \
  -e OPENCLAW_LIVE_PROVIDERS="${OPENCLAW_LIVE_PROVIDERS:-}" \
  -e OPENCLAW_LIVE_MAX_MODELS="$LIVE_MAX_MODELS" \
  -e OPENCLAW_LIVE_MODEL_TIMEOUT_MS="$LIVE_MODEL_TIMEOUT_MS" \
  -e OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS="${OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS:-}" \
  -e OPENCLAW_LIVE_GATEWAY_MODELS="${OPENCLAW_LIVE_GATEWAY_MODELS:-}" \
  -e OPENCLAW_LIVE_GATEWAY_PROVIDERS="${OPENCLAW_LIVE_GATEWAY_PROVIDERS:-}" \
  -e OPENCLAW_LIVE_GATEWAY_MAX_MODELS="${OPENCLAW_LIVE_GATEWAY_MAX_MODELS:-}" \
  -e OPENCLAW_VITEST_FS_MODULE_CACHE=0)
openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_HOME_MOUNT
openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_TRUSTED_HARNESS_MOUNT
DOCKER_RUN_ARGS+=(\
  -v "$CACHE_HOME_DIR":/home/node/.cache \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.openclaw \
  -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace)
openclaw_live_append_array DOCKER_RUN_ARGS EXTERNAL_AUTH_MOUNTS
openclaw_live_append_array DOCKER_RUN_ARGS PROFILE_MOUNT
DOCKER_RUN_ARGS+=(\
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD")
"${DOCKER_RUN_ARGS[@]}"
