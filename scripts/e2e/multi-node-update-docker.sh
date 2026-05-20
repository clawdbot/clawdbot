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
ARTIFACT_DIR="${OPENCLAW_MULTI_NODE_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/multi-node-update}"

mkdir -p "$ARTIFACT_DIR"
chmod -R a+rwX "$ARTIFACT_DIR" || true

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
  timeout "$DOCKER_RUN_TIMEOUT" bash -lc '
set -euo pipefail

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
npm install -g /tmp/openclaw-current.tgz --no-fund --no-audit >"$ARTIFACTS/install-a.log" 2>&1
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
for arg in "\$@"; do
  case "\$arg" in
    --user|--quiet|--no-page|--now) ;;
    *) filtered+=("\$arg") ;;
  esac
done
command="\${filtered[0]:-status}"

case "\$command" in
  daemon-reload)
    echo "daemon-reload (shim: no-op)"
    ;;
  enable)
    echo "enable (shim: no-op)"
    ;;
  restart|start)
    if [ -s "$GATEWAY_PID_FILE" ]; then
      old_pid="\$(cat "$GATEWAY_PID_FILE" 2>/dev/null || true)"
      if kill -0 "\$old_pid" 2>/dev/null; then
        kill "\$old_pid" 2>/dev/null || true
        sleep 0.5
      fi
    fi
    unit="$GATEWAY_UNIT_PATH"
    if [ ! -f "\$unit" ]; then
      echo "systemctl shim: unit not found: \$unit" >&2
      exit 1
    fi
    exec_start="\$(grep "^ExecStart=" "\$unit" | head -1 | sed "s/^ExecStart=//")"
    if [ -z "\$exec_start" ]; then
      echo "systemctl shim: no ExecStart in \$unit" >&2
      exit 1
    fi
    # Source EnvironmentFile if present
    env_file="\$(grep "^EnvironmentFile=" "\$unit" | head -1 | sed "s/^EnvironmentFile=//" | sed "s/^-//")"
    if [ -n "\$env_file" ] && [ -f "\$env_file" ]; then
      set -a; source "\$env_file"; set +a
    fi
    # Inline Environment= entries
    while IFS= read -r env_line; do
      env_entry="\${env_line#Environment=}"
      env_entry="\${env_entry#\"}"
      env_entry="\${env_entry%\"}"
      export "\$env_entry"
    done < <(grep "^Environment=" "\$unit" || true)
    echo "systemctl shim: starting: \$exec_start"
    eval nohup \$exec_start >>"$GATEWAY_DAEMON_LOG" 2>&1 &
    echo "\$!" >"$GATEWAY_PID_FILE"
    echo "systemctl shim: started pid \$(cat "$GATEWAY_PID_FILE")"
    ;;
  stop)
    if [ -s "$GATEWAY_PID_FILE" ]; then
      pid="\$(cat "$GATEWAY_PID_FILE")"
      kill "\$pid" 2>/dev/null || true
      rm -f "$GATEWAY_PID_FILE"
    fi
    ;;
  is-active)
    if [ -s "$GATEWAY_PID_FILE" ] && kill -0 "\$(cat "$GATEWAY_PID_FILE" 2>/dev/null)" 2>/dev/null; then
      echo "active"
    else
      echo "inactive"
      exit 3
    fi
    ;;
  show)
    echo "ActiveState=inactive"
    ;;
  *)
    echo "systemctl shim: ignoring: \$*"
    ;;
esac
SHIMEOF
chmod +x "$SHIM_DIR/systemctl"
echo "systemctl shim installed."

# Now install the gateway service using node-A.
echo "Installing gateway service..."
mkdir -p "$(dirname "$GATEWAY_UNIT_PATH")"
# gateway install may exit non-zero because our systemctl shim cannot fully
# restart, but the unit file gets written before the restart step.
openclaw gateway install --json >"$ARTIFACTS/gateway-install.json" 2>"$ARTIFACTS/gateway-install.err" || true

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

# Verify node-B npm works independently.
echo "node-B npm prefix: $($NODE_B_ROOT/bin/node $NODE_B_ROOT/bin/npm prefix -g 2>/dev/null || echo unknown)"
echo "which node: $(command -v node)"
echo "which openclaw: $(command -v openclaw)"
echo "process.execPath will be: $(node -e "console.log(process.execPath)")"

echo ""
echo "── Step 6: Run openclaw update (this is the bug) ──"

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

# The update may fail during restart (systemctl shim limitations) but it must
# have at least attempted the package install. Check that it ran past early exit.
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

if [ -f "$GATEWAY_UNIT_PATH" ]; then
  systemctl restart 2>&1 || true
  sleep 3
  if [ -s "$GATEWAY_PID_FILE" ] && kill -0 "$(cat "$GATEWAY_PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "OK: Gateway started (pid $(cat "$GATEWAY_PID_FILE"))"
    # Try a health probe.
    if openclaw gateway status --json >"$ARTIFACTS/status.json" 2>&1; then
      echo "OK: Gateway status probe succeeded"
    else
      echo "WARNING: Gateway status probe failed"
    fi
    # Stop it.
    kill "$(cat "$GATEWAY_PID_FILE")" 2>/dev/null || true
  else
    echo "BUG: Gateway failed to start with the post-update unit"
    cat "$GATEWAY_DAEMON_LOG" 2>/dev/null | tail -20 || true
  fi
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
