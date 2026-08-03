#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-docker-e2e-functional:local")"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz compose-setup "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
IDENTITY_PATH="${OPENCLAW_DOCKER_ARTIFACT_IDENTITY_PATH:-$ROOT_DIR/.artifacts/docker-tests/compose-setup-identities.json}"
PROJECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-compose-proof.XXXXXX")"
PROJECT_NAME="openclaw-compose-proof-$$"
CLI_NAME="$PROJECT_NAME-cli-proof"
TOKEN="compose-proof-$$-$(date +%s)"
COMPOSE=(docker compose --project-name "$PROJECT_NAME" --project-directory "$PROJECT_DIR" -f "$ROOT_DIR/docker-compose.yml")

cleanup() {
  docker_e2e_docker_cmd rm -f "$CLI_NAME" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down --remove-orphans --volumes >/dev/null 2>&1 || true
  docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
  rm -rf "$PROJECT_DIR"
}
trap cleanup EXIT

mkdir -p "$PROJECT_DIR/config/workspace" "$PROJECT_DIR/auth-profile"
chmod -R 0777 "$PROJECT_DIR/config" "$PROJECT_DIR/auth-profile"
cat >"$PROJECT_DIR/config/openclaw.json" <<EOF
{
  "gateway": {
    "mode": "local",
    "auth": { "mode": "token", "token": "$TOKEN" },
    "controlUi": { "enabled": false }
  }
}
EOF

export OPENCLAW_IMAGE="$IMAGE_NAME"
export OPENCLAW_CONFIG_DIR="$PROJECT_DIR/config"
export OPENCLAW_WORKSPACE_DIR="$PROJECT_DIR/config/workspace"
export OPENCLAW_AUTH_PROFILE_SECRET_DIR="$PROJECT_DIR/auth-profile"
export OPENCLAW_GATEWAY_TOKEN="$TOKEN"
export OPENCLAW_GATEWAY_PORT=0
export OPENCLAW_BRIDGE_PORT=0
export OPENCLAW_MSTEAMS_PORT=0
export OPENCLAW_DISABLE_BONJOUR=1
export OPENCLAW_CURRENT_PACKAGE_TGZ="$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" compose-setup "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" functional

echo "Launching documented Docker Compose gateway topology..."
"${COMPOSE[@]}" up -d --no-build openclaw-gateway
GATEWAY_ID="$("${COMPOSE[@]}" ps -q openclaw-gateway)"
if [ -z "$GATEWAY_ID" ]; then
  echo "Compose did not create openclaw-gateway" >&2
  exit 1
fi

for _ in $(seq 1 180); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$GATEWAY_ID")"
  if [ "$health" = "healthy" ]; then
    break
  fi
  if [ "$health" = "unhealthy" ] || [ "$health" = "exited" ] || [ "$health" = "dead" ]; then
    "${COMPOSE[@]}" logs --no-color openclaw-gateway >&2
    exit 1
  fi
  sleep 1
done
if [ "$(docker inspect --format '{{.State.Health.Status}}' "$GATEWAY_ID")" != "healthy" ]; then
  "${COMPOSE[@]}" logs --no-color openclaw-gateway >&2
  echo "Compose gateway did not become healthy" >&2
  exit 1
fi

"${COMPOSE[@]}" exec -T openclaw-gateway node dist/index.js health --token "$TOKEN"
"${COMPOSE[@]}" run -T --no-deps --name "$CLI_NAME" openclaw-cli health --token "$TOKEN"
GATEWAY_VERSION="$("${COMPOSE[@]}" exec -T openclaw-gateway node -p "require('./package.json').version")"

node --import tsx "$ROOT_DIR/scripts/e2e/lib/docker-artifact-proof/write-identities.ts" \
  --scenario compose-setup \
  --output "$IDENTITY_PATH" \
  --image "$IMAGE_NAME" \
  --package "$PACKAGE_TGZ" \
  --container "gateway=$GATEWAY_ID" \
  --container "cli=$CLI_NAME" \
  --detail "gateway:openclawVersion=$GATEWAY_VERSION" \
  --detail "gateway:health=healthy" \
  --detail "cli:healthCommand=passed"

echo "Docker Compose setup proof passed."
