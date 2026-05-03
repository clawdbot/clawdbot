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
PROFILE_FILE="${OPENCLAW_PROFILE_FILE:-$HOME/.profile}"
DEFAULT_PROVIDER="${OPENCLAW_DOCKER_CLI_BACKEND_PROVIDER:-claude-cli}"
CLI_MODEL="${OPENCLAW_LIVE_CLI_BACKEND_MODEL:-}"
CLI_PROVIDER="${CLI_MODEL%%/*}"
CLI_DISABLE_MCP_CONFIG="${OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG:-}"
CLI_AUTH_MODE="${OPENCLAW_LIVE_CLI_BACKEND_AUTH:-auto}"
CLI_SETUP_TIMEOUT_SECONDS="${OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS:-180}"
TEMP_DIRS=()
DOCKER_USER="${OPENCLAW_DOCKER_USER:-node}"
DOCKER_HOME_MOUNT=()
DOCKER_EXTRA_ENV_FILES=()
DOCKER_AUTH_PRESTAGED=0
DOCKER_TRUSTED_HARNESS_CONTAINER_DIR="/trusted-harness"
DOCKER_TRUSTED_HARNESS_MOUNT=(-v "$TRUSTED_HARNESS_DIR":"$DOCKER_TRUSTED_HARNESS_CONTAINER_DIR":ro)

if [[ -z "$CLI_PROVIDER" || "$CLI_PROVIDER" == "$CLI_MODEL" ]]; then
  CLI_PROVIDER="$DEFAULT_PROVIDER"
fi
CLI_USE_CI_SAFE_CODEX_CONFIG="${OPENCLAW_LIVE_CLI_BACKEND_USE_CI_SAFE_CODEX_CONFIG:-}"
if [[ -z "$CLI_USE_CI_SAFE_CODEX_CONFIG" ]]; then
  if [[ "$CLI_PROVIDER" == "codex-cli" ]]; then
    CLI_USE_CI_SAFE_CODEX_CONFIG="1"
  else
    CLI_USE_CI_SAFE_CODEX_CONFIG="0"
  fi
fi

case "$CLI_AUTH_MODE" in
  auto | api-key | subscription)
    ;;
  *)
    echo "ERROR: OPENCLAW_LIVE_CLI_BACKEND_AUTH must be one of: auto, api-key, subscription." >&2
    exit 1
    ;;
esac

if [[ "$CLI_AUTH_MODE" == "subscription" && "$CLI_PROVIDER" != "claude-cli" ]]; then
  echo "ERROR: OPENCLAW_LIVE_CLI_BACKEND_AUTH=subscription is only supported for claude-cli." >&2
  exit 1
fi

if [[ "$CLI_AUTH_MODE" == "api-key" && "$CLI_PROVIDER" == "codex-cli" ]]; then
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    echo "ERROR: OPENCLAW_LIVE_CLI_BACKEND_AUTH=api-key for codex-cli requires OPENAI_API_KEY." >&2
    exit 1
  fi
fi

CLI_METADATA_JSON="$(node --import tsx "$ROOT_DIR/scripts/print-cli-backend-live-metadata.ts" "$CLI_PROVIDER")"
read_metadata_field() {
  local field="$1"
  node -e 'const data = JSON.parse(process.argv[1]); const field = process.argv[2]; const value = data?.[field]; if (value == null) process.exit(1); process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));' \
    "$CLI_METADATA_JSON" \
    "$field"
}

DEFAULT_MODEL="$(read_metadata_field defaultModelRef 2>/dev/null || printf '%s' 'claude-cli/claude-sonnet-4-6')"
CLI_MODEL="${CLI_MODEL:-$DEFAULT_MODEL}"
CLI_DEFAULT_COMMAND="$(read_metadata_field command 2>/dev/null || true)"
CLI_DOCKER_NPM_PACKAGE="$(read_metadata_field dockerNpmPackage 2>/dev/null || true)"
CLI_DOCKER_BINARY_NAME="$(read_metadata_field dockerBinaryName 2>/dev/null || true)"

if [[ "$CLI_PROVIDER" == "claude-cli" && -z "$CLI_DISABLE_MCP_CONFIG" ]]; then
  if [[ "$CLI_AUTH_MODE" == "subscription" ]]; then
    CLI_DISABLE_MCP_CONFIG="1"
  else
    CLI_DISABLE_MCP_CONFIG="0"
  fi
fi
export OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE:-0}"
export OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE:-0}"
export OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE:-0}"

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
  DOCKER_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-home.XXXXXX")"
  TEMP_DIRS+=("$DOCKER_HOME_DIR")
  DOCKER_HOME_MOUNT=(-v "$DOCKER_HOME_DIR":/home/node)
fi

if [[ "$CLI_PROVIDER" == "claude-cli" && "$CLI_AUTH_MODE" == "subscription" ]]; then
  CLAUDE_CREDS_FILE="$HOME/.claude/.credentials.json"
  CLAUDE_SUBSCRIPTION_AUTH_SOURCE=""
  CLAUDE_SUBSCRIPTION_TYPE=""
  if [[ -f "$CLAUDE_CREDS_FILE" ]]; then
    CLAUDE_SUBSCRIPTION_TYPE="$(
      node -e '
        const fs = require("node:fs");
        const file = process.argv[1];
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const subscriptionType = String(data?.claudeAiOauth?.subscriptionType ?? "").trim();
        if (!subscriptionType || subscriptionType === "unknown") process.exit(2);
        process.stdout.write(subscriptionType);
      ' "$CLAUDE_CREDS_FILE" 2>/dev/null
    )" || {
      echo "ERROR: $CLAUDE_CREDS_FILE does not look like Claude subscription OAuth auth." >&2
      echo "Expected claudeAiOauth.subscriptionType to be present." >&2
      exit 1
    }
    CLAUDE_SUBSCRIPTION_AUTH_SOURCE="credentials-file"
  elif [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    CLAUDE_SUBSCRIPTION_TYPE="oauth-token"
    CLAUDE_SUBSCRIPTION_AUTH_SOURCE="env-token"
  else
    echo "ERROR: Claude subscription auth requires either:" >&2
    echo "  - $CLAUDE_CREDS_FILE with claudeAiOauth.subscriptionType, or" >&2
    echo "  - CLAUDE_CODE_OAUTH_TOKEN from 'claude setup-token'." >&2
    exit 1
  fi
  if [[ -z "${OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV:-}" ]]; then
    if [[ "$CLAUDE_SUBSCRIPTION_AUTH_SOURCE" == "env-token" ]]; then
      export OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV='["CLAUDE_CODE_OAUTH_TOKEN"]'
    else
      export OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV="[]"
    fi
  fi
  if [[ "$OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV" == *ANTHROPIC_API_KEY* ]]; then
    echo "ERROR: subscription auth smoke must not preserve Anthropic API-key env vars." >&2
    exit 1
  fi
  if [[ "$CLAUDE_SUBSCRIPTION_AUTH_SOURCE" == "env-token" && "$OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV" != *CLAUDE_CODE_OAUTH_TOKEN* ]]; then
    echo "ERROR: CLAUDE_CODE_OAUTH_TOKEN subscription smoke must preserve CLAUDE_CODE_OAUTH_TOKEN for the Gateway child process." >&2
    exit 1
  fi
  export OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE:-0}"
  export OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE:-1}"
  export OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE:-0}"
  export OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE:-0}"
fi

PROFILE_MOUNT=()
PROFILE_STATUS="none"
if [[ -f "$PROFILE_FILE" && -r "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
  PROFILE_STATUS="$PROFILE_FILE"
fi

AUTH_DIRS=()
AUTH_FILES=()
if [[ "$CLI_AUTH_MODE" == "api-key" && "$CLI_PROVIDER" == "codex-cli" ]]; then
  AUTH_FILES+=(".codex/config.toml")
elif [[ -n "${OPENCLAW_DOCKER_AUTH_DIRS:-}" ]]; then
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
  done < <(openclaw_live_collect_auth_dirs_from_csv "$CLI_PROVIDER")
  while IFS= read -r auth_file; do
    [[ -n "$auth_file" ]] || continue
    AUTH_FILES+=("$auth_file")
  done < <(openclaw_live_collect_auth_files_from_csv "$CLI_PROVIDER")
fi
AUTH_DIRS_CSV=""
if ((${#AUTH_DIRS[@]} > 0)); then
  AUTH_DIRS_CSV="$(openclaw_live_join_csv "${AUTH_DIRS[@]}")"
fi
AUTH_FILES_CSV=""
if ((${#AUTH_FILES[@]} > 0)); then
  AUTH_FILES_CSV="$(openclaw_live_join_csv "${AUTH_FILES[@]}")"
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
run_setup_command() {
  timeout --foreground "${OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS:-180}s" "$@"
}
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
provider="${OPENCLAW_DOCKER_CLI_BACKEND_PROVIDER:-claude-cli}"
default_command="${OPENCLAW_DOCKER_CLI_BACKEND_COMMAND_DEFAULT:-}"
docker_package="${OPENCLAW_DOCKER_CLI_BACKEND_NPM_PACKAGE:-}"
binary_name="${OPENCLAW_DOCKER_CLI_BACKEND_BINARY_NAME:-}"
if [ "$provider" = "codex-cli" ] && [ "${OPENCLAW_LIVE_CLI_BACKEND_AUTH:-auto}" != "api-key" ]; then
  unset OPENAI_API_KEY
  unset OPENAI_BASE_URL
fi
if [ -z "$binary_name" ] && [ -n "$default_command" ]; then
  binary_name="$(basename "$default_command")"
fi
if [ -z "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND:-}" ] && [ -n "$binary_name" ]; then
  export OPENCLAW_LIVE_CLI_BACKEND_COMMAND="$NPM_CONFIG_PREFIX/bin/$binary_name"
fi
package_has_explicit_version() {
  case "$1" in
    @*/*@*) return 0 ;;
    *@*)
      [[ "$1" != @* ]]
      return
      ;;
    *) return 1 ;;
  esac
}
if [ -n "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND:-}" ] && [ ! -x "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND}" ] && [ -n "$docker_package" ]; then
  run_setup_command npm install -g "$docker_package"
elif [ -n "$docker_package" ] && package_has_explicit_version "$docker_package"; then
  run_setup_command npm install -g "$docker_package"
fi
if [ "$provider" = "codex-cli" ] && [ "${OPENCLAW_LIVE_CLI_BACKEND_AUTH:-auto}" = "api-key" ]; then
  codex_login_command="${OPENCLAW_LIVE_CLI_BACKEND_COMMAND:-$NPM_CONFIG_PREFIX/bin/codex}"
  if [ ! -x "$codex_login_command" ] && [ -x "$NPM_CONFIG_PREFIX/bin/codex" ]; then
    codex_login_command="$NPM_CONFIG_PREFIX/bin/codex"
  fi
  printf '%s\n' "$OPENAI_API_KEY" | "$codex_login_command" login --with-api-key >/dev/null
fi
if [ -n "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND:-}" ] && [ -x "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND}" ]; then
  echo "==> CLI backend binary: ${OPENCLAW_LIVE_CLI_BACKEND_COMMAND}"
  "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND}" -V || "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND}" --version || true
fi
if [ "$provider" = "claude-cli" ]; then
  auth_mode="${OPENCLAW_LIVE_CLI_BACKEND_AUTH:-auto}"
  if [ "$auth_mode" = "subscription" ]; then
    unset ANTHROPIC_API_KEY
    unset ANTHROPIC_API_KEY_OLD
    unset ANTHROPIC_API_TOKEN
    unset ANTHROPIC_AUTH_TOKEN
    unset ANTHROPIC_OAUTH_TOKEN
    node - <<'NODE'
const fs = require("node:fs");
const file = `${process.env.HOME}/.claude/.credentials.json`;
if (fs.existsSync(file)) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const subscriptionType = String(data?.claudeAiOauth?.subscriptionType ?? "").trim();
  if (!subscriptionType || subscriptionType === "unknown") {
    throw new Error("Claude subscription OAuth credentials are missing subscriptionType.");
  }
  console.error(`[claude-subscription] subscriptionType=${subscriptionType}`);
} else if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
  console.error("[claude-subscription] using CLAUDE_CODE_OAUTH_TOKEN from environment");
} else {
  throw new Error("Claude subscription OAuth token or credentials file is required.");
}
NODE
  fi
  real_claude="$NPM_CONFIG_PREFIX/bin/claude-real"
  if [ ! -x "$real_claude" ] && [ -x "$NPM_CONFIG_PREFIX/bin/claude" ]; then
    mv "$NPM_CONFIG_PREFIX/bin/claude" "$real_claude"
  fi
  if [ -x "$real_claude" ]; then
    cat > "$NPM_CONFIG_PREFIX/bin/claude" <<WRAP
#!/usr/bin/env bash
script_dir="\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)"
if [ -n "\${OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY:-}" ]; then
  export ANTHROPIC_API_KEY="\${OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY}"
fi
if [ -n "\${OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD:-}" ]; then
  export ANTHROPIC_API_KEY_OLD="\${OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD}"
fi
exec "\$script_dir/claude-real" "\$@"
WRAP
    chmod +x "$NPM_CONFIG_PREFIX/bin/claude"
  fi
  if [ -z "${OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV:-}" ]; then
    export OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'
  fi
  if [ "$auth_mode" = "subscription" ]; then
    claude --version
    direct_token="OPENCLAW-CLAUDE-SUBSCRIPTION-DIRECT"
    direct_output="$(
      claude \
        -p "Reply exactly: $direct_token" \
        --output-format text \
        --model sonnet \
        --permission-mode bypassPermissions \
        --setting-sources user \
        --strict-mcp-config \
        --mcp-config '{"mcpServers":{}}' \
        --no-session-persistence
    )"
    if [[ "$direct_output" != *"$direct_token"* ]]; then
      echo "ERROR: direct Claude subscription probe did not return expected token." >&2
      echo "$direct_output" >&2
      exit 1
    fi
    echo "[claude-subscription] direct claude -p probe ok"
  else
    claude auth status || true
  fi
fi
tmp_dir="$(mktemp -d)"
trusted_scripts_dir="${OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"
source "$trusted_scripts_dir/lib/live-docker-stage.sh"
openclaw_live_stage_source_tree "$tmp_dir"
# Use a writable node_modules overlay in the temp repo. Vite writes bundled
# config artifacts under the nearest node_modules/.vite-temp path, and the
# build-stage /app/node_modules tree is root-owned in this Docker lane.
openclaw_live_stage_node_modules "$tmp_dir"
openclaw_live_link_runtime_tree "$tmp_dir"
openclaw_live_stage_state_dir "$tmp_dir/.openclaw-state"
openclaw_live_prepare_staged_config
cd "$tmp_dir"
if [ "${OPENCLAW_LIVE_CLI_BACKEND_USE_CI_SAFE_CODEX_CONFIG:-0}" = "1" ]; then
  node --import tsx "$trusted_scripts_dir/prepare-codex-ci-config.ts" "$HOME/.codex/config.toml" "$tmp_dir"
fi
if [ "$provider" = "codex-cli" ] && [ "${OPENCLAW_LIVE_CLI_BACKEND_AUTH:-auto}" = "api-key" ]; then
  codex_probe_model="${OPENCLAW_LIVE_CLI_BACKEND_MODEL#*/}"
  codex_probe_token="OPENCLAW-CODEX-DIRECT-PROBE"
  codex_probe_stdout="$tmp_dir/codex-direct-probe.stdout"
  codex_probe_stderr="$tmp_dir/codex-direct-probe.stderr"
  if ! timeout --foreground --kill-after=10s 180s \
    "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND:-codex}" \
    exec \
    --json \
    --color \
    never \
    --sandbox \
    danger-full-access \
    -c \
    'service_tier="fast"' \
    --skip-git-repo-check \
    --model \
    "$codex_probe_model" \
    "Reply exactly: $codex_probe_token" \
    >"$codex_probe_stdout" 2>"$codex_probe_stderr" </dev/null; then
    echo "ERROR: direct Codex CLI probe failed before OpenClaw gateway smoke." >&2
    sed -n '1,120p' "$codex_probe_stdout" >&2 || true
    sed -n '1,120p' "$codex_probe_stderr" >&2 || true
    exit 1
  fi
  if ! grep -q "$codex_probe_token" "$codex_probe_stdout"; then
    echo "ERROR: direct Codex CLI probe did not return expected token." >&2
    sed -n '1,120p' "$codex_probe_stdout" >&2 || true
    sed -n '1,120p' "$codex_probe_stderr" >&2 || true
    exit 1
  fi
  echo "==> Direct Codex CLI probe ok"
fi
pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
EOF

OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"

echo "==> Run CLI backend live test in Docker"
echo "==> Model: $CLI_MODEL"
echo "==> Provider: $CLI_PROVIDER"
echo "==> Auth mode: $CLI_AUTH_MODE"
echo "==> Setup timeout: ${CLI_SETUP_TIMEOUT_SECONDS}s"
echo "==> Profile file: $PROFILE_STATUS"
if [[ "$CLI_PROVIDER" == "codex-cli" ]]; then
  echo "==> CI-safe Codex config: $CLI_USE_CI_SAFE_CODEX_CONFIG"
fi
if [[ "$CLI_PROVIDER" == "claude-cli" && "$CLI_AUTH_MODE" == "subscription" ]]; then
  echo "==> Claude subscription: $CLAUDE_SUBSCRIPTION_TYPE"
  echo "==> Claude subscription source: $CLAUDE_SUBSCRIPTION_AUTH_SOURCE"
fi
echo "==> External auth dirs: ${AUTH_DIRS_CSV:-none}"
echo "==> External auth files: ${AUTH_FILES_CSV:-none}"
DOCKER_AUTH_ENV=(
  -e OPENCLAW_LIVE_CLI_BACKEND_AUTH="$CLI_AUTH_MODE"
)
if [[ "$CLI_PROVIDER" == "codex-cli" && "$CLI_AUTH_MODE" == "api-key" ]]; then
  docker_env_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-cli-backend-env.XXXXXX")"
  TEMP_DIRS+=("$docker_env_dir")
  docker_env_file="$docker_env_dir/openai.env"
  {
    printf 'OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY}"
    if [[ -n "${OPENAI_BASE_URL:-}" ]]; then
      printf 'OPENAI_BASE_URL=%s\n' "${OPENAI_BASE_URL}"
    fi
  } >"$docker_env_file"
  DOCKER_EXTRA_ENV_FILES+=(--env-file "$docker_env_file")
elif [[ "$CLI_PROVIDER" == "claude-cli" && "$CLI_AUTH_MODE" == "subscription" ]]; then
  DOCKER_AUTH_ENV+=(
    -e CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
    -e OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV="$OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV"
  )
else
  DOCKER_AUTH_ENV+=(
    -e ANTHROPIC_API_KEY
    -e ANTHROPIC_API_KEY_OLD
    -e OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
    -e OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD="${ANTHROPIC_API_KEY_OLD:-}"
    -e OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV="${OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV:-}"
  )
fi

DOCKER_RUN_ARGS=(docker run --rm -t \
  -u "$DOCKER_USER" \
  --entrypoint bash \
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
  -e OPENCLAW_LIVE_CLI_BACKEND_USE_CI_SAFE_CODEX_CONFIG="$CLI_USE_CI_SAFE_CODEX_CONFIG" \
  -e OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS="$CLI_SETUP_TIMEOUT_SECONDS" \
  -e OPENCLAW_DOCKER_CLI_BACKEND_PROVIDER="$CLI_PROVIDER" \
  -e OPENCLAW_DOCKER_CLI_BACKEND_COMMAND_DEFAULT="$CLI_DEFAULT_COMMAND" \
  -e OPENCLAW_DOCKER_CLI_BACKEND_NPM_PACKAGE="$CLI_DOCKER_NPM_PACKAGE" \
  -e OPENCLAW_DOCKER_CLI_BACKEND_BINARY_NAME="$CLI_DOCKER_BINARY_NAME" \
  -e OPENCLAW_LIVE_TEST=1 \
  -e OPENCLAW_LIVE_CLI_BACKEND=1 \
  -e OPENCLAW_LIVE_CLI_BACKEND_DEBUG="${OPENCLAW_LIVE_CLI_BACKEND_DEBUG:-}" \
  -e OPENCLAW_CLI_BACKEND_LOG_OUTPUT="${OPENCLAW_CLI_BACKEND_LOG_OUTPUT:-}" \
  -e OPENCLAW_TEST_CONSOLE="${OPENCLAW_TEST_CONSOLE:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_MODEL="$CLI_MODEL" \
  -e OPENCLAW_LIVE_CLI_BACKEND_COMMAND="${OPENCLAW_LIVE_CLI_BACKEND_COMMAND:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_ARGS="${OPENCLAW_LIVE_CLI_BACKEND_ARGS:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS="${OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV="${OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG="$CLI_DISABLE_MCP_CONFIG" \
  -e OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_MCP_SCHEMA_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_MCP_SCHEMA_PROBE:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="${OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="${OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE:-}")
openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_HOME_MOUNT
openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_EXTRA_ENV_FILES
openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_TRUSTED_HARNESS_MOUNT
DOCKER_RUN_ARGS+=(\
  -v "$CACHE_HOME_DIR":/home/node/.cache \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.openclaw \
  -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace \
  -v "$CLI_TOOLS_DIR":/home/node/.npm-global)
openclaw_live_append_array DOCKER_RUN_ARGS EXTERNAL_AUTH_MOUNTS
openclaw_live_append_array DOCKER_RUN_ARGS DOCKER_AUTH_ENV
openclaw_live_append_array DOCKER_RUN_ARGS PROFILE_MOUNT
DOCKER_RUN_ARGS+=(\
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD")
"${DOCKER_RUN_ARGS[@]}"
