#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-npm-telegram-rtt-e2e" OPENCLAW_NPM_TELEGRAM_RTT_E2E_IMAGE)"
DOCKER_TARGET="${OPENCLAW_NPM_TELEGRAM_DOCKER_TARGET:-build}"
PACKAGE_SPEC="${OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC:-openclaw@beta}"
PACKAGE_TGZ="${OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ:-${OPENCLAW_CURRENT_PACKAGE_TGZ:-}}"
PACKAGE_LABEL="${OPENCLAW_NPM_TELEGRAM_PACKAGE_LABEL:-}"
OUTPUT_DIR="${OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR:-.artifacts/qa-e2e/npm-telegram-rtt}"

validate_openclaw_package_spec() {
  local spec="$1"
  if [[ "$spec" =~ ^openclaw@(main|alpha|beta|latest|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*|-(alpha|beta)\.[1-9][0-9]*)?)$ ]]; then
    return 0
  fi
  echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC must be openclaw@main, openclaw@alpha, openclaw@beta, openclaw@latest, or an exact OpenClaw release version; got: $spec" >&2
  exit 1
}

resolve_package_tgz() {
  local candidate="$1"
  if [ -z "$candidate" ]; then
    return 0
  fi
  if [ ! -f "$candidate" ]; then
    echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ must point to an existing .tgz file; got: $candidate" >&2
    exit 1
  fi
  case "$candidate" in
    *.tgz) ;;
    *)
      echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ must point to a .tgz file; got: $candidate" >&2
      exit 1
      ;;
  esac
  local dir
  local base
  dir="$(cd "$(dirname "$candidate")" && pwd)"
  base="$(basename "$candidate")"
  printf "%s/%s" "$dir" "$base"
}

package_mount_args=()
package_install_source="$PACKAGE_SPEC"
resolved_package_tgz="$(resolve_package_tgz "$PACKAGE_TGZ")"
if [ -n "$resolved_package_tgz" ]; then
  package_install_source="/package-under-test/$(basename "$resolved_package_tgz")"
  package_mount_args=(-v "$resolved_package_tgz:$package_install_source:ro")
else
  validate_openclaw_package_spec "$PACKAGE_SPEC"
fi
if [ -z "$PACKAGE_LABEL" ]; then
  if [ -n "$resolved_package_tgz" ]; then
    PACKAGE_LABEL="$(basename "$resolved_package_tgz")"
  else
    PACKAGE_LABEL="$PACKAGE_SPEC"
  fi
fi

for key in \
  OPENCLAW_QA_TELEGRAM_GROUP_ID \
  OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN \
  OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN; do
  if [ -z "${!key:-}" ]; then
    echo "Missing required env: $key" >&2
    exit 1
  fi
done

docker_e2e_build_or_reuse "$IMAGE_NAME" npm-telegram-rtt "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"

mkdir -p "$ROOT_DIR/.artifacts/qa-e2e"
run_log="$(mktemp "${TMPDIR:-/tmp}/openclaw-npm-telegram-rtt.XXXXXX")"
npm_prefix_host="$(mktemp -d "$ROOT_DIR/.artifacts/qa-e2e/npm-telegram-rtt-prefix.XXXXXX")"
trap 'rm -f "$run_log"; rm -rf "$npm_prefix_host"' EXIT

docker_env=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE="$package_install_source"
  -e OPENCLAW_NPM_TELEGRAM_PACKAGE_LABEL="$PACKAGE_LABEL"
  -e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR"
  -e OPENCLAW_QA_TELEGRAM_GROUP_ID
  -e OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN
  -e OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN
  -e OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS="${OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS:-180000}"
  -e OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS="${OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS:-180000}"
  -e OPENCLAW_NPM_TELEGRAM_SCENARIOS="${OPENCLAW_NPM_TELEGRAM_SCENARIOS:-telegram-mentioned-message-reply}"
  -e OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE="${OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE:-mock-openai}"
  -e OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES="${OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES:-20}"
  -e OPENCLAW_NPM_TELEGRAM_SAMPLE_TIMEOUT_MS="${OPENCLAW_NPM_TELEGRAM_SAMPLE_TIMEOUT_MS:-30000}"
  -e OPENCLAW_NPM_TELEGRAM_MAX_FAILURES="${OPENCLAW_NPM_TELEGRAM_MAX_FAILURES:-${OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES:-20}}"
)

run_logged() {
  if ! "$@" >"$run_log" 2>&1; then
    cat "$run_log"
    exit 1
  fi
  cat "$run_log"
  >"$run_log"
}

echo "Running package Telegram RTT Docker E2E ($PACKAGE_LABEL)..."
run_logged docker run --rm \
  "${docker_env[@]}" \
  ${package_mount_args[@]+"${package_mount_args[@]}"} \
  -v "$ROOT_DIR/scripts:/app/scripts:ro" \
  -v "$ROOT_DIR/.artifacts:/app/.artifacts" \
  -v "$npm_prefix_host:/npm-global" \
  -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-npm-telegram-rtt.XXXXXX")"
export NPM_CONFIG_PREFIX="/npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-rtt"
export GATEWAY_AUTH_TOKEN_REF="openclaw-rtt"
export TELEGRAM_BOT_TOKEN="$OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN"
export OPENCLAW_DISABLE_BONJOUR="1"

install_source="${OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE:?missing OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE}"
package_label="${OPENCLAW_NPM_TELEGRAM_PACKAGE_LABEL:-$install_source}"
mock_port="${OPENCLAW_NPM_TELEGRAM_MOCK_PORT:-44080}"
config_path="$HOME/.openclaw/openclaw.json"
gateway_log="/tmp/openclaw-npm-telegram-rtt-gateway.log"
mock_log="/tmp/openclaw-npm-telegram-rtt-mock.log"
export MOCK_PORT="$mock_port"

dump_logs() {
  local status="$1"
  if [ "$status" -eq 0 ]; then
    return
  fi
  echo "package Telegram RTT failed with exit code $status" >&2
  for file in \
    "$mock_log" \
    "$gateway_log"; do
    if [ -f "$file" ]; then
      echo "--- $file ---" >&2
      sed -n '1,260p' "$file" >&2 || true
    fi
  done
}
trap 'status=$?; kill ${gateway_pid:-} ${mock_pid:-} 2>/dev/null || true; dump_logs "$status"; exit "$status"' EXIT

echo "Installing ${package_label} from ${install_source}..."
npm install -g "$install_source" --no-fund --no-audit
command -v openclaw
openclaw --version
installed_version="$(node -p "require('/npm-global/lib/node_modules/openclaw/package.json').version")"

node /app/scripts/e2e/mock-openai-server.mjs >"$mock_log" 2>&1 &
mock_pid="$!"
for _ in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:${mock_port}/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 1
done

mkdir -p "$(dirname "$config_path")" "$HOME/.openclaw/workspace" "$HOME/.openclaw/agents/main/sessions" "$HOME/workspace"

node /app/scripts/e2e/npm-telegram-rtt-config.mjs \
  "$config_path" \
  "$mock_port" \
  "$OPENCLAW_QA_TELEGRAM_GROUP_ID" \
  "$OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN" \
  "$OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN" \
  "$installed_version"

openclaw gateway run --verbose >"$gateway_log" 2>&1 &
gateway_pid="$!"
for _ in $(seq 1 120); do
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    echo "gateway exited before readiness" >&2
    exit 1
  fi
  if bash -c ":</dev/tcp/127.0.0.1/18789" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! bash -c ":</dev/tcp/127.0.0.1/18789" >/dev/null 2>&1; then
  echo "gateway did not open port 18789" >&2
  exit 1
fi

node /app/scripts/e2e/npm-telegram-rtt-driver.mjs
EOF

echo "package Telegram RTT Docker E2E passed ($PACKAGE_LABEL)"
