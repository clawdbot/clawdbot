#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-docker-e2e-bare:local")"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz docker-package-install "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
IDENTITY_PATH="${OPENCLAW_DOCKER_ARTIFACT_IDENTITY_PATH:-$ROOT_DIR/.artifacts/docker-tests/docker-package-install-identities.json}"
NPM_PROOF_CONTAINER="openclaw-package-npm-proof-$$"
PNPM_PROOF_CONTAINER="openclaw-package-pnpm-proof-$$"
BUN_PROOF_CONTAINER="openclaw-package-bun-proof-$$"
DOCKER_RUN_TIMEOUT="${OPENCLAW_DOCKER_PACKAGE_INSTALL_RUN_TIMEOUT:-120s}"
BUN_HARNESS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bun-harness.XXXXXX")"

cleanup() {
  docker_e2e_docker_cmd rm -f \
    "$NPM_PROOF_CONTAINER" \
    "$PNPM_PROOF_CONTAINER" \
    "$BUN_PROOF_CONTAINER" >/dev/null 2>&1 || true
  docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
  rm -rf "$BUN_HARNESS_DIR"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" docker-package-install "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" bare

for harness_path in \
  scripts/e2e/bun-global-install-smoke.sh \
  scripts/e2e/lib/bun-global-install/assertions.mjs \
  scripts/lib/docker-e2e-container.sh \
  scripts/lib/docker-e2e-logs.sh \
  scripts/lib/docker-e2e-package.sh \
  scripts/lib/docker-e2e-resource-diagnostics.sh; do
  mkdir -p "$BUN_HARNESS_DIR/$(dirname "$harness_path")"
  cp "$ROOT_DIR/$harness_path" "$BUN_HARNESS_DIR/$harness_path"
done
chmod -R a+rX "$BUN_HARNESS_DIR"

echo "Installing the real OpenClaw package artifact with npm..."
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run -d \
  --name "$NPM_PROOF_CONTAINER" \
  -v "$PACKAGE_TGZ:/tmp/openclaw-current.tgz:ro" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    npm install -g --prefix /tmp/openclaw-proof /tmp/openclaw-current.tgz --no-fund --no-audit
    export PATH="/tmp/openclaw-proof/bin:$PATH"
    package_root=/tmp/openclaw-proof/lib/node_modules/openclaw
    test "$(command -v openclaw)" = "/tmp/openclaw-proof/bin/openclaw"
    openclaw --version > /tmp/openclaw-version
    openclaw --help > /tmp/openclaw-help
    test -s /tmp/openclaw-help
    touch /tmp/openclaw-proof-ready
    exec sleep infinity
  ' >/dev/null

echo "Installing the real OpenClaw package artifact with pnpm..."
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run -d \
  --name "$PNPM_PROOF_CONTAINER" \
  -v "$PACKAGE_TGZ:/tmp/openclaw-current.tgz:ro" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    export PNPM_HOME=/tmp/pnpm-home
    export PATH="$PNPM_HOME:$PATH"
    corepack prepare pnpm@11.22.0 --activate
    pnpm config set global-bin-dir "$PNPM_HOME"
    pnpm config set global-dir /tmp/pnpm-global
    pnpm add --global --allow-build=openclaw /tmp/openclaw-current.tgz
    test "$(command -v openclaw)" = "$PNPM_HOME/openclaw"
    package_root="$(pnpm root --global)/openclaw"
    printf "%s\n" "$package_root" > /tmp/openclaw-package-root
    openclaw --version > /tmp/openclaw-version
    openclaw --help > /tmp/openclaw-help
    test -s /tmp/openclaw-help
    touch /tmp/openclaw-proof-ready
    exec sleep infinity
  ' >/dev/null

echo "Installing the real OpenClaw package artifact with Bun..."
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run -d \
  --name "$BUN_PROOF_CONTAINER" \
  -v "$PACKAGE_TGZ:/tmp/openclaw-current.tgz:ro" \
  -v "$BUN_HARNESS_DIR:/repo:ro" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    npm install -g --prefix /tmp/bun-runtime bun@1.3.14 --no-fund --no-audit
    cd /repo
    BUN_BIN=/tmp/bun-runtime/bin/bun \
      OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD=0 \
      OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ=/tmp/openclaw-current.tgz \
      OPENCLAW_BUN_GLOBAL_SMOKE_PROOF_PATH=/tmp/openclaw-bun-proof.json \
      bash scripts/e2e/bun-global-install-smoke.sh
    touch /tmp/openclaw-proof-ready
    exec sleep infinity
  ' >/dev/null

wait_for_proof() {
  local container_name="$1"
  for _ in $(seq 1 240); do
    if docker exec "$container_name" test -f /tmp/openclaw-proof-ready; then
      return 0
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != "true" ]; then
      docker logs "$container_name" >&2
      return 1
    fi
    sleep 1
  done
  docker logs "$container_name" >&2
  return 1
}

for container_name in "$NPM_PROOF_CONTAINER" "$PNPM_PROOF_CONTAINER" "$BUN_PROOF_CONTAINER"; do
  wait_for_proof "$container_name"
done

NPM_PACKAGE_ROOT="/tmp/openclaw-proof/lib/node_modules/openclaw"
NPM_INSTALLED_VERSION="$(docker exec "$NPM_PROOF_CONTAINER" cat /tmp/openclaw-version | tr -d '\r\n')"
PNPM_PACKAGE_ROOT="$(docker exec "$PNPM_PROOF_CONTAINER" cat /tmp/openclaw-package-root | tr -d '\r\n')"
PNPM_INSTALLED_VERSION="$(docker exec "$PNPM_PROOF_CONTAINER" cat /tmp/openclaw-version | tr -d '\r\n')"
BUN_OPENCLAW_PATH="$(
  docker exec "$BUN_PROOF_CONTAINER" \
    node -p 'JSON.parse(require("node:fs").readFileSync("/tmp/openclaw-bun-proof.json", "utf8")).openclawPath'
)"
BUN_INSTALLED_VERSION="$(
  docker exec "$BUN_PROOF_CONTAINER" \
    node -p 'JSON.parse(require("node:fs").readFileSync("/tmp/openclaw-bun-proof.json", "utf8")).openclawVersion'
)"
PACKAGE_VERSION="$(docker exec "$NPM_PROOF_CONTAINER" node -p "require('$NPM_PACKAGE_ROOT/package.json').version")"
for installed_version in "$NPM_INSTALLED_VERSION" "$PNPM_INSTALLED_VERSION" "$BUN_INSTALLED_VERSION"; do
  if [[ "$installed_version" != *"$PACKAGE_VERSION"* ]]; then
    echo "installed CLI output $installed_version does not contain package version $PACKAGE_VERSION" >&2
    exit 1
  fi
done

node --import tsx "$ROOT_DIR/scripts/e2e/lib/docker-artifact-proof/write-identities.ts" \
  --scenario docker-package-install \
  --output "$IDENTITY_PATH" \
  --image "$IMAGE_NAME" \
  --package "$PACKAGE_TGZ" \
  --container "npm=$NPM_PROOF_CONTAINER" \
  --container "pnpm=$PNPM_PROOF_CONTAINER" \
  --container "bun=$BUN_PROOF_CONTAINER" \
  --detail "npm:installedPackageRoot=$NPM_PACKAGE_ROOT" \
  --detail "npm:installedPackageVersion=$PACKAGE_VERSION" \
  --detail "npm:openclawVersion=$NPM_INSTALLED_VERSION" \
  --detail "npm:openclawPath=/tmp/openclaw-proof/bin/openclaw" \
  --detail "npm:helpCommand=passed" \
  --detail "pnpm:installedPackageRoot=$PNPM_PACKAGE_ROOT" \
  --detail "pnpm:installedPackageVersion=$PACKAGE_VERSION" \
  --detail "pnpm:openclawVersion=$PNPM_INSTALLED_VERSION" \
  --detail "pnpm:openclawPath=/tmp/pnpm-home/openclaw" \
  --detail "pnpm:helpCommand=passed" \
  --detail "bun:installedPackageVersion=$PACKAGE_VERSION" \
  --detail "bun:openclawVersion=$BUN_INSTALLED_VERSION" \
  --detail "bun:openclawPath=$BUN_OPENCLAW_PATH" \
  --detail "bun:helpCommand=passed"

echo "npm, pnpm, and Bun package artifact proofs passed."
