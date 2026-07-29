#!/usr/bin/env bash
# Installs OpenClaw from a prepared package tarball, installs @openclaw/codex
# from a registry/git/tarball spec, and verifies a live Codex app-server turn.
set -Eeuo pipefail

SCRIPT_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRUSTED_HARNESS_DIR="${OPENCLAW_LIVE_DOCKER_TRUSTED_HARNESS_DIR:-$SCRIPT_ROOT_DIR}"
CANDIDATE_ROOT="${OPENCLAW_LIVE_DOCKER_REPO_ROOT:-$SCRIPT_ROOT_DIR}"
TRUSTED_HARNESS_DIR="$(cd "$TRUSTED_HARNESS_DIR" && pwd)"
CANDIDATE_ROOT="$(cd "$CANDIDATE_ROOT" && pwd)"
ROOT_DIR="$TRUSTED_HARNESS_DIR"
source "$TRUSTED_HARNESS_DIR/scripts/lib/docker-e2e-image.sh"
source "$TRUSTED_HARNESS_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-codex-npm-plugin-live-e2e" OPENCLAW_CODEX_NPM_PLUGIN_E2E_IMAGE)"
DOCKER_TARGET="${OPENCLAW_CODEX_NPM_PLUGIN_DOCKER_TARGET:-bare}"
HOST_BUILD="${OPENCLAW_CODEX_NPM_PLUGIN_HOST_BUILD:-1}"
PACKAGE_TGZ="${OPENCLAW_CURRENT_PACKAGE_TGZ:-}"
PROFILE_FILE="${OPENCLAW_CODEX_NPM_PLUGIN_PROFILE_FILE:-${OPENCLAW_TESTBOX_PROFILE_FILE:-$HOME/.openclaw-testbox-live.profile}}"
CODEX_PLUGIN_SPEC="${OPENCLAW_CODEX_NPM_PLUGIN_SPEC:-}"
CODEX_PLUGIN_MOUNT=()
CODEX_PLUGIN_PACK_DIR=""
ASSERT_MAX_TEXT_FILE_BYTES="$(
  docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TEXT_FILE_BYTES 1048576
)"
ASSERT_MAX_ERROR_TAIL_BYTES="$(
  docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_ERROR_TAIL_BYTES 65536
)"
ASSERT_MAX_TRANSCRIPT_FILES="$(
  docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_FILES 64
)"
ASSERT_MAX_TRANSCRIPT_WALK_ENTRIES="$(
  docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_WALK_ENTRIES 4096
)"
ASSERT_MAX_TRANSCRIPT_SCAN_BYTES="$(
  docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_SCAN_BYTES 2097152
)"
AGENT_TURN_TIMEOUT_SECONDS="$(
  docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS 420
)"
SESSION_STORE_CONTRACT="${OPENCLAW_CODEX_NPM_PLUGIN_SESSION_STORE_CONTRACT:-}"
if [[ -z "$SESSION_STORE_CONTRACT" ]]; then
  if [[ -f "$CANDIDATE_ROOT/src/config/sessions/session-accessor.sqlite.ts" ]]; then
    SESSION_STORE_CONTRACT="sqlite"
  else
    # Trusted current harnesses also validate frozen targets from before the SQLite cutover.
    SESSION_STORE_CONTRACT="legacy-json"
  fi
fi
BINDING_STORE_CONTRACT="${OPENCLAW_CODEX_NPM_PLUGIN_BINDING_STORE_CONTRACT:-}"
if [[ -z "$BINDING_STORE_CONTRACT" ]]; then
  if [[ -f "$CANDIDATE_ROOT/extensions/codex/src/app-server/session-binding-meta.ts" ]]; then
    BINDING_STORE_CONTRACT="plugin-kv"
  else
    # Frozen targets before the binding-store migration persist a session sidecar.
    BINDING_STORE_CONTRACT="legacy-sidecar"
  fi
fi
run_log=""

cleanup() {
  if [ -n "${CODEX_PLUGIN_PACK_DIR:-}" ]; then
    rm -rf "$CODEX_PLUGIN_PACK_DIR"
  fi
  if [ -n "${PACKAGE_TGZ:-}" ]; then
    docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
  fi
  if [ -n "${run_log:-}" ]; then
    rm -f "$run_log"
  fi
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" codex-npm-plugin-live "$CANDIDATE_ROOT/scripts/e2e/Dockerfile" "$CANDIDATE_ROOT" "$DOCKER_TARGET"

prepare_package_tgz() {
  if [ -n "$PACKAGE_TGZ" ]; then
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz codex-npm-plugin-live "$PACKAGE_TGZ")"
    return 0
  fi
  if [ "$HOST_BUILD" = "0" ] && [ -z "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ]; then
    echo "OPENCLAW_CODEX_NPM_PLUGIN_HOST_BUILD=0 requires OPENCLAW_CURRENT_PACKAGE_TGZ" >&2
    exit 1
  fi
  local harness_root="$ROOT_DIR"
  ROOT_DIR="$CANDIDATE_ROOT"
  PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz codex-npm-plugin-live)"
  ROOT_DIR="$harness_root"
}

prepare_package_tgz

prepare_codex_plugin_spec() {
  local source_path
  local container_path
  local pack_output

  if [ -z "$CODEX_PLUGIN_SPEC" ]; then
    CODEX_PLUGIN_PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-codex-plugin-pack.XXXXXX")"
    (
      cd "$CANDIDATE_ROOT"
      node scripts/lib/plugin-npm-runtime-build.mjs extensions/codex
      node scripts/lib/plugin-npm-package-manifest.mjs --run extensions/codex -- \
        npm pack --json --ignore-scripts --pack-destination "$CODEX_PLUGIN_PACK_DIR"
    ) >/tmp/openclaw-codex-plugin-pack.log 2>&1
    pack_output=()
    while IFS= read -r packed_file; do
      pack_output+=("$packed_file")
    done < <(find "$CODEX_PLUGIN_PACK_DIR" -maxdepth 1 -type f -name '*.tgz' | sort)
    if [ "${#pack_output[@]}" -ne 1 ]; then
      echo "Expected one packed Codex plugin tarball; found ${#pack_output[@]}." >&2
      docker_e2e_print_log /tmp/openclaw-codex-plugin-pack.log >&2
      exit 1
    fi
    source_path="${pack_output[0]}"
    container_path="/tmp/$(basename "$source_path")"
    CODEX_PLUGIN_MOUNT=(-v "$source_path":"$container_path":ro)
    CODEX_PLUGIN_SPEC="npm-pack:$container_path"
    return 0
  fi

  if [[ "$CODEX_PLUGIN_SPEC" == npm-pack:* ]]; then
    source_path="${CODEX_PLUGIN_SPEC#npm-pack:}"
    if [[ "$source_path" != /* ]]; then
      source_path="$CANDIDATE_ROOT/$source_path"
    fi
    if [ ! -f "$source_path" ]; then
      echo "Codex plugin npm-pack tarball not found: $source_path" >&2
      exit 1
    fi
    container_path="/tmp/$(basename "$source_path")"
    CODEX_PLUGIN_MOUNT=(-v "$source_path":"$container_path":ro)
    CODEX_PLUGIN_SPEC="npm-pack:$container_path"
  fi
}

prepare_codex_plugin_spec

PROFILE_MOUNT=()
PROFILE_STATUS="none"
if [ -f "$PROFILE_FILE" ] && [ -r "$PROFILE_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  set +a
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/appuser/.profile:ro)
  PROFILE_STATUS="$PROFILE_FILE"
fi
AGENT_TURN_TIMEOUT_SECONDS="$(
  docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS"
)"
COMMAND_TIMEOUT="${OPENCLAW_E2E_COMMAND_TIMEOUT:-$((10#$AGENT_TURN_TIMEOUT_SECONDS + 60))s}"

docker_e2e_package_mount_args "$PACKAGE_TGZ"
run_log="$(docker_e2e_run_log codex-npm-plugin-live)"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 codex-npm-plugin-live empty)"

echo "Running Codex npm plugin live Docker E2E..."
echo "Profile file: $PROFILE_STATUS"
echo "Codex plugin spec: $CODEX_PLUGIN_SPEC"
if ! docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_CODEX_NPM_PLUGIN_ALLOW_BETA_COMPAT_DIAGNOSTICS="${OPENCLAW_CODEX_NPM_PLUGIN_ALLOW_BETA_COMPAT_DIAGNOSTICS:-0}" \
  -e OPENCLAW_CODEX_NPM_PLUGIN_FORCE_UNSAFE_INSTALL="${OPENCLAW_CODEX_NPM_PLUGIN_FORCE_UNSAFE_INSTALL:-1}" \
  -e OPENCLAW_CODEX_NPM_PLUGIN_MODEL="${OPENCLAW_CODEX_NPM_PLUGIN_MODEL:-openai/gpt-5.4}" \
  -e OPENCLAW_CODEX_NPM_PLUGIN_SPEC="$CODEX_PLUGIN_SPEC" \
  -e OPENCLAW_CODEX_NPM_PLUGIN_BINDING_STORE_CONTRACT="$BINDING_STORE_CONTRACT" \
  -e OPENCLAW_CODEX_NPM_PLUGIN_SESSION_STORE_CONTRACT="$SESSION_STORE_CONTRACT" \
  -e "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TEXT_FILE_BYTES=$ASSERT_MAX_TEXT_FILE_BYTES" \
  -e "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_ERROR_TAIL_BYTES=$ASSERT_MAX_ERROR_TAIL_BYTES" \
  -e "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_FILES=$ASSERT_MAX_TRANSCRIPT_FILES" \
  -e "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_WALK_ENTRIES=$ASSERT_MAX_TRANSCRIPT_WALK_ENTRIES" \
  -e "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_SCAN_BYTES=$ASSERT_MAX_TRANSCRIPT_SCAN_BYTES" \
  -e "OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS=$AGENT_TURN_TIMEOUT_SECONDS" \
  -e "OPENCLAW_E2E_COMMAND_TIMEOUT=$COMMAND_TIMEOUT" \
  -e OPENAI_API_KEY \
  -e OPENAI_BASE_URL \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "${CODEX_PLUGIN_MOUNT[@]}" \
  "${PROFILE_MOUNT[@]}" \
  -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'; then
set -Eeuo pipefail

source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$XDG_CACHE_HOME/npm}"
export npm_config_cache="$NPM_CONFIG_CACHE"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_AGENT_HARNESS_FALLBACK=none

for profile_path in "$HOME/.profile" /home/appuser/.profile; do
  if [ -f "$profile_path" ] && [ -r "$profile_path" ]; then
    set +e +u
    source "$profile_path"
    set -Eeuo pipefail
    break
  fi
done
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: OPENAI_API_KEY was not available after sourcing ~/.profile." >&2
  exit 1
fi
export OPENAI_API_KEY
if [ -n "${OPENAI_BASE_URL:-}" ]; then
  export OPENAI_BASE_URL
fi

CODEX_PLUGIN_SPEC="${OPENCLAW_CODEX_NPM_PLUGIN_SPEC:?missing OPENCLAW_CODEX_NPM_PLUGIN_SPEC}"
MODEL_REF="${OPENCLAW_CODEX_NPM_PLUGIN_MODEL:?missing OPENCLAW_CODEX_NPM_PLUGIN_MODEL}"
POST_UNINSTALL_MODEL_REF="$MODEL_REF"
SESSION_ID="codex-npm-plugin-live"
SUCCESS_MARKER="OPENCLAW-CODEX-NPM-PLUGIN-LIVE-OK"
AGENT_TURN_TIMEOUT_SECONDS="${OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS:-420}"
PLUGIN_INSTALL_FLAGS=(--force)
if [ "${OPENCLAW_CODEX_NPM_PLUGIN_FORCE_UNSAFE_INSTALL:-0}" = "1" ]; then
  PLUGIN_INSTALL_FLAGS+=(--dangerously-force-unsafe-install)
fi

dump_debug_logs() {
  local status="$1"
  echo "Codex npm plugin live scenario failed with exit code $status" >&2
  openclaw_e2e_dump_logs \
    /tmp/openclaw-install.log \
    /tmp/openclaw-codex-plugin-install.log \
    /tmp/openclaw-codex-plugin-enable.log \
    /tmp/openclaw-codex-plugins-list.json \
    /tmp/openclaw-codex-plugin-inspect.json \
    /tmp/openclaw-codex-preflight.log \
    /tmp/openclaw-codex-agent.json \
    /tmp/openclaw-codex-agent.err \
    /tmp/openclaw-codex-agent-turn1.json \
    /tmp/openclaw-codex-agent-turn1.err \
    /tmp/openclaw-codex-agent-turn2.json \
    /tmp/openclaw-codex-agent-turn2.err \
    /tmp/openclaw-codex-followthrough.json \
    /tmp/openclaw-codex-followthrough.log \
    /tmp/openclaw-codex-followthrough.err \
    /tmp/openclaw-codex-plugin-uninstall.log \
    /tmp/openclaw-codex-plugins-list-after-uninstall.json \
    /tmp/openclaw-codex-agent-after-uninstall.json \
    /tmp/openclaw-codex-agent-after-uninstall.err
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

mkdir -p "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$NPM_CONFIG_CACHE" || true

openclaw_e2e_install_package /tmp/openclaw-install.log
command -v openclaw >/dev/null
openclaw_e2e_enable_openclaw_cli_timeout

echo "Installing Codex plugin: $CODEX_PLUGIN_SPEC"
openclaw plugins install "$CODEX_PLUGIN_SPEC" "${PLUGIN_INSTALL_FLAGS[@]}" >/tmp/openclaw-codex-plugin-install.log 2>&1

node scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs configure "$MODEL_REF"

echo "Enabling Codex plugin..."
openclaw plugins enable codex >/tmp/openclaw-codex-plugin-enable.log 2>&1

openclaw plugins list --json >/tmp/openclaw-codex-plugins-list.json
openclaw plugins inspect codex --runtime --json >/tmp/openclaw-codex-plugin-inspect.json
node scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs assert-plugin "$CODEX_PLUGIN_SPEC"
node scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs assert-npm-deps

CODEX_BIN="$(node scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs print-codex-bin)"
printf '%s\n' "$OPENAI_API_KEY" | "$CODEX_BIN" login --with-api-key >/dev/null

print_agent_reply() {
  node -e '
const fs = require("node:fs");
const file = process.argv[1];
const marker = process.argv[2];
const label = process.argv[3];
const response = JSON.parse(fs.readFileSync(file, "utf8"));
const text = (response.payloads || [])
  .map((payload) => (payload && typeof payload.text === "string" ? payload.text : ""))
  .filter(Boolean)
  .join("\n")
  .trim();
console.log(`${label}: ${text}`);
if (!text.includes(marker)) {
  console.error(`missing marker ${marker} in ${file}`);
  process.exit(1);
}
' "$1" "$2" "$3"
}

run_agent_turn() {
  local label="$1"
  local marker="$2"
  local message="$3"
  local out="$4"
  local err="$5"
  local status

  echo "${label}_prompt: $message"
  if openclaw agent --local \
    --agent main \
    --session-id "$SESSION_ID" \
    --model "$MODEL_REF" \
    --message "$message" \
    --thinking low \
    --timeout "$AGENT_TURN_TIMEOUT_SECONDS" \
    --json >"$out" 2>"$err" </dev/null; then
    status=0
  else
    status=$?
  fi
  echo "${label}_agent_status: $status stdout_bytes=$(wc -c <"$out" 2>/dev/null || printf 0) stderr_bytes=$(wc -c <"$err" 2>/dev/null || printf 0)"
  if [ "$status" -ne 0 ]; then
    dump_debug_logs "$status"
    exit "$status"
  fi
  if ! print_agent_reply "$out" "$marker" "${label}_reply"; then
    dump_debug_logs 1
    exit 1
  fi
}

echo "TRANSCRIPT_BEGIN"
echo "Running Codex CLI preflight via managed npm dependency..."
echo "codex_cli_prompt: Reply exactly: ${SUCCESS_MARKER}-PREFLIGHT"
"$CODEX_BIN" exec \
  --json \
  --color never \
  --skip-git-repo-check \
  "Reply exactly: ${SUCCESS_MARKER}-PREFLIGHT" >/tmp/openclaw-codex-preflight.log 2>&1 </dev/null
node scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs assert-preflight "${SUCCESS_MARKER}-PREFLIGHT"
echo "codex_cli_reply: ${SUCCESS_MARKER}-PREFLIGHT"

echo "Running OpenClaw local agent turns through npm-installed Codex plugin..."
run_agent_turn \
  "turn1" \
  "${SUCCESS_MARKER}-TURN-1" \
  "Reply in one short sentence. Include token ${SUCCESS_MARKER}-TURN-1 and say hello from the OpenClaw Codex plugin." \
  /tmp/openclaw-codex-agent-turn1.json \
  /tmp/openclaw-codex-agent-turn1.err
run_agent_turn \
  "turn2" \
  "${SUCCESS_MARKER}-TURN-2" \
  "Using this same conversation, name the exact token from your previous reply, then include token ${SUCCESS_MARKER}-TURN-2." \
  /tmp/openclaw-codex-agent-turn2.json \
  /tmp/openclaw-codex-agent-turn2.err
run_agent_turn \
  "turn3" \
  "$SUCCESS_MARKER" \
  "Answer 7 plus 8, include token $SUCCESS_MARKER, and mention whether you saw ${SUCCESS_MARKER}-TURN-2 earlier." \
  /tmp/openclaw-codex-agent.json \
  /tmp/openclaw-codex-agent.err

node scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs assert-agent-turn "$SUCCESS_MARKER" "$SESSION_ID" "$MODEL_REF"

FOLLOWTHROUGH_SESSION_ID="${SESSION_ID}-followthrough"
FOLLOWTHROUGH_PROGRESS_MARKER="${SUCCESS_MARKER}-FOLLOWTHROUGH-PROGRESS"
FOLLOWTHROUGH_COMPLETE_MARKER="${SUCCESS_MARKER}-FOLLOWTHROUGH-COMPLETE"
FOLLOWTHROUGH_WORKSPACE="${OPENCLAW_STATE_DIR:?missing OPENCLAW_STATE_DIR}/workspace"
FOLLOWTHROUGH_ARTIFACT="$FOLLOWTHROUGH_WORKSPACE/codex-progress-followthrough.txt"
FOLLOWTHROUGH_SUFFIX="$(node -e 'process.stdout.write(crypto.randomUUID().replaceAll("-", "").slice(0, 12))')"
mkdir -p "$FOLLOWTHROUGH_WORKSPACE"
printf 'qa_alpha=amber-%s\n' "$FOLLOWTHROUGH_SUFFIX" >"$FOLLOWTHROUGH_WORKSPACE/FOLLOWTHROUGH_ALPHA.md"
printf 'qa_beta=violet-%s\n' "$FOLLOWTHROUGH_SUFFIX" >"$FOLLOWTHROUGH_WORKSPACE/FOLLOWTHROUGH_BETA.md"
printf 'qa_gamma=silver-%s\n' "$FOLLOWTHROUGH_SUFFIX" >"$FOLLOWTHROUGH_WORKSPACE/FOLLOWTHROUGH_GAMMA.md"
rm -f "$FOLLOWTHROUGH_ARTIFACT"

FOLLOWTHROUGH_PROMPT="$(cat <<PROMPT
Live release follow-through check.

First call message(action=send) without passing final and send exactly
$FOLLOWTHROUGH_PROGRESS_MARKER to this conversation. The final field must be
omitted, not false. Make this progress send your only tool call in this step,
and wait for its result before calling any other tool.

Only after that send succeeds, read FOLLOWTHROUGH_ALPHA.md,
FOLLOWTHROUGH_BETA.md, and FOLLOWTHROUGH_GAMMA.md from the workspace. Write
their three complete file lines byte-for-byte, including each key= prefix, to
./codex-progress-followthrough.txt in alpha, beta, gamma order. Write exactly
one newline after each line, including the final line.

Only after the artifact write succeeds, call message(action=send) with
final=true and send exactly $FOLLOWTHROUGH_COMPLETE_MARKER. Do not expose the
hidden values in either visible message.
PROMPT
)"

echo "Running Codex progress follow-through regression turn..."
OPENCLAW_PACKAGE_ROOT="$(openclaw_e2e_package_root "$NPM_CONFIG_PREFIX")"
if node scripts/e2e/lib/codex-npm-plugin-live/followthrough-turn.mjs \
  "$OPENCLAW_PACKAGE_ROOT" \
  "$FOLLOWTHROUGH_SESSION_ID" \
  "$MODEL_REF" \
  "$AGENT_TURN_TIMEOUT_SECONDS" \
  /tmp/openclaw-codex-followthrough.json \
  "$FOLLOWTHROUGH_PROMPT" \
  >/tmp/openclaw-codex-followthrough.log \
  2>/tmp/openclaw-codex-followthrough.err </dev/null; then
  followthrough_status=0
else
  followthrough_status=$?
fi
echo "followthrough_agent_status: $followthrough_status stdout_bytes=$(wc -c </tmp/openclaw-codex-followthrough.json 2>/dev/null || printf 0) stderr_bytes=$(wc -c </tmp/openclaw-codex-followthrough.err 2>/dev/null || printf 0)"
if [ "$followthrough_status" -ne 0 ]; then
  dump_debug_logs "$followthrough_status"
  exit "$followthrough_status"
fi
node scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs \
  assert-followthrough \
  "$FOLLOWTHROUGH_PROGRESS_MARKER" \
  "$FOLLOWTHROUGH_COMPLETE_MARKER" \
  "$FOLLOWTHROUGH_SESSION_ID" \
  "$MODEL_REF" \
  "$FOLLOWTHROUGH_ARTIFACT" \
  "$FOLLOWTHROUGH_WORKSPACE/FOLLOWTHROUGH_ALPHA.md" \
  "$FOLLOWTHROUGH_WORKSPACE/FOLLOWTHROUGH_BETA.md" \
  "$FOLLOWTHROUGH_WORKSPACE/FOLLOWTHROUGH_GAMMA.md"
echo "followthrough_reply: ${FOLLOWTHROUGH_PROGRESS_MARKER} -> ${FOLLOWTHROUGH_COMPLETE_MARKER}"
echo "TRANSCRIPT_END"

echo "Uninstalling Codex plugin and verifying the configured harness now fails..."
openclaw plugins uninstall codex --force >/tmp/openclaw-codex-plugin-uninstall.log 2>&1
openclaw plugins list --json >/tmp/openclaw-codex-plugins-list-after-uninstall.json
node scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs assert-uninstalled

if openclaw agent --local \
  --agent main \
  --session-id "${SESSION_ID}-after-uninstall" \
  --model "$POST_UNINSTALL_MODEL_REF" \
  --message "Reply exactly: ${SUCCESS_MARKER}-AFTER-UNINSTALL" \
  --thinking low \
  --timeout 120 \
  --json >/tmp/openclaw-codex-agent-after-uninstall.json 2>/tmp/openclaw-codex-agent-after-uninstall.err; then
  post_uninstall_status=0
else
  post_uninstall_status=$?
fi
node scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs assert-agent-error "$post_uninstall_status"

echo "Codex npm plugin live Docker E2E passed"
EOF
  docker_e2e_print_log "$run_log"
  exit 1
fi

awk '/TRANSCRIPT_BEGIN/{printing=1} printing{print} /TRANSCRIPT_END/{printing=0}' "$run_log"
echo "Codex npm plugin live Docker E2E passed"
