#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-docker-e2e-bare:local")"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz docker-package-install "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
IDENTITY_PATH="${OPENCLAW_DOCKER_ARTIFACT_IDENTITY_PATH:-$ROOT_DIR/.artifacts/docker-tests/docker-package-install-identities.json}"
CONTAINER_NAME="openclaw-package-proof-$$"
DOCKER_RUN_TIMEOUT="${OPENCLAW_DOCKER_PACKAGE_INSTALL_RUN_TIMEOUT:-120s}"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" docker-package-install "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" bare

echo "Installing the real OpenClaw package artifact in the target container..."
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run -d \
  --name "$CONTAINER_NAME" \
  -v "$PACKAGE_TGZ:/tmp/openclaw-current.tgz:ro" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    npm install -g --prefix /tmp/openclaw-proof /tmp/openclaw-current.tgz --no-fund --no-audit
    package_root=/tmp/openclaw-proof/lib/node_modules/openclaw
    "$package_root/openclaw.mjs" --version > /tmp/openclaw-version
    "$package_root/openclaw.mjs" --help > /tmp/openclaw-help
    test -s /tmp/openclaw-help
    touch /tmp/openclaw-proof-ready
    exec sleep infinity
  ' >/dev/null

for _ in $(seq 1 240); do
  if docker exec "$CONTAINER_NAME" test -f /tmp/openclaw-proof-ready; then
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME")" != "true" ]; then
    docker logs "$CONTAINER_NAME" >&2
    exit 1
  fi
  sleep 1
done
docker exec "$CONTAINER_NAME" test -f /tmp/openclaw-proof-ready

INSTALLED_VERSION="$(docker exec "$CONTAINER_NAME" cat /tmp/openclaw-version | tr -d '\r\n')"
PACKAGE_ROOT="/tmp/openclaw-proof/lib/node_modules/openclaw"
PACKAGE_VERSION="$(docker exec "$CONTAINER_NAME" node -p "require('$PACKAGE_ROOT/package.json').version")"
if [[ "$INSTALLED_VERSION" != *"$PACKAGE_VERSION"* ]]; then
  echo "installed CLI output $INSTALLED_VERSION does not contain package version $PACKAGE_VERSION" >&2
  exit 1
fi

node --import tsx "$ROOT_DIR/scripts/e2e/lib/docker-artifact-proof/write-identities.ts" \
  --scenario docker-package-install \
  --output "$IDENTITY_PATH" \
  --image "$IMAGE_NAME" \
  --package "$PACKAGE_TGZ" \
  --container "target=$CONTAINER_NAME" \
  --detail "target:installedPackageRoot=$PACKAGE_ROOT" \
  --detail "target:installedPackageVersion=$PACKAGE_VERSION" \
  --detail "target:openclawVersion=$INSTALLED_VERSION" \
  --detail "target:helpCommand=passed"

echo "Package artifact container proof passed."
