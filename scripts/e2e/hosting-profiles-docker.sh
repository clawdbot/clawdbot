#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-hosting-profiles-e2e" OPENCLAW_HOSTING_PROFILES_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_HOSTING_PROFILES_E2E_SKIP_BUILD:-0}"
PORT="18789"
TOKEN="hosting-profiles-$(date +%s)-$$"
CONTAINER_NAMES=()

cleanup() {
  if [ "${#CONTAINER_NAMES[@]}" -gt 0 ]; then
    docker_e2e_docker_cmd rm -f "${CONTAINER_NAMES[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  hosting-profiles \
  "$ROOT_DIR/scripts/e2e/Dockerfile" \
  "$ROOT_DIR" \
  "" \
  "$SKIP_BUILD"

run_scenario() {
  local scenario="$1" profile="$2" bind="$3" expected_status="$4"
  local container_name="openclaw-hosting-profiles-${scenario}-$$"
  local auth_args=(-e "OPENCLAW_GATEWAY_TOKEN=$TOKEN")
  local profile_args=()
  local runtime_args=(--tmpfs "/tmp/hosting-profile-workspace:rw,size=8m")
  local gateway_setup=""
  CONTAINER_NAMES+=("$container_name")
  if [ -n "$profile" ]; then
    profile_args=(-e "OPENCLAW_HOSTING_PROFILE=$profile")
  fi
  if [ "$scenario" = "reverse-proxy-ready" ]; then
    auth_args=()
    gateway_setup='node "$entry" config set --batch-json '\''[{"path":"gateway.auth.mode","value":"trusted-proxy"},{"path":"gateway.auth.trustedProxy.userHeader","value":"x-forwarded-user"},{"path":"gateway.trustedProxies","value":["127.0.0.1"]}]'\'' >/dev/null;'
  elif [ "$scenario" = "node-not-ready" ]; then
    gateway_setup='node "$entry" config set gateway.nodes.pairing.autoApproveCidrs '\''["127.0.0.1"]'\'' --strict-json >/dev/null;'
  elif [ "$scenario" = "workspace-ready" ]; then
    runtime_args=(--tmpfs "/tmp/hosting-profile-workspace:rw,size=1m")
    gateway_setup='node "$entry" config set agents.defaults.workspace /tmp/hosting-profile-workspace >/dev/null;'
  fi

  docker_e2e_harness_mount_args
  docker_e2e_docker_cmd run -d \
    "${DOCKER_E2E_HARNESS_ARGS[@]}" \
    --name "$container_name" \
    "${auth_args[@]}" \
    "${profile_args[@]}" \
    "${runtime_args[@]}" \
    -e "OPENCLAW_WORKSPACE_DIR=/tmp/hosting-profile-workspace" \
    -e "OPENCLAW_SKIP_CHANNELS=1" \
    -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
    -e "OPENCLAW_SKIP_CRON=1" \
    -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
    "$IMAGE_NAME" \
    bash -lc "set -euo pipefail; source scripts/lib/openclaw-e2e-instance.sh; entry=\"\$(openclaw_e2e_resolve_entrypoint)\"; node \"\$entry\" config set gateway.controlUi.enabled false >/dev/null; $gateway_setup openclaw_e2e_exec_gateway \"\$entry\" $PORT $bind /tmp/hosting-profiles.log" \
    >/dev/null

  if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
    "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz $expected_status 1000"; then
    docker_e2e_tail_container_file_if_running "$container_name" /tmp/hosting-profiles.log 120
    exit 1
  fi

  docker_e2e_docker_cmd exec "$container_name" \
    node scripts/e2e/hosting-profiles-client.mjs "$scenario" "http://127.0.0.1:$PORT/readyz"

  if [ "$scenario" = "node-not-ready" ]; then
    docker_e2e_docker_cmd exec -d "$container_name" bash -lc \
      'set -euo pipefail; source scripts/lib/openclaw-e2e-instance.sh; entry="$(openclaw_e2e_resolve_entrypoint)"; exec node "$entry" node run --host 127.0.0.1 --port 18789 --node-id hosting-profile-node --display-name "Hosting Profile Node" >/tmp/hosting-profiles-node.log 2>&1'
    if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
      "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz 200 1000"; then
      docker_e2e_tail_container_file_if_running "$container_name" /tmp/hosting-profiles.log 120
      docker_e2e_tail_container_file_if_running "$container_name" /tmp/hosting-profiles-node.log 120
      exit 1
    fi
    docker_e2e_docker_cmd exec "$container_name" \
      node scripts/e2e/hosting-profiles-client.mjs node-ready "http://127.0.0.1:$PORT/readyz"
  elif [ "$scenario" = "workspace-ready" ]; then
    docker_e2e_docker_cmd exec "$container_name" bash -lc \
      'set +e; dd if=/dev/zero of=/tmp/hosting-profile-workspace/fill bs=64K status=none; code=$?; sync; test "$code" -ne 0'
    if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
      "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz 503 1000"; then
      docker_e2e_tail_container_file_if_running "$container_name" /tmp/hosting-profiles.log 120
      exit 1
    fi
    docker_e2e_docker_cmd exec "$container_name" \
      node scripts/e2e/hosting-profiles-client.mjs workspace-full "http://127.0.0.1:$PORT/readyz"
    docker_e2e_docker_cmd exec "$container_name" rm -f /tmp/hosting-profile-workspace/fill
    if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
      "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz 200 1000"; then
      docker_e2e_tail_container_file_if_running "$container_name" /tmp/hosting-profiles.log 120
      exit 1
    fi
    docker_e2e_docker_cmd exec "$container_name" \
      node scripts/e2e/hosting-profiles-client.mjs workspace-recovered "http://127.0.0.1:$PORT/readyz"
  fi
}

run_scenario local "" loopback 200
run_scenario container-ready container lan 200
run_scenario container-loopback container loopback 503
run_scenario reverse-proxy-ready reverse-proxy loopback 200
run_scenario reverse-proxy-auth-missing reverse-proxy loopback 503
run_scenario node-not-ready node-mode loopback 503
run_scenario workspace-ready "" loopback 200

echo "Hosting profiles Docker E2E passed"
