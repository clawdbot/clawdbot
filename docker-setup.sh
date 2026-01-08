#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
IMAGE_NAME="${CLAWDBOT_IMAGE:-clawdbot:local}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose not available (try: docker compose version)" >&2
  exit 1
fi

mkdir -p "${CLAWDBOT_CONFIG_DIR:-$HOME/.clawdbot}"
mkdir -p "${CLAWDBOT_WORKSPACE_DIR:-$HOME/clawd}"

export CLAWDBOT_CONFIG_DIR="${CLAWDBOT_CONFIG_DIR:-$HOME/.clawdbot}"
export CLAWDBOT_WORKSPACE_DIR="${CLAWDBOT_WORKSPACE_DIR:-$HOME/clawd}"
export CLAWDBOT_GATEWAY_PORT="${CLAWDBOT_GATEWAY_PORT:-18789}"
export CLAWDBOT_BRIDGE_PORT="${CLAWDBOT_BRIDGE_PORT:-18790}"
export CLAWDBOT_GATEWAY_BIND="${CLAWDBOT_GATEWAY_BIND:-lan}"
export CLAWDBOT_IMAGE="$IMAGE_NAME"

if [[ -z "${CLAWDBOT_GATEWAY_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    CLAWDBOT_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    CLAWDBOT_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
fi
export CLAWDBOT_GATEWAY_TOKEN

ENV_FILE="$ROOT_DIR/.env"
upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  tmp="$(mktemp)"
  declare -A seen=()

  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      local key="${line%%=*}"
      local replaced=false
      for k in "${keys[@]}"; do
        if [[ "$key" == "$k" ]]; then
          printf '%s=%s\n' "$k" "${!k}" >>"$tmp"
          seen["$k"]=1
          replaced=true
          break
        fi
      done
      if [[ "$replaced" == false ]]; then
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi

  for k in "${keys[@]}"; do
    if [[ -z "${seen[$k]:-}" ]]; then
      printf '%s=%s\n' "$k" "${!k}" >>"$tmp"
    fi
  done

  mv "$tmp" "$file"
}

upsert_env "$ENV_FILE" \
  CLAWDBOT_CONFIG_DIR \
  CLAWDBOT_WORKSPACE_DIR \
  CLAWDBOT_GATEWAY_PORT \
  CLAWDBOT_BRIDGE_PORT \
  CLAWDBOT_GATEWAY_BIND \
  CLAWDBOT_GATEWAY_TOKEN \
  CLAWDBOT_IMAGE

echo "==> Building Docker image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo ""
echo "==> Onboarding (interactive)"
echo "When prompted:"
echo "  - Gateway bind: lan"
echo "  - Gateway auth: token"
echo "  - Gateway token: $CLAWDBOT_GATEWAY_TOKEN"
echo "  - Tailscale exposure: Off"
echo "  - Install Gateway daemon: No"
echo ""
docker compose -f "$COMPOSE_FILE" run --rm clawdbot-cli onboard

echo ""
echo "==> Provider setup (optional)"
echo "WhatsApp (QR):"
echo "  docker compose -f $COMPOSE_FILE run --rm clawdbot-cli providers login"
echo "Telegram (bot token):"
echo "  docker compose -f $COMPOSE_FILE run --rm clawdbot-cli providers add --provider telegram --token <token>"
echo "Discord (bot token):"
echo "  docker compose -f $COMPOSE_FILE run --rm clawdbot-cli providers add --provider discord --token <token>"
echo "Docs: https://docs.clawd.bot/providers"

echo ""
echo "==> Starting gateway"
docker compose -f "$COMPOSE_FILE" up -d clawdbot-gateway

echo ""
echo "Gateway running with host port mapping."
echo "Access from tailnet devices via the host's tailnet IP."
echo "Config: $CLAWDBOT_CONFIG_DIR"
echo "Workspace: $CLAWDBOT_WORKSPACE_DIR"
echo "Token: $CLAWDBOT_GATEWAY_TOKEN"
echo ""
echo "Commands:"
echo "  docker compose -f $COMPOSE_FILE logs -f clawdbot-gateway"
echo "  docker compose -f $COMPOSE_FILE exec clawdbot-gateway node dist/index.js health --token \"$CLAWDBOT_GATEWAY_TOKEN\""
