#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-build.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
IMAGE_NAME="${OPENCLAW_INSTALL_E2E_IMAGE:-openclaw-install-e2e:local}"
INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_INSTALL_E2E_DOCKER_TIMEOUT:-2700s}}"
PROFILE_FILE="${OPENCLAW_INSTALL_E2E_PROFILE_FILE:-${OPENCLAW_PROFILE_FILE:-${OPENCLAW_TESTBOX_PROFILE_FILE:-$HOME/.openclaw-testbox-live.profile}}}"

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_API_TOKEN="${ANTHROPIC_API_TOKEN:-}"
OPENCLAW_E2E_MODELS="${OPENCLAW_E2E_MODELS:-}"

if [ ! -f "$PROFILE_FILE" ] && [ -f "$HOME/.profile" ]; then
  PROFILE_FILE="$HOME/.profile"
fi

PROFILE_STATUS="none"

read_profile_env_value() {
  local key="$1"
  (
    set +u
    # shellcheck disable=SC1090
    source "$PROFILE_FILE" >/dev/null
    printf '%s' "${!key:-}"
  )
}

for key in OPENAI_API_KEY ANTHROPIC_API_KEY ANTHROPIC_API_TOKEN; do
  if [ -f "$PROFILE_FILE" ] && [ -r "$PROFILE_FILE" ] && [ -z "${!key:-}" ]; then
    printf -v "$key" '%s' "$(read_profile_env_value "$key")"
    PROFILE_STATUS="$PROFILE_FILE"
  fi
  if [[ "${!key:-}" == "undefined" || "${!key:-}" == "null" ]]; then
    printf -v "$key" '%s' ""
  fi
  export "$key"
done

echo "==> Build image: $IMAGE_NAME"
docker_build_run install-e2e-build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/install-sh-e2e/Dockerfile" \
  "$ROOT_DIR/scripts/docker"

echo "==> Run E2E installer test"
echo "Profile file: $PROFILE_STATUS"
docker_e2e_docker_run_cmd run --rm \
  -e OPENCLAW_INSTALL_URL="$INSTALL_URL" \
  -e OPENCLAW_INSTALL_TAG="${OPENCLAW_INSTALL_TAG:-latest}" \
  -e OPENCLAW_E2E_MODELS="$OPENCLAW_E2E_MODELS" \
  -e OPENCLAW_INSTALL_E2E_OPENAI_MODEL="${OPENCLAW_INSTALL_E2E_OPENAI_MODEL:-}" \
  -e OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS="${OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS:-}" \
  -e OPENCLAW_INSTALL_E2E_PREVIOUS="${OPENCLAW_INSTALL_E2E_PREVIOUS:-}" \
  -e OPENCLAW_INSTALL_E2E_SKIP_PREVIOUS="${OPENCLAW_INSTALL_E2E_SKIP_PREVIOUS:-0}" \
  -e OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS="${OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS:-300}" \
  -e OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL="${OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL:-1}" \
  -e OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE="${OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE:-1}" \
  -e OPENCLAW_NO_ONBOARD=1 \
  -e OPENAI_API_KEY \
  -e ANTHROPIC_API_KEY \
  -e ANTHROPIC_API_TOKEN \
  "$IMAGE_NAME"
