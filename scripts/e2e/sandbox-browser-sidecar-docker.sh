#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

FUNCTIONAL_IMAGE="$(docker_e2e_resolve_image \
  "openclaw-sandbox-browser-sidecar-functional:local" \
  OPENCLAW_SANDBOX_BROWSER_SIDECAR_FUNCTIONAL_IMAGE)"
RUNNER_IMAGE="${OPENCLAW_SANDBOX_BROWSER_SIDECAR_RUNNER_IMAGE:-openclaw-sandbox-browser-sidecar-e2e:${OPENCLAW_DOCKER_ALL_LANE_NAME:-local}}"
SANDBOX_IMAGE="${OPENCLAW_SANDBOX_IMAGE:-openclaw-sandbox:bookworm-slim}"
BROWSER_IMAGE="${OPENCLAW_SANDBOX_BROWSER_IMAGE:-openclaw-sandbox-browser:bookworm-slim}"
RUN_ID="$$-$(date +%s)"
SANDBOX_PREFIX="openclaw-e2e-sbx-${RUN_ID}-"
BROWSER_PREFIX="openclaw-e2e-browser-${RUN_ID}-"
NETWORK_NAME="openclaw-e2e-browser-${RUN_ID}"
SCENARIO_ROOT="$(mktemp -d /tmp/openclaw-sandbox-browser-sidecar.XXXXXX)"
SESSION_KEY="agent:main:sandbox-browser-sidecar"
WORKSPACE_HASH="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 32))' "$SCENARIO_ROOT/workspace")"
SCOPE_KEY="${SESSION_KEY}:workspace:${WORKSPACE_HASH}"
BUILD_DIR="$(mktemp -d /tmp/openclaw-sandbox-browser-sidecar-build.XXXXXX)"
DOCKER_SOCKET="${OPENCLAW_DOCKER_SOCKET:-/var/run/docker.sock}"
SCENARIO_SOURCE="$ROOT_DIR/scripts/e2e/lib/sandbox-browser-sidecar/scenario.mjs"
DOCKER_COMMAND_TIMEOUT="${OPENCLAW_SANDBOX_BROWSER_SIDECAR_DOCKER_TIMEOUT:-1200s}"

docker_socket_gid() {
  if stat -c "%g" "$DOCKER_SOCKET" >/dev/null 2>&1; then
    stat -c "%g" "$DOCKER_SOCKET"
    return
  fi
  stat -f "%g" "$DOCKER_SOCKET"
}

remove_task_containers() {
  local name
  while IFS= read -r name; do
    docker_e2e_docker_cmd rm -f "$name" >/dev/null 2>&1 || true
  done < <(docker_e2e_docker_cmd ps -a --filter "label=openclaw.sessionKey=$SCOPE_KEY" --format '{{.Names}}' 2>/dev/null || true)
}

cleanup() {
  remove_task_containers
  docker_e2e_docker_cmd network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  docker_e2e_docker_cmd run --rm --user 0:0 \
    -v "$SCENARIO_ROOT:/target" \
    "$SANDBOX_IMAGE" \
    sh -c 'rm -rf /target/* /target/.[!.]* /target/..?*' >/dev/null 2>&1 || true
  rm -rf "$SCENARIO_ROOT" "$BUILD_DIR"
}
trap cleanup EXIT

if [ ! -S "$DOCKER_SOCKET" ]; then
  echo "Docker socket not found: $DOCKER_SOCKET" >&2
  exit 1
fi

# The inner sandbox containers bind host paths. Keep this path identical in the
# package runner so the Docker daemon resolves the same task-owned directory.
chmod 0777 "$SCENARIO_ROOT"

docker_e2e_build_or_reuse \
  "$FUNCTIONAL_IMAGE" \
  sandbox-browser-sidecar-functional \
  "$ROOT_DIR/scripts/e2e/Dockerfile" \
  "$ROOT_DIR" \
  functional

docker_build_run sandbox-browser-sidecar-sandbox-build \
  -t "$SANDBOX_IMAGE" \
  -f "$SOURCE_ROOT/scripts/docker/sandbox/Dockerfile" \
  "$SOURCE_ROOT"

docker_build_run sandbox-browser-sidecar-browser-build \
  -t "$BROWSER_IMAGE" \
  -f "$SOURCE_ROOT/scripts/docker/sandbox/Dockerfile.browser" \
  "$SOURCE_ROOT"

cat >"$BUILD_DIR/Dockerfile" <<'EOF'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io \
 && rm -rf /var/lib/apt/lists/*
USER appuser
EOF

docker_build_run sandbox-browser-sidecar-runner-build \
  --build-arg "BASE_IMAGE=$FUNCTIONAL_IMAGE" \
  -t "$RUNNER_IMAGE" \
  -f "$BUILD_DIR/Dockerfile" \
  "$BUILD_DIR"

SOCKET_GID="$(docker_socket_gid)"

echo "Running package-backed sandbox browser sidecar Docker E2E..."
docker_e2e_run_logged_print_with_harness sandbox-browser-sidecar \
  --network host \
  --group-add "$SOCKET_GID" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_E2E_ROOT=$SCENARIO_ROOT" \
  -e "OPENCLAW_E2E_SESSION_KEY=$SESSION_KEY" \
  -e "OPENCLAW_E2E_SANDBOX_IMAGE=$SANDBOX_IMAGE" \
  -e "OPENCLAW_E2E_BROWSER_IMAGE=$BROWSER_IMAGE" \
  -e "OPENCLAW_E2E_SANDBOX_PREFIX=$SANDBOX_PREFIX" \
  -e "OPENCLAW_E2E_BROWSER_PREFIX=$BROWSER_PREFIX" \
  -e "OPENCLAW_E2E_BROWSER_NETWORK=$NETWORK_NAME" \
  -v "$DOCKER_SOCKET:/var/run/docker.sock" \
  -v "$SCENARIO_ROOT:$SCENARIO_ROOT" \
  -v "$SCENARIO_SOURCE:/tmp/openclaw-sandbox-browser-sidecar-scenario.mjs:ro" \
  "$RUNNER_IMAGE" \
  bash -lc \
  'cp /tmp/openclaw-sandbox-browser-sidecar-scenario.mjs /app/sandbox-browser-sidecar-scenario.mjs
   exec node /app/sandbox-browser-sidecar-scenario.mjs'

echo "Sandbox browser sidecar Docker E2E passed."
