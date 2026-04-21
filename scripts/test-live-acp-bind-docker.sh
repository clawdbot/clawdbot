#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
LIVE_IMAGE_NAME="${OPENCLAW_LIVE_IMAGE:-${IMAGE_NAME}-live}"
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
PROFILE_FILE="${OPENCLAW_PROFILE_FILE:-$HOME/.profile}"
ACP_AGENT_LIST_RAW="${OPENCLAW_LIVE_ACP_BIND_AGENTS:-${OPENCLAW_LIVE_ACP_BIND_AGENT:-claude,codex,gemini}}"
TEMP_DIRS=()
DOCKER_USER="${OPENCLAW_DOCKER_USER:-node}"
DOCKER_HOME_MOUNT=()
DOCKER_AUTH_PRESTAGED=0

openclaw_live_acp_bind_append_build_extension() {
  local extension="${1:?extension required}"
  local current="${OPENCLAW_DOCKER_BUILD_EXTENSIONS:-${OPENCLAW_EXTENSIONS:-}}"
  case " $current " in
    *" $extension "*)
      ;;
    *)
      export OPENCLAW_DOCKER_BUILD_EXTENSIONS="${current:+$current }$extension"
      ;;
  esac
}

openclaw_live_acp_bind_resolve_auth_provider() {
  case "${1:-}" in
    claude) printf '%s\n' "claude-cli" ;;
    codex) printf '%s\n' "codex-cli" ;;
    gemini) printf '%s\n' "google-gemini-cli" ;;
    *)
      echo "Unsupported OPENCLAW_LIVE_ACP_BIND agent: ${1:-} (expected claude, codex, or gemini)" >&2
      return 1
      ;;
  esac
}

openclaw_live_acp_bind_resolve_agent_command() {
  case "${1:-}" in
    claude) printf '%s' "${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND_CLAUDE:-${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}}" ;;
    codex) printf '%s' "${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND_CODEX:-${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}}" ;;
    gemini) printf '%s' "${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND_GEMINI:-${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}}" ;;
    *) return 1 ;;
  esac
}

cleanup_temp_dirs() {
  if ((${#TEMP_DIRS[@]} > 0)); then
    rm -rf "${TEMP_DIRS[@]}"
  fi
}
trap cleanup_temp_dirs EXIT

if [[ -n "${OPENCLAW_DOCKER_CLI_TOOLS_DIR:-}" ]]; then
  CLI_TOOLS_DIR="${OPENCLAW_DOCKER_CLI_TOOLS_DIR}"
elif [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
  CLI_TOOLS_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-cli-tools.XXXXXX")"
  TEMP_DIRS+=("$CLI_TOOLS_DIR")
else
  CLI_TOOLS_DIR="$HOME/.cache/openclaw/docker-cli-tools"
fi
if [[ -n "${OPENCLAW_DOCKER_CACHE_HOME_DIR:-}" ]]; then
  CACHE_HOME_DIR="${OPENCLAW_DOCKER_CACHE_HOME_DIR}"
elif [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
  CACHE_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-cache.XXXXXX")"
  TEMP_DIRS+=("$CACHE_HOME_DIR")
else
  CACHE_HOME_DIR="$HOME/.cache/openclaw/docker-cache"
fi

mkdir -p "$CLI_TOOLS_DIR"
mkdir -p "$CACHE_HOME_DIR"
if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
  DOCKER_USER="$(id -u):$(id -g)"
fi

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" && -r "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

read -r -d '' LIVE_TEST_CMD <<'EOF' || true
set -euo pipefail
[ -f "$HOME/.profile" ] && [ -r "$HOME/.profile" ] && source "$HOME/.profile" || true
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export COREPACK_HOME="${COREPACK_HOME:-$XDG_CACHE_HOME/node/corepack}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$XDG_CACHE_HOME/npm}"
export npm_config_cache="$NPM_CONFIG_CACHE"
mkdir -p "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE" || true
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
if [ "${OPENCLAW_DOCKER_AUTH_PRESTAGED:-0}" != "1" ]; then
  IFS=',' read -r -a auth_dirs <<<"${OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED:-}"
  IFS=',' read -r -a auth_files <<<"${OPENCLAW_DOCKER_AUTH_FILES_RESOLVED:-}"
  if ((${#auth_dirs[@]} > 0)); then
    for auth_dir in "${auth_dirs[@]}"; do
      [ -n "$auth_dir" ] || continue
      if [ -d "/host-auth/$auth_dir" ]; then
        mkdir -p "$HOME/$auth_dir"
        cp -R "/host-auth/$auth_dir/." "$HOME/$auth_dir"
        chmod -R u+rwX "$HOME/$auth_dir" || true
      fi
    done
  fi
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
fi
agent="${OPENCLAW_LIVE_ACP_BIND_AGENT:-claude}"
case "$agent" in
  claude)
    if [ ! -x "$NPM_CONFIG_PREFIX/bin/claude" ]; then
      npm install -g @anthropic-ai/claude-code
    fi
    real_claude="$NPM_CONFIG_PREFIX/bin/claude-real"
    if [ ! -x "$real_claude" ] && [ -x "$NPM_CONFIG_PREFIX/bin/claude" ]; then
      mv "$NPM_CONFIG_PREFIX/bin/claude" "$real_claude"
    fi
    if [ -x "$real_claude" ]; then
      cat > "$NPM_CONFIG_PREFIX/bin/claude" <<WRAP
#!/usr/bin/env bash
script_dir="\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)"
if [ -n "\${OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY:-}" ]; then
  export ANTHROPIC_API_KEY="\${OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY}"
fi
if [ -n "\${OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY_OLD:-}" ]; then
  export ANTHROPIC_API_KEY_OLD="\${OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY_OLD}"
fi
exec "\$script_dir/claude-real" "\$@"
WRAP
      chmod +x "$NPM_CONFIG_PREFIX/bin/claude"
    fi
    claude auth status || true
    ;;
  codex)
    if [ ! -x "$NPM_CONFIG_PREFIX/bin/codex" ]; then
      npm install -g @openai/codex
    fi
    ;;
  gemini)
    mkdir -p "$HOME/.gemini"
    if [ ! -x "$NPM_CONFIG_PREFIX/bin/gemini" ]; then
      npm install -g @google/gemini-cli
    fi
    ;;
  *)
    echo "Unsupported OPENCLAW_LIVE_ACP_BIND_AGENT: $agent" >&2
    exit 1
    ;;
esac
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
source /src/scripts/lib/live-docker-stage.sh
openclaw_live_stage_source_tree "$tmp_dir"
# Use a writable node_modules overlay in the temp repo. Vite writes bundled
# config artifacts under the nearest node_modules/.vite-temp path, and the
# build-stage /app/node_modules tree is root-owned in this Docker lane.
mkdir -p "$tmp_dir/node_modules"
cp -aRs /app/node_modules/. "$tmp_dir/node_modules"
rm -rf "$tmp_dir/node_modules/.vite-temp"
mkdir -p "$tmp_dir/node_modules/.vite-temp"
openclaw_live_link_runtime_tree "$tmp_dir"
openclaw_live_stage_state_dir "$tmp_dir/.openclaw-state"
openclaw_live_prepare_staged_config
cd "$tmp_dir"
export OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND="${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}"
pnpm test:live src/gateway/gateway-acp-bind.live.test.ts
EOF

openclaw_live_acp_bind_append_build_extension acpx
"$ROOT_DIR/scripts/test-live-build-docker.sh"

IFS=',' read -r -a ACP_AGENT_TOKENS <<<"$ACP_AGENT_LIST_RAW"
ACP_AGENTS=()
for token in "${ACP_AGENT_TOKENS[@]}"; do
  agent="$(openclaw_live_trim "$token")"
  [[ -n "$agent" ]] || continue
  openclaw_live_acp_bind_resolve_auth_provider "$agent" >/dev/null
  ACP_AGENTS+=("$agent")
done

if ((${#ACP_AGENTS[@]} == 0)); then
  echo "No ACP bind agents selected. Use OPENCLAW_LIVE_ACP_BIND_AGENTS=claude,codex,gemini." >&2
  exit 1
fi

for ACP_AGENT in "${ACP_AGENTS[@]}"; do
  AUTH_PROVIDER="$(openclaw_live_acp_bind_resolve_auth_provider "$ACP_AGENT")"
  AGENT_COMMAND="$(openclaw_live_acp_bind_resolve_agent_command "$ACP_AGENT")"

  AUTH_DIRS=()
  AUTH_FILES=()
  if [[ -n "${OPENCLAW_DOCKER_AUTH_DIRS:-}" ]]; then
    while IFS= read -r auth_dir; do
      [[ -n "$auth_dir" ]] || continue
      AUTH_DIRS+=("$auth_dir")
    done < <(openclaw_live_collect_auth_dirs)
    while IFS= read -r auth_file; do
      [[ -n "$auth_file" ]] || continue
      AUTH_FILES+=("$auth_file")
    done < <(openclaw_live_collect_auth_files)
  else
    while IFS= read -r auth_dir; do
      [[ -n "$auth_dir" ]] || continue
      AUTH_DIRS+=("$auth_dir")
    done < <(openclaw_live_collect_auth_dirs_from_csv "$AUTH_PROVIDER")
    while IFS= read -r auth_file; do
      [[ -n "$auth_file" ]] || continue
      AUTH_FILES+=("$auth_file")
    done < <(openclaw_live_collect_auth_files_from_csv "$AUTH_PROVIDER")
  fi

  AUTH_DIRS_CSV=""
  if ((${#AUTH_DIRS[@]} > 0)); then
    AUTH_DIRS_CSV="$(openclaw_live_join_csv "${AUTH_DIRS[@]}")"
  fi
  AUTH_FILES_CSV=""
  if ((${#AUTH_FILES[@]} > 0)); then
    AUTH_FILES_CSV="$(openclaw_live_join_csv "${AUTH_FILES[@]}")"
  fi

  DOCKER_HOME_MOUNT=()
  DOCKER_AUTH_PRESTAGED=0
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    DOCKER_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-home.XXXXXX")"
    TEMP_DIRS+=("$DOCKER_HOME_DIR")
    DOCKER_HOME_MOUNT=(-v "$DOCKER_HOME_DIR":/home/node)
  fi

  if [[ -n "${DOCKER_HOME_DIR:-}" ]]; then
    openclaw_live_stage_auth_into_home "$DOCKER_HOME_DIR" "${AUTH_DIRS[@]}" --files "${AUTH_FILES[@]}"
    DOCKER_AUTH_PRESTAGED=1
  fi

  EXTERNAL_AUTH_MOUNTS=()
  if ((${#AUTH_DIRS[@]} > 0)); then
    for auth_dir in "${AUTH_DIRS[@]}"; do
      auth_dir="$(openclaw_live_validate_relative_home_path "$auth_dir")"
      host_path="$HOME/$auth_dir"
      if [[ -d "$host_path" ]]; then
        EXTERNAL_AUTH_MOUNTS+=(-v "$host_path":/host-auth/"$auth_dir":ro)
      fi
    done
  fi
  if ((${#AUTH_FILES[@]} > 0)); then
    for auth_file in "${AUTH_FILES[@]}"; do
      auth_file="$(openclaw_live_validate_relative_home_path "$auth_file")"
      host_path="$HOME/$auth_file"
      if [[ -f "$host_path" ]]; then
        EXTERNAL_AUTH_MOUNTS+=(-v "$host_path":/host-auth-files/"$auth_file":ro)
      fi
    done
  fi

  echo "==> Run ACP bind live test in Docker"
  echo "==> Agent: $ACP_AGENT"
  echo "==> Auth dirs: ${AUTH_DIRS_CSV:-none}"
  echo "==> Auth files: ${AUTH_FILES_CSV:-none}"
  docker run --rm -t \
    -u "$DOCKER_USER" \
    --entrypoint bash \
    -e ANTHROPIC_API_KEY \
    -e ANTHROPIC_API_KEY_OLD \
    -e OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    -e OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY_OLD="${ANTHROPIC_API_KEY_OLD:-}" \
    -e GEMINI_API_KEY \
    -e GOOGLE_API_KEY \
    -e OPENAI_API_KEY \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e HOME=/home/node \
    -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    -e OPENCLAW_SKIP_CHANNELS=1 \
    -e OPENCLAW_VITEST_FS_MODULE_CACHE=0 \
    -e OPENCLAW_DOCKER_AUTH_PRESTAGED="$DOCKER_AUTH_PRESTAGED" \
    -e OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED="$AUTH_DIRS_CSV" \
    -e OPENCLAW_DOCKER_AUTH_FILES_RESOLVED="$AUTH_FILES_CSV" \
    -e OPENCLAW_LIVE_TEST=1 \
    -e OPENCLAW_LIVE_ACP_BIND=1 \
    -e OPENCLAW_LIVE_ACP_BIND_AGENT="$ACP_AGENT" \
    -e OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND="$AGENT_COMMAND" \
    "${DOCKER_HOME_MOUNT[@]}" \
    -v "$CACHE_HOME_DIR":/home/node/.cache \
    -v "$ROOT_DIR":/src:ro \
    -v "$CONFIG_DIR":/home/node/.openclaw \
    -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace \
    -v "$CLI_TOOLS_DIR":/home/node/.npm-global \
    "${EXTERNAL_AUTH_MOUNTS[@]}" \
    "${PROFILE_MOUNT[@]}" \
    "$LIVE_IMAGE_NAME" \
    -lc "$LIVE_TEST_CMD"
done
