#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-hosting-profiles-e2e" OPENCLAW_HOSTING_PROFILES_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_HOSTING_PROFILES_E2E_SKIP_BUILD:-0}"
PORT="18789"
TOKEN="hosting-profiles-$(date +%s)-$$"
ARTIFACT_DIR="${OPENCLAW_HOSTING_PROFILES_E2E_ARTIFACT_DIR:-${OPENCLAW_DOCKER_ALL_LOG_DIR:-$ROOT_DIR/.artifacts/docker-tests/hosting-profiles}}"
ARTIFACT_PATH="$ARTIFACT_DIR/hosting-profile-conformance.json"
CONFORMANCE_WRITER="$ROOT_DIR/scripts/e2e/hosting-profiles-conformance.mjs"
IMAGE_ID=""
IMAGE_PACKAGE_SHA256=""
PACKAGE_VERSION=""
PACKAGE_SHA256=""
CONTAINER_NAMES=()

cleanup() {
  if [ "${#CONTAINER_NAMES[@]}" -gt 0 ]; then
    docker_e2e_docker_cmd rm -f "${CONTAINER_NAMES[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

dump_scenario_log() {
  local container_name="$1" file_path="$2"
  local copied_log
  copied_log="$(mktemp)"
  docker_e2e_docker_cmd logs "$container_name" 2>&1 || true
  if docker_e2e_docker_cmd cp "$container_name:$file_path" "$copied_log" >/dev/null 2>&1; then
    tail -n 120 "$copied_log" || true
  fi
  rm -f "$copied_log"
}

dump_readiness_response() {
  local container_name="$1"
  docker_e2e_docker_cmd exec "$container_name" node -e \
    "fetch('http://127.0.0.1:$PORT/readyz').then(async (response) => console.log(response.status, await response.text()))" \
    2>&1 || true
}

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  hosting-profiles \
  "$ROOT_DIR/scripts/e2e/Dockerfile" \
  "$ROOT_DIR" \
  "" \
  "$SKIP_BUILD"

mkdir -p "$ARTIFACT_DIR"
PACKAGE_VERSION="$(docker_e2e_docker_cmd run --rm "$IMAGE_NAME" node -p "require('./package.json').version")"
IMAGE_ID="$(docker_e2e_docker_cmd image inspect --format '{{.Id}}' "$IMAGE_NAME")"
IMAGE_PACKAGE_SHA256="$(docker_e2e_docker_cmd image inspect --format '{{ index .Config.Labels "org.opencontainers.image.openclaw.package.sha256" }}' "$IMAGE_NAME")"
if [ "$IMAGE_PACKAGE_SHA256" = "<no value>" ]; then
  IMAGE_PACKAGE_SHA256=""
fi
if [ -n "$IMAGE_PACKAGE_SHA256" ] && [[ ! "$IMAGE_PACKAGE_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Docker image has an invalid OpenClaw package SHA-256 label: $IMAGE_PACKAGE_SHA256" >&2
  exit 1
fi
if [ -n "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ] && [ -f "$OPENCLAW_CURRENT_PACKAGE_TGZ" ]; then
  PACKAGE_SHA256="$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));' "$OPENCLAW_CURRENT_PACKAGE_TGZ")"
  if [ "$IMAGE_PACKAGE_SHA256" != "$PACKAGE_SHA256" ]; then
    echo "Docker image package SHA-256 does not match OPENCLAW_CURRENT_PACKAGE_TGZ" >&2
    exit 1
  fi
elif [ -n "$IMAGE_PACKAGE_SHA256" ]; then
  PACKAGE_SHA256="$IMAGE_PACKAGE_SHA256"
fi
node "$CONFORMANCE_WRITER" init \
  "$ARTIFACT_PATH" "$PACKAGE_VERSION" "$IMAGE_NAME" "$IMAGE_ID" "$PACKAGE_SHA256"

record_profile_validation() {
  local container_name="$1" scenario="$2" profile="$3" expected_conformant="$4" expected_ready="$5"
  local validation="" command_status=0
  set +e
  validation="$(
    docker_e2e_docker_cmd exec "$container_name" bash -lc '
      set -euo pipefail
      source scripts/lib/openclaw-e2e-instance.sh
      entry="$(openclaw_e2e_resolve_entrypoint)"
      profile="$1"
      args=()
      if [ -n "$profile" ]; then
        args+=("$profile")
      fi
      node "$entry" hosting profiles validate "${args[@]}" --json --timeout 5000
    ' bash "$profile"
  )"
  command_status=$?
  set -e
  printf '%s\n' "$validation"
  printf '%s\n' "$validation" | node "$CONFORMANCE_WRITER" record \
    "$ARTIFACT_PATH" \
    "$scenario" \
    "${profile:--}" \
    "$expected_conformant" \
    "$expected_ready" \
    "$command_status"
}

record_initial_profile_validation() {
  local container_name="$1" scenario="$2" profile="$3"
  case "$scenario" in
    unprofiled) record_profile_validation "$container_name" unprofiled "" false true ;;
    local) record_profile_validation "$container_name" local local true true ;;
    container-ready) record_profile_validation "$container_name" container-ready container true true ;;
    container-loopback) record_profile_validation "$container_name" container-loopback container true false ;;
    reverse-proxy-ready) record_profile_validation "$container_name" reverse-proxy-ready reverse-proxy true true ;;
    reverse-proxy-auth-missing) record_profile_validation "$container_name" reverse-proxy-auth-missing reverse-proxy true false ;;
    node-not-ready) record_profile_validation "$container_name" node-not-ready node-mode true false ;;
    workspace-ready) record_profile_validation "$container_name" workspace-ready local true true ;;
  esac
}

run_scenario() {
  local scenario="$1" profile="$2" bind="$3" expected_status="$4"
  local container_name="openclaw-hosting-profiles-${scenario}-$$"
  local auth_args=(-e "OPENCLAW_GATEWAY_TOKEN=$TOKEN")
  local profile_args=()
  local runtime_args=(--tmpfs "/tmp/hosting-profile-workspace:rw,uid=1001,gid=1001,mode=0700,size=8m")
  local gateway_setup=""
  echo "==> Hosting profile scenario: $scenario"
  CONTAINER_NAMES+=("$container_name")
  if [ -n "$profile" ]; then
    profile_args=(-e "OPENCLAW_HOSTING_PROFILE=$profile")
  fi
  if [ "$scenario" = "reverse-proxy-ready" ]; then
    # Trusted-proxy remains the ingress mode. The local-direct password fallback is the
    # supported management path for CLI RPCs that do not traverse the identity proxy.
    auth_args=(-e "OPENCLAW_GATEWAY_PASSWORD=$TOKEN")
    gateway_setup='node "$entry" config set --batch-json '\''[{"path":"gateway.auth.mode","value":"trusted-proxy"},{"path":"gateway.auth.trustedProxy.userHeader","value":"x-forwarded-user"},{"path":"gateway.auth.trustedProxy.allowLoopback","value":true},{"path":"gateway.trustedProxies","value":["127.0.0.1"]}]'\'' >/dev/null;'
  elif [ "$scenario" = "node-not-ready" ]; then
    # Trusted-CIDR approval admits the device connection but deliberately leaves its command
    # surface pending, unlike silent same-host or SSH-verified approval.
    gateway_setup='node "$entry" config set gateway.nodes.pairing.autoApproveCidrs '\''["127.0.0.1"]'\'' --strict-json >/dev/null;'
  elif [ "$scenario" = "workspace-ready" ]; then
    runtime_args=(--tmpfs "/tmp/hosting-profile-workspace:rw,uid=1001,gid=1001,mode=0700,size=1m")
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
    -e "OPENCLAW_INSTANCE_ID=hosting-profile-$scenario" \
    -e "OPENAI_API_KEY=fixture-openai-token" \
    -e "OPENCLAW_SKIP_CHANNELS=1" \
    -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
    -e "OPENCLAW_SKIP_CRON=1" \
    -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
    "$IMAGE_NAME" \
    bash -lc "set -euo pipefail; source scripts/lib/openclaw-e2e-instance.sh; entry=\"\$(openclaw_e2e_resolve_entrypoint)\"; tsx scripts/e2e/docker-openai-seed.ts >/dev/null; node \"\$entry\" config set gateway.controlUi.enabled false >/dev/null; $gateway_setup openclaw_e2e_exec_gateway \"\$entry\" $PORT $bind /tmp/hosting-profiles.log" \
    >/dev/null

  if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
    "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz $expected_status 1000"; then
    dump_readiness_response "$container_name"
    dump_scenario_log "$container_name" /tmp/hosting-profiles.log
    exit 1
  fi

  docker_e2e_docker_cmd exec "$container_name" \
    node scripts/e2e/hosting-profiles-client.mjs "$scenario" "http://127.0.0.1:$PORT/readyz"
  record_initial_profile_validation "$container_name" "$scenario" "$profile"

  if [ "$scenario" = "local" ]; then
    local before_restart_path="/tmp/hosting-profiles-before-restart.json"
    docker_e2e_docker_cmd exec "$container_name" node --input-type=module -e \
      "import fs from 'node:fs'; const response = await fetch('http://127.0.0.1:$PORT/readyz'); fs.writeFileSync('$before_restart_path', await response.text());"
    docker_e2e_docker_cmd restart "$container_name" >/dev/null
    if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
      "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz 200 1000"; then
      dump_readiness_response "$container_name"
      dump_scenario_log "$container_name" /tmp/hosting-profiles.log
      exit 1
    fi
    docker_e2e_docker_cmd exec "$container_name" \
      node scripts/e2e/hosting-profiles-client.mjs local \
      "http://127.0.0.1:$PORT/readyz" "$before_restart_path"
    record_profile_validation "$container_name" local-restarted local true true
  elif [ "$scenario" = "node-not-ready" ]; then
    docker_e2e_docker_cmd exec -d "$container_name" bash -lc \
      'set -euo pipefail; source scripts/lib/openclaw-e2e-instance.sh; entry="$(openclaw_e2e_resolve_entrypoint)"; exec node "$entry" node run --host 127.0.0.1 --port 18789 --node-id hosting-profile-node --display-name "Hosting Profile Node" >/tmp/hosting-profiles-node.log 2>&1'
    if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
      "node scripts/e2e/hosting-profiles-client.mjs node-unapproved http://127.0.0.1:$PORT/readyz >/dev/null 2>&1"; then
      dump_readiness_response "$container_name"
      dump_scenario_log "$container_name" /tmp/hosting-profiles.log
      dump_scenario_log "$container_name" /tmp/hosting-profiles-node.log
      exit 1
    fi
    docker_e2e_docker_cmd exec "$container_name" \
      node scripts/e2e/hosting-profiles-client.mjs node-unapproved "http://127.0.0.1:$PORT/readyz"
    record_profile_validation "$container_name" node-unapproved node-mode true false
    docker_e2e_docker_cmd exec "$container_name" bash -lc \
      'set -euo pipefail; source scripts/lib/openclaw-e2e-instance.sh; entry="$(openclaw_e2e_resolve_entrypoint)"; pending="$(node "$entry" nodes pending --json)"; request_id="$(node -e "const requests=JSON.parse(process.argv[1]); process.stdout.write(requests[0]?.requestId ?? \"\")" "$pending")"; test -n "$request_id"; node "$entry" nodes approve "$request_id" --json >/dev/null'
    if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
      "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz 200 1000"; then
      dump_readiness_response "$container_name"
      dump_scenario_log "$container_name" /tmp/hosting-profiles.log
      dump_scenario_log "$container_name" /tmp/hosting-profiles-node.log
      exit 1
    fi
    docker_e2e_docker_cmd exec "$container_name" \
      node scripts/e2e/hosting-profiles-client.mjs node-ready "http://127.0.0.1:$PORT/readyz"
    record_profile_validation "$container_name" node-ready node-mode true true
  elif [ "$scenario" = "workspace-ready" ]; then
    docker_e2e_docker_cmd exec "$container_name" bash -lc \
      'set +e; dd if=/dev/zero of=/tmp/hosting-profile-workspace/fill bs=64K status=none; code=$?; sync; test "$code" -ne 0'
    if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
      "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz 503 1000"; then
      dump_readiness_response "$container_name"
      dump_scenario_log "$container_name" /tmp/hosting-profiles.log
      exit 1
    fi
    docker_e2e_docker_cmd exec "$container_name" \
      node scripts/e2e/hosting-profiles-client.mjs workspace-full "http://127.0.0.1:$PORT/readyz"
    record_profile_validation "$container_name" workspace-full local true false
    docker_e2e_docker_cmd exec "$container_name" rm -f /tmp/hosting-profile-workspace/fill
    if ! docker_e2e_wait_container_bash "$container_name" 180 0.5 \
      "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz 200 1000"; then
      dump_readiness_response "$container_name"
      dump_scenario_log "$container_name" /tmp/hosting-profiles.log
      exit 1
    fi
    docker_e2e_docker_cmd exec "$container_name" \
      node scripts/e2e/hosting-profiles-client.mjs workspace-recovered "http://127.0.0.1:$PORT/readyz"
    record_profile_validation "$container_name" workspace-recovered local true true
  fi
}

run_scenario unprofiled "" loopback 200
run_scenario local local loopback 200
run_scenario container-ready container lan 200
run_scenario container-loopback container loopback 503
run_scenario reverse-proxy-ready reverse-proxy loopback 200
run_scenario reverse-proxy-auth-missing reverse-proxy loopback 503
run_scenario node-not-ready node-mode loopback 503
run_scenario workspace-ready local loopback 200

node "$CONFORMANCE_WRITER" finalize "$ARTIFACT_PATH"
echo "Hosting profile conformance artifact: $ARTIFACT_PATH"
echo "OpenClaw package under test: $PACKAGE_VERSION"
echo "Hosting profiles Docker E2E passed"
