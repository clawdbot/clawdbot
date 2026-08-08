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
WRONG_TOKEN="$TOKEN-wrong"
HEALTH_OVERRIDE_PATH="$PROJECT_DIR/compose-health-override.yaml"
COMPOSE=(
  docker compose
  --project-name "$PROJECT_NAME"
  --project-directory "$PROJECT_DIR"
  -f "$ROOT_DIR/docker-compose.yml"
  -f "$HEALTH_OVERRIDE_PATH"
)

cleanup() {
  docker_e2e_docker_cmd rm -f "$CLI_NAME" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down --remove-orphans --volumes >/dev/null 2>&1 || true
  docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
  docker_e2e_docker_cmd run --rm --user 0:0 \
    -v "$PROJECT_DIR:/target" \
    "$IMAGE_NAME" \
    sh -c 'rm -rf /target/* /target/.[!.]* /target/..?*' >/dev/null 2>&1 || true
  rm -rf "$PROJECT_DIR"
}
trap cleanup EXIT

assert_gateway_health_json() {
  local label="$1"
  local health_path="$2"
  node - "$label" "$health_path" <<'NODE'
const fs = require("node:fs");
const label = process.argv[2];
const healthPath = process.argv[3];
const health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
if (
  health?.ok !== true ||
  !Number.isFinite(health.ts) ||
  !Number.isFinite(health.durationMs) ||
  !health.channels ||
  typeof health.channels !== "object" ||
  Array.isArray(health.channels)
) {
  throw new Error(`${label} gateway health JSON is incomplete`);
}
NODE
  echo "$label accepted the configured token and returned a complete health envelope."
}

assert_dockerfile_healthcheck() {
  node - "$ROOT_DIR/Dockerfile" <<'NODE'
const fs = require("node:fs");
const dockerfilePath = process.argv[2];
const dockerfile = fs.readFileSync(dockerfilePath, "utf8").replace(/\\\r?\n[ \t]*/g, " ");
if (!/HEALTHCHECK\b[^\n]*CMD \["node", "dist\/docker-healthcheck\.js"\]/u.test(dockerfile)) {
  throw new Error("Dockerfile does not install the built Gateway healthcheck");
}
NODE
  echo "Dockerfile healthcheck definition uses dist/docker-healthcheck.js."
}

assert_effective_healthcheck() {
  local label="$1"
  local kind="$2"
  local inspect_path="$3"
  node - "$label" "$kind" "$inspect_path" <<'NODE'
const fs = require("node:fs");
const label = process.argv[2];
const kind = process.argv[3];
const inspectPath = process.argv[4];
const payload = JSON.parse(fs.readFileSync(inspectPath, "utf8"));
const actual =
  kind === "compose"
    ? payload?.services?.["openclaw-gateway"]?.healthcheck?.test
    : payload?.[0]?.Config?.Healthcheck?.Test;
const expected = ["CMD", "node", "dist/docker-healthcheck.js"];
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`${label} healthcheck mismatch: ${JSON.stringify(actual)}`);
}
NODE
  echo "$label uses dist/docker-healthcheck.js."
}

wait_for_gateway_health() {
  local expected="$1"
  local attempts="$2"
  local health=""
  for _ in $(seq 1 "$attempts"); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$GATEWAY_ID")"
    if [ "$health" = "$expected" ]; then
      return 0
    fi
    if [ "$health" = "exited" ] || [ "$health" = "dead" ]; then
      break
    fi
    sleep 1
  done
  echo "Gateway health did not reach $expected (last state: $health)" >&2
  docker inspect --format '{{json .State.Health}}' "$GATEWAY_ID" >&2 || true
  "${COMPOSE[@]}" logs --no-color openclaw-gateway >&2 || true
  return 1
}

assert_probe_endpoints() {
  local label="$1"
  local output_path="$2"
  "${COMPOSE[@]}" exec -T openclaw-gateway node - "$label" >"$output_path" <<'NODE'
const label = process.argv[2];
const readJson = async (path) => {
  const response = await fetch(`http://127.0.0.1:18789${path}`);
  const body = await response.json();
  return { body, status: response.status };
};
const health = await readJson("/healthz");
const ready = await readJson("/readyz");
if (
  health.status !== 200 ||
  health.body?.ok !== true ||
  health.body?.status !== "live"
) {
  throw new Error(`${label} /healthz did not report live: ${JSON.stringify(health)}`);
}
if (
  ready.status !== 200 ||
  ready.body?.ready !== true ||
  !Array.isArray(ready.body?.failing) ||
  ready.body.failing.length !== 0
) {
  throw new Error(`${label} /readyz did not report ready: ${JSON.stringify(ready)}`);
}
console.log(JSON.stringify({ healthz: health, label, readyz: ready }));
NODE
  echo "$label: /healthz is live and /readyz is ready."
}

assert_auth_rejected() {
  local label="$1"
  local stdout_path="$2"
  local stderr_path="$3"
  shift 3
  local exit_code
  set +e
  "$@" >"$stdout_path" 2>"$stderr_path"
  exit_code=$?
  set -e
  if [ "$exit_code" -eq 0 ]; then
    echo "$label accepted an invalid Gateway token" >&2
    return 1
  fi
  node - "$label" "$stdout_path" "$stderr_path" <<'NODE'
const fs = require("node:fs");
const label = process.argv[2];
const output = [process.argv[3], process.argv[4]]
  .map((path) => fs.readFileSync(path, "utf8"))
  .join("\n");
if (!/(unauthorized|token mismatch|authentication)/iu.test(output)) {
  throw new Error(`${label} failed without an authentication diagnostic`);
}
NODE
  echo "$label rejected an invalid Gateway token (exit $exit_code)."
}

assert_health_state() {
  local label="$1"
  local expected="$2"
  local health_path="$3"
  node - "$label" "$expected" "$health_path" <<'NODE'
const fs = require("node:fs");
const label = process.argv[2];
const expected = process.argv[3];
const healthPath = process.argv[4];
const health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
if (health?.Status !== expected || !Array.isArray(health.Log) || health.Log.length === 0) {
  throw new Error(`${label} Docker health state is incomplete: ${JSON.stringify(health)}`);
}
const expectedExit = expected === "unhealthy" ? (code) => code !== 0 : (code) => code === 0;
if (!health.Log.some((entry) => expectedExit(Number(entry?.ExitCode)))) {
  throw new Error(`${label} Docker health log lacks the expected exit status`);
}
console.log(`${label}: ${JSON.stringify({ log: health.Log.slice(-3), status: health.Status })}`);
NODE
}

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
cat >"$HEALTH_OVERRIDE_PATH" <<'EOF'
services:
  openclaw-gateway:
    healthcheck:
      interval: 1s
      timeout: 5s
      retries: 3
      start_period: 5s
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

assert_dockerfile_healthcheck
"${COMPOSE[@]}" config --format json >"$PROJECT_DIR/compose-config.json"
assert_effective_healthcheck "resolved Compose service" compose "$PROJECT_DIR/compose-config.json"

echo "Launching documented Docker Compose gateway topology..."
"${COMPOSE[@]}" up -d --no-build openclaw-gateway
GATEWAY_ID="$("${COMPOSE[@]}" ps -q openclaw-gateway)"
if [ -z "$GATEWAY_ID" ]; then
  echo "Compose did not create openclaw-gateway" >&2
  exit 1
fi
docker inspect "$GATEWAY_ID" >"$PROJECT_DIR/gateway-container.json"
assert_effective_healthcheck "running Gateway container" container "$PROJECT_DIR/gateway-container.json"

wait_for_gateway_health healthy 180
docker inspect --format '{{json .State.Health}}' "$GATEWAY_ID" >"$PROJECT_DIR/health-initial.json"
assert_health_state "initial healthy state" healthy "$PROJECT_DIR/health-initial.json"
assert_probe_endpoints "initial probes" "$PROJECT_DIR/probes-initial.json"

"${COMPOSE[@]}" exec -T openclaw-gateway sh -lc 'node dist/index.js gateway health --token "$OPENCLAW_GATEWAY_TOKEN"'
assert_auth_rejected \
  "gateway service" \
  "$PROJECT_DIR/gateway-wrong-token.json" \
  "$PROJECT_DIR/gateway-wrong-token.err" \
  "${COMPOSE[@]}" exec -T openclaw-gateway \
  node dist/index.js gateway health --token "$WRONG_TOKEN" --json
"${COMPOSE[@]}" exec -T openclaw-gateway node dist/index.js gateway health --token "$TOKEN" --json >"$PROJECT_DIR/gateway-health.json"
assert_gateway_health_json "gateway service" "$PROJECT_DIR/gateway-health.json"
assert_auth_rejected \
  "CLI sidecar" \
  "$PROJECT_DIR/cli-wrong-token.json" \
  "$PROJECT_DIR/cli-wrong-token.err" \
  "${COMPOSE[@]}" run -T --rm --no-deps \
  openclaw-cli gateway health --token "$WRONG_TOKEN" --json
"${COMPOSE[@]}" run -T --no-deps --name "$CLI_NAME" openclaw-cli gateway health --token "$TOKEN" --json >"$PROJECT_DIR/cli-health.json"
assert_gateway_health_json "CLI sidecar" "$PROJECT_DIR/cli-health.json"

echo "Forcing the configured Docker healthcheck to fail..."
docker exec --user 0:0 "$GATEWAY_ID" \
  sh -c 'test -f /app/dist/docker-healthcheck.js && mv /app/dist/docker-healthcheck.js /app/dist/docker-healthcheck.js.c3-disabled'
wait_for_gateway_health unhealthy 30
docker inspect --format '{{json .State.Health}}' "$GATEWAY_ID" >"$PROJECT_DIR/health-unhealthy.json"
assert_health_state "forced unhealthy state" unhealthy "$PROJECT_DIR/health-unhealthy.json"
docker exec --user 0:0 "$GATEWAY_ID" \
  mv /app/dist/docker-healthcheck.js.c3-disabled /app/dist/docker-healthcheck.js
wait_for_gateway_health healthy 60
docker inspect --format '{{json .State.Health}}' "$GATEWAY_ID" >"$PROJECT_DIR/health-recovered.json"
assert_health_state "recovered healthy state" healthy "$PROJECT_DIR/health-recovered.json"
assert_probe_endpoints "recovered probes" "$PROJECT_DIR/probes-recovered.json"

"${COMPOSE[@]}" logs --no-color openclaw-gateway >"$PROJECT_DIR/gateway-compose.log"
if [ ! -s "$PROJECT_DIR/gateway-compose.log" ]; then
  echo "Compose gateway logs were empty" >&2
  exit 1
fi
echo "Compose gateway log tail:"
tail -n 40 "$PROJECT_DIR/gateway-compose.log"

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
  --detail "gateway:dockerfileHealthcheckDefinition=passed" \
  --detail "gateway:composeHealthcheckResolved=passed" \
  --detail "gateway:runtimeHealthcheckEffective=passed" \
  --detail "gateway:healthz=live" \
  --detail "gateway:readyz=ready" \
  --detail "gateway:wrongTokenRejected=passed" \
  --detail "gateway:correctTokenAccepted=passed" \
  --detail "gateway:dockerUnhealthy=observed" \
  --detail "gateway:dockerRecovery=passed" \
  --detail "gateway:composeLogs=observed" \
  --detail "gateway:healthStateDiagnostics=observed" \
  --detail "gateway:documentedHealthCommand=passed" \
  --detail "gateway:healthJsonEnvelope=passed" \
  --detail "cli:wrongTokenRejected=passed" \
  --detail "cli:correctTokenAccepted=passed" \
  --detail "cli:healthJsonEnvelope=passed"

echo "Docker Compose setup proof passed."
