#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-npm-telegram-live-e2e" OPENCLAW_NPM_TELEGRAM_LIVE_E2E_IMAGE)"
DOCKER_TARGET="${OPENCLAW_NPM_TELEGRAM_DOCKER_TARGET:-build}"
PACKAGE_SPEC="${OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC:-openclaw@beta}"
OUTPUT_DIR="${OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR:-.artifacts/qa-e2e/npm-telegram-live}"

resolve_credential_source() {
  if [ -n "${OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE:-}" ]; then
    printf "%s" "$OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE"
    return 0
  fi
  if [ -n "${OPENCLAW_QA_CREDENTIAL_SOURCE:-}" ]; then
    printf "%s" "$OPENCLAW_QA_CREDENTIAL_SOURCE"
    return 0
  fi
  if [ -n "${CI:-}" ] && [ -n "${OPENCLAW_QA_CONVEX_SITE_URL:-}" ]; then
    if [ -n "${OPENCLAW_QA_CONVEX_SECRET_CI:-}" ] || [ -n "${OPENCLAW_QA_CONVEX_SECRET_MAINTAINER:-}" ]; then
      printf "convex"
    fi
  fi
}

resolve_credential_role() {
  if [ -n "${OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE:-}" ]; then
    printf "%s" "$OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE"
    return 0
  fi
  if [ -n "${OPENCLAW_QA_CREDENTIAL_ROLE:-}" ]; then
    printf "%s" "$OPENCLAW_QA_CREDENTIAL_ROLE"
  fi
}

validate_openclaw_package_spec() {
  local spec="$1"
  if [[ "$spec" =~ ^openclaw@(beta|latest|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*|-beta\.[1-9][0-9]*)?)$ ]]; then
    return 0
  fi
  echo "OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC must be openclaw@beta, openclaw@latest, or an exact OpenClaw release version; got: $spec" >&2
  exit 1
}

validate_openclaw_package_spec "$PACKAGE_SPEC"

docker_e2e_build_or_reuse "$IMAGE_NAME" npm-telegram-live "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"

mkdir -p "$ROOT_DIR/.artifacts/qa-e2e"
run_log="$(mktemp "${TMPDIR:-/tmp}/openclaw-npm-telegram-live.XXXXXX")"
npm_prefix_host="$(mktemp -d "$ROOT_DIR/.artifacts/qa-e2e/npm-telegram-live-prefix.XXXXXX")"
trap 'rm -f "$run_log"; rm -rf "$npm_prefix_host"' EXIT
credential_source="$(resolve_credential_source)"
credential_role="$(resolve_credential_role)"
if [ -z "$credential_role" ] && [ -n "${CI:-}" ] && [ "$credential_source" = "convex" ]; then
  credential_role="ci"
fi

docker_env=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC="$PACKAGE_SPEC"
  -e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR"
  -e OPENCLAW_NPM_TELEGRAM_FAST="${OPENCLAW_NPM_TELEGRAM_FAST:-1}"
)

forward_env_if_set() {
  local key="$1"
  if [ -n "${!key:-}" ]; then
    docker_env+=(-e "$key")
  fi
}

if [ -n "$credential_source" ]; then
  docker_env+=(-e OPENCLAW_QA_CREDENTIAL_SOURCE="$credential_source")
fi
if [ -n "$credential_role" ]; then
  docker_env+=(-e OPENCLAW_QA_CREDENTIAL_ROLE="$credential_role")
fi

for key in \
  OPENAI_API_KEY \
  ANTHROPIC_API_KEY \
  GEMINI_API_KEY \
  GOOGLE_API_KEY \
  OPENCLAW_LIVE_OPENAI_KEY \
  OPENCLAW_LIVE_ANTHROPIC_KEY \
  OPENCLAW_LIVE_GEMINI_KEY \
  OPENCLAW_QA_TELEGRAM_GROUP_ID \
  OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN \
  OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN \
  OPENCLAW_QA_CONVEX_SITE_URL \
  OPENCLAW_QA_CONVEX_SECRET_CI \
  OPENCLAW_QA_CONVEX_SECRET_MAINTAINER \
  OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS \
  OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS \
  OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS \
  OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS \
  OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX \
  OPENCLAW_QA_CREDENTIAL_OWNER_ID \
  OPENCLAW_QA_ALLOW_INSECURE_HTTP \
  OPENCLAW_QA_REDACT_PUBLIC_METADATA \
  OPENCLAW_QA_TELEGRAM_CAPTURE_CONTENT \
  OPENCLAW_QA_SUITE_PROGRESS \
  OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE \
  OPENCLAW_NPM_TELEGRAM_MODEL \
  OPENCLAW_NPM_TELEGRAM_ALT_MODEL \
  OPENCLAW_NPM_TELEGRAM_SCENARIOS \
  OPENCLAW_NPM_TELEGRAM_SUT_ACCOUNT \
  OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES; do
  forward_env_if_set "$key"
done

run_logged() {
  if ! "$@" >"$run_log" 2>&1; then
    cat "$run_log"
    exit 1
  fi
  cat "$run_log"
  >"$run_log"
}

echo "Running published npm Telegram live Docker E2E ($PACKAGE_SPEC)..."
run_logged docker run --rm \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC="$PACKAGE_SPEC" \
  -v "$npm_prefix_host:/npm-global" \
  -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-npm-telegram-install.XXXXXX")"
export NPM_CONFIG_PREFIX="/npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

package_spec="${OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC:?missing OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC}"
echo "Installing ${package_spec}..."
npm install -g "$package_spec" --no-fund --no-audit

command -v openclaw
openclaw --version
EOF

run_logged docker run --rm \
  "${docker_env[@]}" \
  -v "$ROOT_DIR/.artifacts:/app/.artifacts" \
  -v "$npm_prefix_host:/npm-global" \
  -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-npm-telegram-runtime.XXXXXX")"
export NPM_CONFIG_PREFIX="/npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NPM_TELEGRAM_REPO_ROOT="/app"

dump_hotpath_logs() {
  local status="$1"
  echo "installed npm onboarding recovery hot path failed with exit code $status" >&2
  for file in \
    /tmp/openclaw-npm-telegram-onboard.json \
    /tmp/openclaw-npm-telegram-channel-add.log \
    /tmp/openclaw-npm-telegram-doctor-fix.log \
    /tmp/openclaw-npm-telegram-doctor-check.log; do
    if [ -f "$file" ]; then
      echo "--- $file ---" >&2
      sed -n '1,220p' "$file" >&2 || true
    fi
  done
}
trap 'status=$?; dump_hotpath_logs "$status"; exit "$status"' ERR

command -v openclaw
openclaw --version

echo "Running installed npm onboarding recovery hot path..."
OPENAI_API_KEY="${OPENAI_API_KEY:-sk-openclaw-npm-telegram-hotpath}" openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --skip-daemon \
  --skip-ui \
  --skip-skills \
  --skip-health \
  --json >/tmp/openclaw-npm-telegram-onboard.json </dev/null

openclaw channels add --channel telegram --token "123456:openclaw-npm-telegram-hotpath" >/tmp/openclaw-npm-telegram-channel-add.log 2>&1 </dev/null
openclaw doctor --fix --non-interactive >/tmp/openclaw-npm-telegram-doctor-fix.log 2>&1 </dev/null
openclaw doctor --non-interactive >/tmp/openclaw-npm-telegram-doctor-check.log 2>&1 </dev/null
if grep -F -q "Bundled plugin runtime deps are missing." /tmp/openclaw-npm-telegram-doctor-check.log; then
  exit 1
fi
if grep -F -q "Failed to install bundled plugin runtime deps" /tmp/openclaw-npm-telegram-doctor-fix.log; then
  exit 1
fi

export OPENCLAW_NPM_TELEGRAM_SUT_COMMAND="$(command -v openclaw)"
trap - ERR
node --import tsx scripts/e2e/npm-telegram-live-runner.ts
EOF

echo "published npm Telegram live Docker E2E passed ($PACKAGE_SPEC)"
