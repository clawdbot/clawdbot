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
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
PROFILE_FILE="$(openclaw_live_default_profile_file)"
DOCKER_USER="${OPENCLAW_DOCKER_USER:-node}"
DOCKER_HOME_MOUNT=()
DOCKER_EXTRA_ENV_FILES=()
DOCKER_TRUSTED_HARNESS_CONTAINER_DIR="/trusted-harness"
DOCKER_TRUSTED_HARNESS_MOUNT=(-v "$TRUSTED_HARNESS_DIR":"$DOCKER_TRUSTED_HARNESS_CONTAINER_DIR":ro)
TEMP_DIRS=()

cleanup_temp_dirs() {
  if ((${#TEMP_DIRS[@]} > 0)); then
    rm -rf "${TEMP_DIRS[@]}"
  fi
}
trap cleanup_temp_dirs EXIT

if [[ -n "${OPENCLAW_DOCKER_CACHE_HOME_DIR:-}" ]]; then
  CACHE_HOME_DIR="${OPENCLAW_DOCKER_CACHE_HOME_DIR}"
elif openclaw_live_is_ci; then
  CACHE_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-cache.XXXXXX")"
  TEMP_DIRS+=("$CACHE_HOME_DIR")
else
  CACHE_HOME_DIR="$HOME/.cache/openclaw/docker-cache"
fi
mkdir -p "$CACHE_HOME_DIR"

if openclaw_live_is_ci; then
  DOCKER_USER="$(id -u):$(id -g)"
  DOCKER_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-home.XXXXXX")"
  TEMP_DIRS+=("$DOCKER_HOME_DIR")
  DOCKER_HOME_MOUNT=(-v "$DOCKER_HOME_DIR":/home/node)
fi

PROFILE_MOUNT=()
PROFILE_STATUS="none"
if [[ -f "$PROFILE_FILE" && -r "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
  PROFILE_STATUS="$PROFILE_FILE"
fi

if [[ -n "${OPENAI_API_KEY:-}" || -n "${OPENAI_BASE_URL:-}" || -n "${GEMINI_API_KEY:-}" || -n "${GOOGLE_API_KEY:-}" ]]; then
  docker_env_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-subagent-live-env.XXXXXX")"
  TEMP_DIRS+=("$docker_env_dir")
  docker_env_file="$docker_env_dir/provider.env"
  {
    if [[ -n "${OPENAI_API_KEY:-}" ]]; then
      printf 'OPENCLAW_DOCKER_LIVE_OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY}"
    fi
    if [[ -n "${OPENAI_BASE_URL:-}" ]]; then
      printf 'OPENCLAW_DOCKER_LIVE_OPENAI_BASE_URL=%s\n' "${OPENAI_BASE_URL}"
    fi
    if [[ -n "${GEMINI_API_KEY:-}" ]]; then
      printf 'OPENCLAW_DOCKER_LIVE_GEMINI_API_KEY=%s\n' "${GEMINI_API_KEY}"
    fi
    if [[ -n "${GOOGLE_API_KEY:-}" ]]; then
      printf 'OPENCLAW_DOCKER_LIVE_GOOGLE_API_KEY=%s\n' "${GOOGLE_API_KEY}"
    fi
  } >"$docker_env_file"
  DOCKER_EXTRA_ENV_FILES+=(--env-file "$docker_env_file")
fi

CONTAINER_NODE_OPTIONS="${OPENCLAW_DOCKER_NODE_OPTIONS:-${NODE_OPTIONS:-}}"
if [[ -z "$(openclaw_live_trim "$CONTAINER_NODE_OPTIONS")" ]]; then
  CONTAINER_NODE_OPTIONS="--max-old-space-size=4096"
fi
CONTAINER_NODE_OPTIONS="$CONTAINER_NODE_OPTIONS --disable-warning=ExperimentalWarning"

read -r -d '' LIVE_TEST_CMD <<'EOF' || true
set -euo pipefail
[ -f "$HOME/.profile" ] && [ -r "$HOME/.profile" ] && source "$HOME/.profile" || true
if [ -n "${OPENCLAW_DOCKER_LIVE_OPENAI_API_KEY:-}" ]; then
  export OPENAI_API_KEY="$OPENCLAW_DOCKER_LIVE_OPENAI_API_KEY"
  unset OPENCLAW_DOCKER_LIVE_OPENAI_API_KEY
fi
if [ -n "${OPENCLAW_DOCKER_LIVE_OPENAI_BASE_URL:-}" ]; then
  export OPENAI_BASE_URL="$OPENCLAW_DOCKER_LIVE_OPENAI_BASE_URL"
  unset OPENCLAW_DOCKER_LIVE_OPENAI_BASE_URL
fi
if [ -n "${OPENCLAW_DOCKER_LIVE_GEMINI_API_KEY:-}" ]; then
  export GEMINI_API_KEY="$OPENCLAW_DOCKER_LIVE_GEMINI_API_KEY"
  unset OPENCLAW_DOCKER_LIVE_GEMINI_API_KEY
fi
if [ -n "${OPENCLAW_DOCKER_LIVE_GOOGLE_API_KEY:-}" ]; then
  export GOOGLE_API_KEY="$OPENCLAW_DOCKER_LIVE_GOOGLE_API_KEY"
  unset OPENCLAW_DOCKER_LIVE_GOOGLE_API_KEY
fi
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export COREPACK_HOME="${COREPACK_HOME:-$XDG_CACHE_HOME/node/corepack}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$XDG_CACHE_HOME/npm}"
export npm_config_cache="$NPM_CONFIG_CACHE"
mkdir -p "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE" || true
tmp_dir="$(mktemp -d)"
trusted_scripts_dir="${OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"
source "$trusted_scripts_dir/lib/live-docker-stage.sh"
openclaw_live_stage_source_tree "$tmp_dir"
openclaw_live_stage_node_modules "$tmp_dir"
openclaw_live_link_runtime_tree "$tmp_dir"
openclaw_live_stage_state_dir "$tmp_dir/.openclaw-state"
openclaw_live_prepare_staged_config
cd "$tmp_dir"
OPENCLAW_LIVE_TEST=1 \
OPENCLAW_LIVE_SUBAGENT_E2E=1 \
OPENCLAW_VITEST_MAX_WORKERS="${OPENCLAW_VITEST_MAX_WORKERS:-1}" \
node scripts/test-live.mjs -- src/agents/subagent-announce.live.test.ts -- --reporter=verbose
EOF

OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"

echo "==> Run subagent announce live test in Docker"
echo "==> Target: src/agents/subagent-announce.live.test.ts"
echo "==> Model: ${OPENCLAW_LIVE_SUBAGENT_E2E_MODEL:-openai/gpt-5.5}"
echo "==> Profile file: $PROFILE_STATUS"
DOCKER_RUN_ARGS=(docker run --rm -t \
  -u "$DOCKER_USER" \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS="$CONTAINER_NODE_OPTIONS" \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SUPPRESS_NOTES=1 \
  -e OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR="${DOCKER_TRUSTED_HARNESS_CONTAINER_DIR}/scripts" \
  -e OPENCLAW_LIVE_DOCKER_SOURCE_STAGE_MODE="${OPENCLAW_LIVE_DOCKER_SOURCE_STAGE_MODE:-copy}" \
  -e OPENCLAW_LIVE_TEST=1 \
  -e OPENCLAW_LIVE_TEST_QUIET="${OPENCLAW_LIVE_TEST_QUIET:-}" \
  -e OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS="${OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS:-}" \
  -e OPENCLAW_LIVE_SUBAGENT_E2E=1 \
  -e OPENCLAW_LIVE_SUBAGENT_E2E_MODEL="${OPENCLAW_LIVE_SUBAGENT_E2E_MODEL:-}" \
  -e OPENCLAW_VITEST_FS_MODULE_CACHE=0 \
  -e OPENCLAW_VITEST_MAX_WORKERS="${OPENCLAW_VITEST_MAX_WORKERS:-1}")
openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_EXTRA_ENV_FILES
openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_HOME_MOUNT
openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_TRUSTED_HARNESS_MOUNT
DOCKER_RUN_ARGS+=(\
  -v "$CACHE_HOME_DIR":/home/node/.cache \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.openclaw \
  -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace)
openclaw_live_append_array DOCKER_RUN_ARGS PROFILE_MOUNT
DOCKER_RUN_ARGS+=(\
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD")
"${DOCKER_RUN_ARGS[@]}"
