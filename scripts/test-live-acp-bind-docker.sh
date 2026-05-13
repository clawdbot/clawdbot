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
ACP_AGENT_LIST_RAW="${OPENCLAW_LIVE_ACP_BIND_AGENTS:-${OPENCLAW_LIVE_ACP_BIND_AGENT:-claude,codex,gemini}}"
TEMP_DIRS=()
DOCKER_USER="${OPENCLAW_DOCKER_USER:-node}"
DOCKER_HOME_MOUNT=()
DOCKER_AUTH_PRESTAGED=0
DOCKER_TRUSTED_HARNESS_CONTAINER_DIR="/trusted-harness"
DOCKER_TRUSTED_HARNESS_MOUNT=(-v "$TRUSTED_HARNESS_DIR":"$DOCKER_TRUSTED_HARNESS_CONTAINER_DIR":ro)

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
    droid) printf '%s\n' "droid" ;;
    gemini) printf '%s\n' "google-gemini-cli" ;;
    opencode) printf '%s\n' "opencode" ;;
    *)
      echo "Unsupported OPENCLAW_LIVE_ACP_BIND agent: ${1:-} (expected claude, codex, droid, gemini, or opencode)" >&2
      return 1
      ;;
  esac
}

openclaw_live_acp_bind_resolve_agent_command() {
  case "${1:-}" in
    claude) printf '%s' "${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND_CLAUDE:-${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}}" ;;
    codex) printf '%s' "${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND_CODEX:-${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}}" ;;
    droid) printf '%s' "${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND_DROID:-${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}}" ;;
    gemini) printf '%s' "${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND_GEMINI:-${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}}" ;;
    opencode) printf '%s' "${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND_OPENCODE:-${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}}" ;;
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
elif openclaw_live_is_ci; then
  CLI_TOOLS_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-cli-tools.XXXXXX")"
  TEMP_DIRS+=("$CLI_TOOLS_DIR")
else
  CLI_TOOLS_DIR="$HOME/.cache/openclaw/docker-cli-tools"
fi
if [[ -n "${OPENCLAW_DOCKER_CACHE_HOME_DIR:-}" ]]; then
  CACHE_HOME_DIR="${OPENCLAW_DOCKER_CACHE_HOME_DIR}"
elif openclaw_live_is_ci; then
  CACHE_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-cache.XXXXXX")"
  TEMP_DIRS+=("$CACHE_HOME_DIR")
else
  CACHE_HOME_DIR="$HOME/.cache/openclaw/docker-cache"
fi

mkdir -p "$CLI_TOOLS_DIR"
mkdir -p "$CACHE_HOME_DIR"
if openclaw_live_is_ci; then
  DOCKER_USER="$(id -u):$(id -g)"
fi

PROFILE_MOUNT=()
PROFILE_STATUS="none"
if [[ -f "$PROFILE_FILE" && -r "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
  PROFILE_STATUS="$PROFILE_FILE"
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
mkdir -p "$NPM_CONFIG_PREFIX" "$HOME/.local/bin" "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE" || true
export PATH="$HOME/.local/bin:$NPM_CONFIG_PREFIX/bin:$PATH"
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
    export CLAUDE_CODE_EXECUTABLE="$NPM_CONFIG_PREFIX/bin/claude"
    claude auth status || true
    ;;
  codex)
    if [ ! -x "$NPM_CONFIG_PREFIX/bin/codex" ]; then
      npm install -g @openai/codex
    fi
    ;;
  droid)
    if ! command -v droid >/dev/null 2>&1; then
      curl -fsSL https://app.factory.ai/cli | sh
      export PATH="$HOME/.local/bin:$PATH"
    fi
    droid --version
    if [ -z "${FACTORY_API_KEY:-}" ]; then
      echo "SKIP: Droid Docker ACP bind requires FACTORY_API_KEY; Factory OAuth/keyring auth in ~/.factory is not portable into the container." >&2
      exit 0
    fi
    ;;
  gemini)
    mkdir -p "$HOME/.gemini"
    if [ ! -x "$NPM_CONFIG_PREFIX/bin/gemini" ]; then
      npm install -g @google/gemini-cli
    fi
    if [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${GOOGLE_API_KEY:-}" ]; then
      gemini_auth_type="gemini-api-key"
      if [ -z "${GEMINI_API_KEY:-}" ] && [ -n "${GOOGLE_API_KEY:-}" ]; then
        gemini_auth_type="vertex-ai"
        export GOOGLE_GENAI_USE_VERTEXAI="${GOOGLE_GENAI_USE_VERTEXAI:-true}"
      fi
      GEMINI_CLI_AUTH_TYPE="$gemini_auth_type" node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch {}
settings.security = settings.security && typeof settings.security === "object" ? settings.security : {};
settings.security.auth =
  settings.security.auth && typeof settings.security.auth === "object" ? settings.security.auth : {};
settings.security.auth.selectedType = process.env.GEMINI_CLI_AUTH_TYPE;
settings.security.auth.enforcedType = process.env.GEMINI_CLI_AUTH_TYPE;
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
      echo "Using Gemini CLI auth type $gemini_auth_type"
    fi
    ;;
  opencode)
    if [ ! -x "$NPM_CONFIG_PREFIX/bin/opencode" ]; then
      npm install -g opencode-ai
    fi
    export OPENCODE_CONFIG_CONTENT="$(
      node -e 'process.stdout.write(JSON.stringify({model: process.env.OPENCLAW_LIVE_ACP_BIND_OPENCODE_MODEL || "opencode/kimi-k2.6"}))'
    )"
    ;;
  *)
    echo "Unsupported OPENCLAW_LIVE_ACP_BIND_AGENT: $agent" >&2
    exit 1
    ;;
esac
tmp_dir="$(mktemp -d)"
trusted_scripts_dir="${OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"
source "$trusted_scripts_dir/lib/live-docker-stage.sh"
openclaw_live_stage_source_tree "$tmp_dir"
openclaw_live_stage_node_modules "$tmp_dir"
openclaw_live_link_runtime_tree "$tmp_dir"
openclaw_live_stage_state_dir "$tmp_dir/.openclaw-state"
openclaw_live_prepare_staged_config
cd "$tmp_dir"
export OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND="${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}"
node scripts/test-live.mjs -- src/gateway/gateway-acp-bind.live.test.ts
EOF

openclaw_live_acp_bind_append_build_extension acpx
OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"

IFS=',' read -r -a ACP_AGENT_TOKENS <<<"$ACP_AGENT_LIST_RAW"
ACP_AGENTS=()
for token in "${ACP_AGENT_TOKENS[@]}"; do
  agent="$(openclaw_live_trim "$token")"
  [[ -n "$agent" ]] || continue
  openclaw_live_acp_bind_resolve_auth_provider "$agent" >/dev/null
  ACP_AGENTS+=("$agent")
done

if ((${#ACP_AGENTS[@]} == 0)); then
  echo "No ACP bind agents selected. Use OPENCLAW_LIVE_ACP_BIND_AGENTS=claude,codex,droid,gemini,opencode." >&2
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
  if openclaw_live_is_ci; then
    DOCKER_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-home.XXXXXX")"
    TEMP_DIRS+=("$DOCKER_HOME_DIR")
    DOCKER_HOME_MOUNT=(-v "$DOCKER_HOME_DIR":/home/node)
  fi

  if [[ -n "${DOCKER_HOME_DIR:-}" ]]; then
    openclaw_live_stage_auth_into_home "$DOCKER_HOME_DIR" "${AUTH_DIRS[@]}" --files "${AUTH_FILES[@]}"
    DOCKER_AUTH_PRESTAGED=1
  fi

  if [[ "$ACP_AGENT" == "droid" && -z "${FACTORY_API_KEY:-}" ]]; then
    echo "==> Run ACP bind live test in Docker"
    echo "==> Agent: $ACP_AGENT"
    echo "==> Profile file: $PROFILE_STATUS"
    echo "==> Auth dirs: ${AUTH_DIRS_CSV:-none}"
    echo "==> Auth files: ${AUTH_FILES_CSV:-none}"
    echo "SKIP: Droid Docker ACP bind requires FACTORY_API_KEY; Factory OAuth/keyring auth in ~/.factory is not portable into the container." >&2
    continue
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
  echo "==> Profile file: $PROFILE_STATUS"
  echo "==> Auth dirs: ${AUTH_DIRS_CSV:-none}"
  echo "==> Auth files: ${AUTH_FILES_CSV:-none}"
  DOCKER_RUN_ARGS=(docker run --rm -t \
    -u "$DOCKER_USER" \
    --entrypoint bash \
    -e ANTHROPIC_API_KEY \
    -e ANTHROPIC_API_KEY_OLD \
    -e OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    -e OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY_OLD="${ANTHROPIC_API_KEY_OLD:-}" \
    -e GEMINI_API_KEY \
    -e GOOGLE_API_KEY \
    -e FACTORY_API_KEY \
    -e OPENAI_API_KEY \
    -e OPENCODE_API_KEY \
    -e OPENCODE_ZEN_API_KEY \
    -e OPENCODE_CONFIG_CONTENT \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e HOME=/home/node \
    -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    -e OPENCLAW_SKIP_CHANNELS=1 \
    -e OPENCLAW_VITEST_FS_MODULE_CACHE=0 \
    -e OPENCLAW_DOCKER_AUTH_PRESTAGED="$DOCKER_AUTH_PRESTAGED" \
    -e OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED="$AUTH_DIRS_CSV" \
    -e OPENCLAW_DOCKER_AUTH_FILES_RESOLVED="$AUTH_FILES_CSV" \
    -e OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR="${DOCKER_TRUSTED_HARNESS_CONTAINER_DIR}/scripts" \
    -e OPENCLAW_LIVE_DOCKER_SOURCE_STAGE_MODE="${OPENCLAW_LIVE_DOCKER_SOURCE_STAGE_MODE:-copy}" \
    -e OPENCLAW_LIVE_TEST=1 \
    -e OPENCLAW_LIVE_ACP_BIND=1 \
    -e OPENCLAW_LIVE_ACP_BIND_AGENT="$ACP_AGENT" \
    -e OPENCLAW_LIVE_ACP_BIND_OPENCODE_MODEL="${OPENCLAW_LIVE_ACP_BIND_OPENCODE_MODEL:-opencode/kimi-k2.6}" \
    -e OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND="$AGENT_COMMAND")
  openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_HOME_MOUNT
  openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_TRUSTED_HARNESS_MOUNT
  DOCKER_RUN_ARGS+=(\
    -v "$CACHE_HOME_DIR":/home/node/.cache \
    -v "$ROOT_DIR":/src:ro \
    -v "$CONFIG_DIR":/home/node/.openclaw \
    -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace \
    -v "$CLI_TOOLS_DIR":/home/node/.npm-global)
  openclaw_live_append_array DOCKER_RUN_ARGS EXTERNAL_AUTH_MOUNTS
  openclaw_live_append_array DOCKER_RUN_ARGS PROFILE_MOUNT
  DOCKER_RUN_ARGS+=(\
    "$LIVE_IMAGE_NAME" \
    -lc "$LIVE_TEST_CMD")
  "${DOCKER_RUN_ARGS[@]}"
done
