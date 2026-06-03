#!/usr/bin/env bash
# Reproduces the multi-node-install update bug.
#
# Sets up two independent Node installations inside a Docker container, installs
# OpenClaw under node-A, registers the gateway service pointing at node-A, then
# switches PATH so node-B comes first and runs `openclaw update`. Verifies that:
#
# 1. The update targets the wrong install root (node-B npm prefix) or produces
#    a gateway service definition pointing at node-B while the package lives
#    under node-A.
# 2. The gateway fails to start or runs a stale/missing entrypoint.
#
# Usage:
#   ./scripts/e2e/multi-node-update-docker.sh
#
# Requires: Docker, a built openclaw-current.tgz (or will build one).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="openclaw-multi-node-update-e2e"
DOCKER_RUN_TIMEOUT="${OPENCLAW_MULTI_NODE_DOCKER_TIMEOUT:-300s}"
RUN_ID="${OPENCLAW_MULTI_NODE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
ARTIFACT_DIR="${OPENCLAW_MULTI_NODE_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/multi-node-update/$RUN_ID}"

mkdir -p "$ARTIFACT_DIR"
chmod -R a+rwX "$ARTIFACT_DIR" || true
cleanup() {
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
}
trap cleanup EXIT

# Build the bare e2e image and prepare the package tarball.
docker_e2e_build_or_reuse "$IMAGE_NAME" multi-node-update "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "${OPENCLAW_SKIP_DOCKER_BUILD:-0}"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz multi-node-update "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
docker_e2e_package_mount_args "$PACKAGE_TGZ"

echo "=== Running multi-node-update Docker E2E ==="

CONTAINER_EXIT=0
docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e CI=true \
  -e OPENCLAW_NO_ONBOARD=1 \
  -e OPENCLAW_NO_PROMPT=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_DISABLE_BONJOUR=1 \
  -e OPENAI_API_KEY=sk-multi-node-test \
  -v "$ARTIFACT_DIR:/tmp/artifacts" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  --user root \
  -e HOME=/root \
  "$IMAGE_NAME" \
  timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash -lc '
set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh

ARTIFACTS=/tmp/artifacts
exec > >(tee "$ARTIFACTS/run.log") 2>&1

echo "========================================"
echo "  Multi-Node Update Bug Reproduction"
echo "========================================"
echo ""

# ── Step 1: Create two separate Node installations ──────────────────────
echo "── Step 1: Setting up two Node installations ──"

# node-A is the system node that ships with the Docker image (node:24-bookworm-slim).
NODE_A="$(command -v node)"
NODE_A_DIR="$(dirname "$NODE_A")"
NODE_A_VERSION="$("$NODE_A" --version)"
echo "node-A: $NODE_A ($NODE_A_VERSION)"

# Set up independent npm prefixes.
NPM_PREFIX_A="/opt/npm-prefix-a"
NPM_PREFIX_B="/opt/npm-prefix-b"
mkdir -p "$NPM_PREFIX_A/bin" "$NPM_PREFIX_A/lib" "$NPM_PREFIX_B/bin" "$NPM_PREFIX_B/lib"

# node-B is a second, full Node installation created by copying the entire
# node prefix. This simulates having two real node installs (e.g. Homebrew +
# nvm, or system node + volta).
NODE_B_ROOT="/opt/node-b"
NODE_A_PREFIX="$(dirname "$NODE_A_DIR")"
mkdir -p "$NODE_B_ROOT"
cp -a "$NODE_A_PREFIX/bin" "$NODE_B_ROOT/bin"
cp -a "$NODE_A_PREFIX/lib" "$NODE_B_ROOT/lib"
chmod -R +x "$NODE_B_ROOT/bin/"*
# Configure node-B npm to use its own global prefix (not node-A prefix).
export npm_config_prefix_orig="${npm_config_prefix:-}"
"$NODE_B_ROOT/bin/node" "$NODE_B_ROOT/bin/npm" config set prefix "$NPM_PREFIX_B" --global 2>/dev/null || true
NODE_B="$NODE_B_ROOT/bin/node"
NODE_B_VERSION="$("$NODE_B" --version)"
echo "node-B: $NODE_B ($NODE_B_VERSION)"

echo ""
echo "── Step 2: Install OpenClaw under node-A ──"

# Use node-A to install openclaw with npm prefix A.
export npm_config_prefix="$NPM_PREFIX_A"
export NPM_CONFIG_PREFIX="$NPM_PREFIX_A"
export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export PATH="$NPM_PREFIX_A/bin:$NODE_A_DIR:$PATH"

echo "Installing OpenClaw package under node-A prefix: $NPM_PREFIX_A"
openclaw_e2e_install_package "$ARTIFACTS/install-a.log" "OpenClaw package under node-A prefix" "$NPM_PREFIX_A"
echo "Installed. Checking openclaw location..."

OPENCLAW_A="$(command -v openclaw)"
echo "openclaw binary: $OPENCLAW_A"
echo "openclaw version: $(openclaw --version 2>/dev/null || echo unknown)"

# Record the package root for node-A install.
PACKAGE_ROOT_A="$NPM_PREFIX_A/lib/node_modules/openclaw"
echo "Package root A: $PACKAGE_ROOT_A"
ls -la "$PACKAGE_ROOT_A/package.json" 2>/dev/null || echo "WARNING: package.json not found at A"

echo ""
echo "── Step 3: Install the systemd service (gateway) using node-A ──"

# Create a systemctl shim since we are in Docker (no real systemd).
SHIM_DIR="/usr/local/bin"
GATEWAY_UNIT_PATH="/root/.config/systemd/user/openclaw-gateway.service"
SYSTEMCTL_LOG="$ARTIFACTS/systemctl-shim.log"
GATEWAY_DAEMON_LOG="$ARTIFACTS/gateway-daemon.log"
GATEWAY_PID_FILE="$ARTIFACTS/gateway.pid"
: >"$SYSTEMCTL_LOG"

cat >"$SHIM_DIR/systemctl" <<SHIMEOF
#!/usr/bin/env bash
set -euo pipefail
printf "%s %s\n" "\$(date -u +%H:%M:%S)" "\$*" >>"$SYSTEMCTL_LOG"

filtered=()
for ((i = 1; i <= \$#; i++)); do
  arg="\${!i}"
  case "\$arg" in
    --user|--quiet|--no-page|--now|--value) ;;
    --property)
      i=\$((i + 1))
      ;;
    --property=*) ;;
    *) filtered+=("\$arg") ;;
  esac
done
command="\${filtered[0]:-status}"

is_running() {
  [ -s "$GATEWAY_PID_FILE" ] || return 1
  local pid
  pid="\$(cat "$GATEWAY_PID_FILE" 2>/dev/null || true)"
  [ -n "\$pid" ] || return 1
  kill -0 "\$pid" >/dev/null 2>&1
}

stop_gateway() {
  [ -s "$GATEWAY_PID_FILE" ] || return 0
  local pid
  pid="\$(cat "$GATEWAY_PID_FILE" 2>/dev/null || true)"
  if [[ "\$pid" =~ ^[0-9]+$ ]] && [ "\$pid" -gt 1 ] && kill -0 "\$pid" >/dev/null 2>&1; then
    kill "\$pid" >/dev/null 2>&1 || true
    for _ in \$(seq 1 100); do
      kill -0 "\$pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
    kill -9 "\$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$GATEWAY_PID_FILE"
}

load_unit_environment() {
  local unit="\$1"
  while IFS= read -r line; do
    case "\$line" in
      EnvironmentFile=*)
        local spec="\${line#EnvironmentFile=}"
        for token in \$spec; do
          local file="\${token#-}"
          [ -f "\$file" ] || continue
          set -a
          # shellcheck disable=SC1090
          . "\$file"
          set +a
        done
        ;;
      Environment=*)
        local assignment="\${line#Environment=}"
        assignment="\${assignment#\"}"
        assignment="\${assignment%\"}"
        export "\$assignment"
        ;;
    esac
  done <"\$unit"
}

start_gateway() {
  local unit="$GATEWAY_UNIT_PATH"
  local exec_start
  if [ ! -f "\$unit" ]; then
    echo "systemctl shim: unit not found: \$unit" >&2
    return 1
  fi
  exec_start="\$(sed -n 's/^ExecStart=//p' "\$unit" | tail -n 1)"
  if [ -z "\$exec_start" ]; then
    echo "systemctl shim: no ExecStart in \$unit" >&2
    return 1
  fi
  (
    load_unit_environment "\$unit"
    export OPENCLAW_NO_RESPAWN=1
    echo "systemctl shim: starting: \$exec_start"
    nohup bash -lc "exec \$exec_start" >>"$GATEWAY_DAEMON_LOG" 2>&1 &
    printf '%s\n' "\$!" >"$GATEWAY_PID_FILE"
  )
}

case "\$command" in
  daemon-reload)
    echo "daemon-reload (shim: no-op)"
    ;;
  enable)
    echo "enable (shim: no-op)"
    ;;
  is-enabled)
    echo "enabled"
    ;;
  restart|start)
    stop_gateway
    start_gateway
    ;;
  stop)
    stop_gateway
    ;;
  is-active)
    if is_running; then
      echo "active"
    else
      echo "inactive"
      exit 3
    fi
    ;;
  show)
    if is_running; then
      printf 'ActiveState=active\nSubState=running\nMainPID=%s\nExecMainStatus=0\nExecMainCode=0\n' "\$(cat "$GATEWAY_PID_FILE")"
    else
      printf 'ActiveState=inactive\nSubState=dead\nMainPID=0\nExecMainStatus=0\nExecMainCode=0\n'
    fi
    ;;
  *)
    echo "systemctl shim: unsupported command: \$*" >&2
    exit 1
    ;;
esac
SHIMEOF
chmod +x "$SHIM_DIR/systemctl"
echo "systemctl shim installed."

# Now install the gateway service using node-A.
echo "Installing gateway service..."
mkdir -p "$(dirname "$GATEWAY_UNIT_PATH")"
if ! openclaw gateway install --json >"$ARTIFACTS/gateway-install.json" 2>"$ARTIFACTS/gateway-install.err"; then
  echo "FAIL: gateway install failed before update"
  cat "$ARTIFACTS/gateway-install.json" 2>/dev/null || true
  cat "$ARTIFACTS/gateway-install.err" 2>/dev/null || true
  exit 1
fi

echo ""
echo "── Step 4: Inspect what node path was baked into the service ──"

if [ -f "$GATEWAY_UNIT_PATH" ]; then
  echo "Service unit contents:"
  cat "$GATEWAY_UNIT_PATH" | tee "$ARTIFACTS/unit-before-update.txt"
  echo ""
  EXEC_START_BEFORE="$(grep "^ExecStart=" "$GATEWAY_UNIT_PATH" | head -1)"
  BAKED_NODE_BEFORE="$(echo "$EXEC_START_BEFORE" | sed "s/^ExecStart=//" | awk "{print \$1}")"
  echo "Baked node path BEFORE update: $BAKED_NODE_BEFORE"
else
  echo "FAIL: Gateway unit file was not created at $GATEWAY_UNIT_PATH"
  echo "gateway install output:"
  cat "$ARTIFACTS/gateway-install.json" 2>/dev/null || true
  cat "$ARTIFACTS/gateway-install.err" 2>/dev/null || true
  exit 1
fi

echo ""
echo "── Step 5: Switch PATH so node-B comes first ──"

# Simulate the user scenario: their PATH changes (e.g. they installed
# a second Node via nvm, brew, etc.) and the new node-B comes first.
# Crucially, node-B has its own working npm with its own global prefix,
# but openclaw is NOT installed there.
export PATH="$NPM_PREFIX_B/bin:$NODE_B_ROOT/bin:$NPM_PREFIX_A/bin:$NODE_A_DIR:$PATH"
export npm_config_prefix="$NPM_PREFIX_B"
export NPM_CONFIG_PREFIX="$NPM_PREFIX_B"

# Verify node-B npm works independently.
echo "node-B npm prefix: $($NODE_B_ROOT/bin/node $NODE_B_ROOT/bin/npm prefix -g 2>/dev/null || echo unknown)"
echo "which node: $(command -v node)"
echo "which openclaw: $(command -v openclaw)"
echo "process.execPath will be: $(node -e "console.log(process.execPath)")"

echo ""
echo "── Step 6: Run openclaw update (this is the bug) ──"

UPDATE_FAILED=0
GATEWAY_START_FAILED=0
GATEWAY_HEALTH_FAILED=0

# Run the update WITH restart so that the update flow re-runs
# `gateway install --force` and bakes the current process.execPath
# (now node-B) into the service unit. This is where the split happens.
echo "Running openclaw update --yes --json..."
UPDATE_EXIT=0
openclaw update --yes --json \
  --tag /tmp/openclaw-current.tgz \
  >"$ARTIFACTS/update.json" 2>"$ARTIFACTS/update.err" || UPDATE_EXIT=$?

echo ""
echo "Update exit code: $UPDATE_EXIT"
echo "Update stderr (if any):"
cat "$ARTIFACTS/update.err" 2>/dev/null | tail -10 || true
if [ "$UPDATE_EXIT" -ne 0 ]; then
  UPDATE_FAILED=1
fi

# Keep inspecting after a non-zero update so the log shows whether the unit was
# rewritten, but fail immediately if update never reached the service refresh.
if [ "$UPDATE_EXIT" -ne 0 ] && ! grep -q "gateway" "$ARTIFACTS/update.err" 2>/dev/null; then
  echo "FAIL: openclaw update failed before reaching the package install step"
  cat "$ARTIFACTS/update.err" 2>/dev/null || true
  exit 1
fi

echo ""
echo "── Step 7: Inspect the service unit AFTER update ──"

if [ -f "$GATEWAY_UNIT_PATH" ]; then
  echo "Service unit contents after update:"
  cat "$GATEWAY_UNIT_PATH" | tee "$ARTIFACTS/unit-after-update.txt"
  echo ""
  EXEC_START_AFTER="$(grep "^ExecStart=" "$GATEWAY_UNIT_PATH" | head -1)"
  BAKED_NODE_AFTER="$(echo "$EXEC_START_AFTER" | sed "s/^ExecStart=//" | awk "{print \$1}")"
  echo "Baked node path AFTER update: $BAKED_NODE_AFTER"
else
  echo "No unit file after update."
fi

echo ""
echo "── Step 8: Verify results ──"

BAKED_NODE_BEFORE="${BAKED_NODE_BEFORE:-unknown}"
BAKED_NODE_AFTER="${BAKED_NODE_AFTER:-unknown}"

echo "Node A:              $NODE_A"
echo "Node B:              $NODE_B"
echo "Baked BEFORE update: $BAKED_NODE_BEFORE"
echo "Baked AFTER update:  $BAKED_NODE_AFTER"
echo "Package root A:      $PACKAGE_ROOT_A"
echo ""

# Check 1: Did the baked node path change from A to B?
if [ "$BAKED_NODE_AFTER" = "$NODE_B" ] && [ "$BAKED_NODE_BEFORE" != "$NODE_B" ]; then
  echo "BUG CONFIRMED: Gateway service now points at node-B ($NODE_B)"
  echo "   but OpenClaw package is still under node-A prefix ($PACKAGE_ROOT_A)."
  echo "   The gateway will use node-B to run an entrypoint that may reference"
  echo "   node-A dependencies or may not exist under node-B global prefix."
elif [ "$BAKED_NODE_AFTER" = "$BAKED_NODE_BEFORE" ]; then
  echo "FIXED: Gateway service still points at the original node ($BAKED_NODE_AFTER)"
else
  echo "CHANGED: Node path changed from $BAKED_NODE_BEFORE to $BAKED_NODE_AFTER"
fi

# Check 2: Is the OpenClaw package installed under node-B npm prefix?
if [ -f "$NPM_PREFIX_B/lib/node_modules/openclaw/package.json" ]; then
  echo "WARNING: OpenClaw was ALSO installed under node-B prefix (split install)"
else
  echo "OK: OpenClaw is NOT under node-B prefix (expected: only under node-A)"
fi

# Check 3: Does the entrypoint in the unit file actually exist?
if [ -f "$GATEWAY_UNIT_PATH" ]; then
  EXEC_START_AFTER="$(grep "^ExecStart=" "$GATEWAY_UNIT_PATH" | head -1 | sed "s/^ExecStart=//")"
  ENTRYPOINT_PATH="$(echo "$EXEC_START_AFTER" | awk "{print \$2}")"
  if [ -n "$ENTRYPOINT_PATH" ] && [ ! -f "$ENTRYPOINT_PATH" ]; then
    echo "BUG: Entrypoint in service unit does not exist: $ENTRYPOINT_PATH"
  elif [ -n "$ENTRYPOINT_PATH" ]; then
    echo "OK: Entrypoint exists: $ENTRYPOINT_PATH"
  fi
fi

# Check 4: Were there any warnings about split install in the update output?
if [ -f "$ARTIFACTS/update.err" ]; then
  if grep -qi "Shell OpenClaw root differs" "$ARTIFACTS/update.err" 2>/dev/null; then
    echo "OK: Update warned about split root"
  fi
  if grep -qi "Managed gateway service Node" "$ARTIFACTS/update.err" 2>/dev/null; then
    echo "OK: Update showed the managed service Node path"
  fi
fi

# Check 5: Try to start the gateway and see if it works.
echo ""
echo "── Step 9: Try starting the gateway with the post-update unit ──"

GATEWAY_START_FAILED=0
if [ -f "$GATEWAY_UNIT_PATH" ]; then
  systemctl restart 2>&1 || true
  if PORT=18789 node <<NODE
const url = "http://127.0.0.1:" + process.env.PORT + "/healthz";
const deadline = Date.now() + 30000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let last = "timeout";
while (Date.now() < deadline) {
  try {
    const response = await fetch(url);
    if (response.ok) {
      process.exit(0);
    }
    last = "HTTP " + response.status;
  } catch (error) {
    last = error instanceof Error ? error.message : String(error);
  }
  await sleep(500);
}
console.error(last);
process.exit(1);
NODE
  then
    echo "OK: Gateway healthz probe succeeded"
  else
    echo "BUG: Gateway healthz probe failed with the post-update unit"
    GATEWAY_START_FAILED=1
    GATEWAY_HEALTH_FAILED=1
    cat "$GATEWAY_DAEMON_LOG" 2>/dev/null | tail -20 || true
  fi
  systemctl stop 2>&1 || true
fi

echo ""
echo "========================================"
echo "  Reproduction complete."
echo "  Artifacts saved to /tmp/artifacts/"
echo "========================================"

# ── Final exit code ──────────────────────────────────────────────────────────
# Exit non-zero if any BUG was found, making this usable as a CI gate.
EXIT_CODE=0
if [ "$BAKED_NODE_AFTER" = "$NODE_B" ] && [ "$BAKED_NODE_BEFORE" != "$NODE_B" ]; then
  EXIT_CODE=1
fi
if [ -f "$NPM_PREFIX_B/lib/node_modules/openclaw/package.json" ]; then
  EXIT_CODE=1
fi
if [ -f "$GATEWAY_UNIT_PATH" ]; then
  ENTRYPOINT_PATH_CHECK="$(grep "^ExecStart=" "$GATEWAY_UNIT_PATH" | head -1 | sed "s/^ExecStart=//" | awk "{print \$2}")" || true
  if [ -n "$ENTRYPOINT_PATH_CHECK" ] && [ ! -f "$ENTRYPOINT_PATH_CHECK" ]; then
    EXIT_CODE=1
  fi
fi
if [ "$UPDATE_FAILED" -ne 0 ]; then
  EXIT_CODE=1
fi
if [ "$GATEWAY_START_FAILED" -ne 0 ]; then
  EXIT_CODE=1
fi
if [ "$GATEWAY_HEALTH_FAILED" -ne 0 ]; then
  EXIT_CODE=1
fi
exit $EXIT_CODE
' || CONTAINER_EXIT=$?

echo ""
echo "=== Artifacts ==="
echo "Logs saved to: $ARTIFACT_DIR/"
ls -la "$ARTIFACT_DIR/" 2>/dev/null || true

if [ -f "$ARTIFACT_DIR/run.log" ]; then
  echo ""
  echo "=== Key results ==="
  grep -E "^(BUG|FIXED|OK|CHANGED|WARNING)" "$ARTIFACT_DIR/run.log" || echo "(no key results found)"
fi

if [ "$CONTAINER_EXIT" -ne 0 ]; then
  echo ""
  echo "FAIL: Docker container exited with code $CONTAINER_EXIT"
fi
exit "$CONTAINER_EXIT"
