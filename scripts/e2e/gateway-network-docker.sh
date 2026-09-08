#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/frozen-target-compat.sh"
SOURCE_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}"
FROZEN_CONTEXT=0
openclaw_prepare_frozen_target_context "$SOURCE_ROOT" && FROZEN_CONTEXT=1 || {
  context_status=$?
  [ "$context_status" -eq 1 ] || exit "$context_status"
}
LEGACY_GATEWAY_CLIENT=""
if [[ "$FROZEN_CONTEXT" == "1" ]] &&
  openclaw_frozen_target_source_has_path "$SOURCE_ROOT" scripts/e2e/lib/gateway-network/client.mjs &&
  ! openclaw_frozen_target_source_has_path "$SOURCE_ROOT" scripts/e2e/lib/gateway-network/client.mts; then
  LEGACY_GATEWAY_CLIENT="$SOURCE_ROOT/scripts/e2e/lib/gateway-network/client.mjs"
fi
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-gateway-network-e2e" OPENCLAW_GATEWAY_NETWORK_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_GATEWAY_NETWORK_E2E_SKIP_BUILD:-0}"

PORT="18789"
TOKEN="e2e-$(date +%s)-$$"
NET_NAME="openclaw-net-e2e-$$"
GW_NAME="openclaw-gateway-e2e-$$"
SUSPENSION_STATE_PATH="/tmp/gateway-network-suspension.json"
CAPABILITIES_DIR=""
CAPABILITIES_PATH=""
CAPABILITIES_CONTAINER_PATH="/tmp/gateway-network-output/capabilities.json"
CAPABILITIES_HOST_USER="$(id -u)"
CAPABILITIES_HOST_GROUP="$(id -g)"
DOCKER_COMMAND_TIMEOUT="${OPENCLAW_GATEWAY_NETWORK_DOCKER_COMMAND_TIMEOUT:-600s}"
CLIENT_TIMEOUT="${OPENCLAW_GATEWAY_NETWORK_CLIENT_TIMEOUT:-90s}"
CLIENT_LIMIT_ENV_ARGS=()
if [[ -n "${OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS+x}" ]]; then
  CLIENT_CONNECT_TIMEOUT_MS="$(
    docker_e2e_read_positive_int_env OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS 80000
  )"
  CLIENT_LIMIT_ENV_ARGS+=(
    -e "OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS=$CLIENT_CONNECT_TIMEOUT_MS"
  )
elif [[ -n "${OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS+x}" ]]; then
  CONNECT_READY_TIMEOUT_MS="$(
    docker_e2e_read_positive_int_env OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS 80000
  )"
  CLIENT_LIMIT_ENV_ARGS+=(
    -e "OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS=$CONNECT_READY_TIMEOUT_MS"
  )
fi

cleanup() {
  docker_e2e_docker_cmd rm -f "$GW_NAME" >/dev/null 2>&1 || true
  docker_e2e_docker_cmd network rm "$NET_NAME" >/dev/null 2>&1 || true
  [[ -z "$CAPABILITIES_PATH" ]] || rm -f "$CAPABILITIES_PATH" >/dev/null 2>&1 || true
  [[ -z "$CAPABILITIES_DIR" ]] || rmdir "$CAPABILITIES_DIR" >/dev/null 2>&1 || true
}

run_suspension_phase() {
  local stage="$1"
  DOCKER_COMMAND_TIMEOUT="$CLIENT_TIMEOUT" run_logged_print "gateway-network-suspension-$stage" \
    docker_e2e_docker_cmd exec \
    "${CLIENT_LIMIT_ENV_ARGS[@]}" \
    -e "GW_URL=ws://127.0.0.1:$PORT" \
    -e "GW_TOKEN=$TOKEN" \
    -e "GW_MODE=suspension-$stage-restart" \
    -e "GW_STATE_PATH=$SUSPENSION_STATE_PATH" \
    "$GW_NAME" \
    node scripts/e2e/lib/gateway-network/client.mts
}

trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" gateway-network "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"

echo "Creating Docker network..."
docker_e2e_docker_cmd network create "$NET_NAME" >/dev/null

echo "Starting gateway container..."
docker_e2e_harness_mount_args
gateway_setup='node "$entry" config set gateway.controlUi.enabled false >/dev/null'
if [[ -z "$LEGACY_GATEWAY_CLIENT" ]]; then
  gateway_setup+='; if [[ ! -f /tmp/gateway-network-configured ]]; then node "$entry" plugins enable admin-http-rpc >/dev/null; touch /tmp/gateway-network-configured; fi'
fi
docker_e2e_docker_cmd run -d \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  --name "$GW_NAME" \
  --network "$NET_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail; source scripts/lib/openclaw-e2e-instance.sh; entry=\"\$(openclaw_e2e_resolve_entrypoint)\"; $gateway_setup; openclaw_e2e_exec_gateway \"\$entry\" $PORT lan /tmp/gateway-net-e2e.log" >/dev/null

echo "Waiting for gateway to come up..."
if ! docker_e2e_wait_container_bash "$GW_NAME" 180 0.5 "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_tcp 127.0.0.1 $PORT"; then
  echo "Gateway failed to start"
  docker_e2e_tail_container_file_if_running "$GW_NAME" /tmp/gateway-net-e2e.log 120
  exit 1
fi

echo "Running client container (connect + health)..."
if [[ -n "$LEGACY_GATEWAY_CLIENT" ]]; then
  DOCKER_COMMAND_TIMEOUT="$CLIENT_TIMEOUT" run_logged gateway-network-client docker_e2e_docker_run_cmd run --rm \
    "${DOCKER_E2E_HARNESS_ARGS[@]}" \
    --network "$NET_NAME" \
    "${CLIENT_LIMIT_ENV_ARGS[@]}" \
    -v "$LEGACY_GATEWAY_CLIENT:/tmp/openclaw-gateway-network-client.mjs:ro" \
    -e "GW_URL=ws://$GW_NAME:$PORT" \
    -e "GW_TOKEN=$TOKEN" \
    "$IMAGE_NAME" \
    node /tmp/openclaw-gateway-network-client.mjs
  echo "OK"
  exit 0
fi
CAPABILITIES_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-gateway-network-capabilities.XXXXXX")"
CAPABILITIES_PATH="$CAPABILITIES_DIR/capabilities.json"
if [[ ! -O "$CAPABILITIES_DIR" ]]; then
  echo "Gateway network capability output directory is not owned by the host user." >&2
  exit 1
fi
DOCKER_COMMAND_TIMEOUT="$CLIENT_TIMEOUT" run_logged gateway-network-client docker_e2e_docker_run_cmd run --rm \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  --user "$CAPABILITIES_HOST_USER:$CAPABILITIES_HOST_GROUP" \
  --network "$NET_NAME" \
  "${CLIENT_LIMIT_ENV_ARGS[@]}" \
  -v "$CAPABILITIES_DIR:/tmp/gateway-network-output" \
  -e "GW_URL=ws://$GW_NAME:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  -e "GW_CAPABILITIES_PATH=$CAPABILITIES_CONTAINER_PATH" \
  "$IMAGE_NAME" \
  node scripts/e2e/lib/gateway-network/client.mts

SUSPENSION_CAPABILITY="$(
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !["supported", "unsupported"].includes(value.suspension)
    ) {
      throw new Error("invalid gateway network capability output");
    }
    process.stdout.write(value.suspension);
  ' "$CAPABILITIES_PATH"
)"
if [[ ! -O "$CAPABILITIES_PATH" ]]; then
  echo "Gateway network capability output is not owned by the host user." >&2
  exit 1
fi
rm "$CAPABILITIES_PATH"
rmdir "$CAPABILITIES_DIR"
CAPABILITIES_PATH=""
CAPABILITIES_DIR=""
if [[ "$SUSPENSION_CAPABILITY" == "unsupported" ]]; then
  authorization_status=0
  if openclaw_frozen_target_omissions_authorized; then
    echo "Target gateway does not advertise cooperative suspension; authorized frozen-target omission."
    echo "OK"
    exit 0
  else
    authorization_status=$?
  fi
  if ((authorization_status == 2)); then
    exit "$authorization_status"
  fi
  echo "Target gateway does not advertise cooperative suspension and frozen-target omissions are not authorized." >&2
  exit 1
fi

phase_started="$SECONDS"
echo "Running cooperative suspension lifecycle before container stop..."
run_suspension_phase pre
echo "Pre-restart suspension lifecycle passed ($((SECONDS - phase_started))s)"

phase_started="$SECONDS"
container_id="$(docker_e2e_docker_cmd inspect --format '{{.Id}}' "$GW_NAME")"
echo "Stopping and restarting the prepared gateway container..."
docker_e2e_docker_cmd stop "$GW_NAME" >/dev/null
docker_e2e_docker_cmd start "$GW_NAME" >/dev/null
restarted_container_id="$(docker_e2e_docker_cmd inspect --format '{{.Id}}' "$GW_NAME")"
if [[ "$restarted_container_id" != "$container_id" ]]; then
  echo "Gateway container identity changed across stop/start" >&2
  exit 1
fi
if ! docker_e2e_wait_container_bash "$GW_NAME" 180 0.5 "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz ok 400"; then
  echo "Gateway failed to restart"
  docker_e2e_tail_container_file_if_running "$GW_NAME" /tmp/gateway-net-e2e.log 120
  exit 1
fi
restart_duration_ms="$(((SECONDS - phase_started) * 1000))"
printf '{"event":"gateway-network-phase","phase":"container-restart","durationMs":%d,"ok":true}\n' "$restart_duration_ms"
echo "Prepared gateway container restarted with the same identity ($((restart_duration_ms / 1000))s)"

phase_started="$SECONDS"
echo "Proving suspension state resets only with the gateway process..."
run_suspension_phase post
echo "Post-restart suspension lifecycle passed ($((SECONDS - phase_started))s)"

echo "OK"
