#!/usr/bin/env bash
set -euo pipefail

source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh
source scripts/lib/docker-e2e-logs.sh

if [ "${OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP:-0}" != "1" ]; then
  echo "blocked destructive package self-update; set OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP=1 to run" >&2
  exit 2
fi

SOURCE_PACKAGE=/tmp/openclaw-update-first-hop-source.tgz
CANDIDATE_PACKAGE=/tmp/openclaw-update-first-hop-candidate.tgz
NEGATIVE_PACKAGE=/tmp/openclaw-update-first-hop-negative.tgz
FUTURE_PACKAGE=/tmp/openclaw-update-first-hop-future.tgz
ARTIFACT_DIR="${OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR:-/tmp/openclaw-update-first-hop-artifacts}"
EXPECTED_MISSING_CHUNK="${OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK:-shared-Y6bNiw2w.js}"
BASE_PATH="$PATH"
ACCOUNT_HOME="$HOME"

export CI=true
export OPENCLAW_ALLOW_ROOT=1
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1
export OPENCLAW_SKIP_PROVIDERS=1
export npm_config_audit=false
export npm_config_fund=false
export npm_config_loglevel=error

for package_path in "$SOURCE_PACKAGE" "$CANDIDATE_PACKAGE" "$NEGATIVE_PACKAGE" "$FUTURE_PACKAGE"; do
  if [ ! -f "$package_path" ]; then
    echo "missing package input: $package_path" >&2
    exit 2
  fi
done
mkdir -p "$ARTIFACT_DIR"

package_root() {
  printf '%s/lib/node_modules/openclaw\n' "$npm_config_prefix"
}

run_update() {
  local output="$ARTIFACT_DIR/$1" target="$2" update_status=0
  printf '%q ' env "PATH=$PATH" "npm_config_prefix=$npm_config_prefix" openclaw \
    update --yes "--tag=$target" --json >"$output-command.txt"
  printf '\n' >>"$output-command.txt"
  openclaw update --yes "--tag=$target" --json \
    >"$output.stdout" 2>"$output.stderr" || update_status="$?"
  printf '%s\n' "$update_status" >"$output.exit"
  if [ "$update_status" -ne 0 ]; then
    echo "package update $1 exited with status $update_status" >&2
    docker_e2e_print_log "$output.stdout" >&2
    docker_e2e_print_log "$output.stderr" >&2
  fi
  return "$update_status"
}

record_residue() {
  local output="$1"
  find "$npm_config_prefix/lib/node_modules" -maxdepth 2 \
    \( -name '.openclaw-update-*' -o -name 'openclaw.backup-*' -o -name '*.rollback-*' \) \
    -print | sort >"$output"
}

assert_no_residue() {
  local file="$1"
  if [ -s "$file" ]; then
    echo "update left transaction residue" >&2
    cat "$file" >&2
    return 1
  fi
}

wait_service_active() {
  for _ in $(seq 1 300); do
    if systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "managed service did not become active" >&2
  return 1
}

record_service_state() {
  local output="$1"
  systemctl --user show \
    --property=Id,LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent \
    openclaw-gateway.service >"$output"
}

assert_installed_build() {
  local expected_package="$1" output="$2"
  tar -xOf "$expected_package" package/dist/build-info.json \
    >"$output.expected" 2>"$output.tar.stderr"
  cp "$(package_root)/dist/build-info.json" "$output"
  if ! cmp -s "$output.expected" "$output"; then
    echo "installed package build did not match selected candidate" >&2
    diff -u "$output.expected" "$output" >&2 || true
    return 1
  fi
}

setup_lane() {
  local lane="$1" port="$2"
  local runtime_root="/tmp/openclaw-update-first-hop-runtime/$lane"
  export HOME="$ACCOUNT_HOME"
  export OPENCLAW_STATE_DIR="$HOME/.openclaw"
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
  export npm_config_prefix="$runtime_root/npm-prefix"
  export NPM_CONFIG_PREFIX="$npm_config_prefix"
  export npm_config_cache="$runtime_root/npm-cache"
  export NPM_CONFIG_CACHE="$npm_config_cache"
  export PATH="$npm_config_prefix/bin:$BASE_PATH"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$ARTIFACT_DIR/$lane-systemctl.log"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_DIR/$lane-systemctl.pid"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$ARTIFACT_DIR/$lane-gateway.log"

  mkdir -p "$OPENCLAW_STATE_DIR" "$npm_config_prefix" "$npm_config_cache"
  npm install -g --prefix "$npm_config_prefix" "$SOURCE_PACKAGE" --no-fund --no-audit \
    >"$ARTIFACT_DIR/$lane-install-source.log" 2>&1 || {
      docker_e2e_print_log "$ARTIFACT_DIR/$lane-install-source.log" >&2
      return 1
    }
  openclaw --version >"$ARTIFACT_DIR/$lane-source-version.txt"
  install_update_restart_systemctl_shim
  openclaw config set gateway.mode local >"$ARTIFACT_DIR/$lane-config.log" 2>&1
  openclaw config set gateway.port "$port" >>"$ARTIFACT_DIR/$lane-config.log" 2>&1
  openclaw gateway install --force --json \
    >"$ARTIFACT_DIR/$lane-service-install.json" \
    2>"$ARTIFACT_DIR/$lane-service-install.err"
  wait_service_active
  cp "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE" "$ARTIFACT_DIR/$lane-before.pid"
  record_service_state "$ARTIFACT_DIR/$lane-service-before.txt"
}

stop_lane() {
  systemctl --user stop openclaw-gateway.service >/dev/null 2>&1 || true
}

reset_lane() {
  openclaw gateway uninstall --json \
    >"$ARTIFACT_DIR/negative-service-uninstall.json" \
    2>"$ARTIFACT_DIR/negative-service-uninstall.err" || true
  rm -rf \
    "$HOME/.openclaw" \
    "$HOME/.config/systemd/user/openclaw-gateway.service" \
    "$HOME/.config/systemd/user/default.target.wants/openclaw-gateway.service"
}

run_negative_control() {
  local lane=negative
  setup_lane "$lane" 18791
  local update_status=0
  run_update "$lane-update" "$NEGATIVE_PACKAGE" || update_status="$?"
  assert_installed_build "$CANDIDATE_PACKAGE" "$ARTIFACT_DIR/$lane-installed-build-info.json"
  record_residue "$ARTIFACT_DIR/$lane-transaction-residue.txt"
  assert_no_residue "$ARTIFACT_DIR/$lane-transaction-residue.txt"

  if [ "$update_status" -ne 1 ]; then
    echo "negative control expected update exit 1, got $update_status" >&2
    return 1
  fi
  if ! grep -Fq "$EXPECTED_MISSING_CHUNK" \
    "$ARTIFACT_DIR/$lane-update.stdout" "$ARTIFACT_DIR/$lane-update.stderr"; then
    echo "negative control did not reproduce missing $EXPECTED_MISSING_CHUNK" >&2
    return 1
  fi
  if systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1; then
    echo "negative control unexpectedly preserved the stopped service" >&2
    return 1
  fi
  record_service_state "$ARTIFACT_DIR/$lane-service-after.txt" || true
  stop_lane
  reset_lane
}

run_positive_hops() {
  local lane=positive
  setup_lane "$lane" 18792
  local first_pid
  first_pid="$(cat "$ARTIFACT_DIR/$lane-before.pid")"

  run_update "$lane-first" "$CANDIDATE_PACKAGE"
  assert_installed_build "$CANDIDATE_PACKAGE" "$ARTIFACT_DIR/$lane-first-build-info.json"
  wait_service_active
  local candidate_pid
  candidate_pid="$(cat "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE")"
  if [ "$candidate_pid" = "$first_pid" ]; then
    echo "first hop did not replace the managed service process" >&2
    return 1
  fi
  if grep -Eq 'ERR_MODULE_NOT_FOUND|Cannot find module' \
    "$ARTIFACT_DIR/$lane-first.stdout" "$ARTIFACT_DIR/$lane-first.stderr"; then
    echo "first hop reported a missing runtime import" >&2
    return 1
  fi
  record_residue "$ARTIFACT_DIR/$lane-first-transaction-residue.txt"
  assert_no_residue "$ARTIFACT_DIR/$lane-first-transaction-residue.txt"
  record_service_state "$ARTIFACT_DIR/$lane-service-after-first.txt"

  run_update "$lane-second" "$FUTURE_PACKAGE"
  assert_installed_build "$FUTURE_PACKAGE" "$ARTIFACT_DIR/$lane-second-build-info.json"
  wait_service_active
  local future_pid
  future_pid="$(cat "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE")"
  if [ "$future_pid" = "$candidate_pid" ]; then
    echo "second hop did not replace the managed service process" >&2
    return 1
  fi
  if grep -Eq 'ERR_MODULE_NOT_FOUND|Cannot find module' \
    "$ARTIFACT_DIR/$lane-second.stdout" "$ARTIFACT_DIR/$lane-second.stderr"; then
    echo "second hop reported a missing runtime import" >&2
    return 1
  fi
  record_residue "$ARTIFACT_DIR/$lane-second-transaction-residue.txt"
  assert_no_residue "$ARTIFACT_DIR/$lane-second-transaction-residue.txt"
  record_service_state "$ARTIFACT_DIR/$lane-service-after-second.txt"
  printf '%s\n' "$first_pid" "$candidate_pid" "$future_pid" \
    >"$ARTIFACT_DIR/$lane-service-pids.txt"
  stop_lane
}

run_negative_control
run_positive_hops

EXPECTED_MISSING_CHUNK="$EXPECTED_MISSING_CHUNK" node -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], `${JSON.stringify({
    negativeControl: { exit: 1, missingChunk: process.env.EXPECTED_MISSING_CHUNK },
    firstHop: { exit: 0, serviceIntent: "active", residueCount: 0 },
    secondHop: { exit: 0, serviceIntent: "active", residueCount: 0 },
  }, null, 2)}\n`);
' "$ARTIFACT_DIR/summary.json"

echo "Packaged updater first-hop compatibility E2E passed."
