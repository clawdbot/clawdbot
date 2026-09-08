#!/usr/bin/env bash
set -Eeuo pipefail
# Signal traps inherit the foreground command's redirections. Keep harness stdout separate so the
# final summary location cannot corrupt a command artifact when the run is interrupted.
exec 3>&1

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/prepublish-plugin-registry.sh
source scripts/e2e/lib/upgrade-survivor/plugin-dependency-fixtures.sh

SCENARIO="${OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:-base}"

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export CI=true
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1
export OPENCLAW_SKIP_PROVIDERS=1
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_DISABLE_BONJOUR=1
LIVE_OPENAI="${OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI:-0}"
LIVE_OPENAI_API_KEY=""
case "$LIVE_OPENAI" in
  0)
    ;;
  1)
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI=1 requires OPENAI_API_KEY" >&2
      exit 2
    fi
    LIVE_OPENAI_API_KEY="$OPENAI_API_KEY"
    ;;
  *)
    echo "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI must be 0 or 1; got: $LIVE_OPENAI" >&2
    exit 2
    ;;
esac
export GATEWAY_AUTH_TOKEN_REF="upgrade-survivor-token"
if [ "$SCENARIO" = "mobile-pairing-reconnect" ]; then
  export GATEWAY_AUTH_PASSWORD_REF="$(
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
  )"
fi
if [ "$SCENARIO" = "watchos-direct-node" ] || [ "$SCENARIO" = "mobile-pairing-reconnect" ]; then
  unset OPENAI_API_KEY DISCORD_BOT_TOKEN TELEGRAM_BOT_TOKEN
else
  export OPENAI_API_KEY="sk-openclaw-upgrade-survivor"
  export DISCORD_BOT_TOKEN="upgrade-survivor-discord-token"
  export TELEGRAM_BOT_TOKEN="123456:upgrade-survivor-telegram-token"
fi
if [ "$SCENARIO" = "feishu-channel" ]; then
  export FEISHU_APP_SECRET="upgrade-survivor-feishu-secret"
fi
if [ "$SCENARIO" = "configured-plugin-installs" ] || [ "$SCENARIO" = "sqlite-volume" ]; then
  export MATRIX_ACCESS_TOKEN="upgrade-survivor-matrix-token"
  export BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"
fi

ARTIFACT_ROOT="$(dirname "${OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON:-/tmp/openclaw-upgrade-survivor-artifacts/summary.json}")"
export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="${OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT:-/tmp/openclaw-upgrade-survivor-runtime}"
RUNTIME_ROOT="$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT"
STATE_HOME_ROOT="${OPENCLAW_UPGRADE_SURVIVOR_STATE_HOME_ROOT:-$RUNTIME_ROOT/state-home}"
mkdir -p "$ARTIFACT_ROOT"
mkdir -p "$RUNTIME_ROOT"
chmod 700 "$RUNTIME_ROOT"
export TMPDIR="${OPENCLAW_UPGRADE_SURVIVOR_TMPDIR:-$RUNTIME_ROOT/tmp}"
export OPENCLAW_TEST_STATE_TMPDIR="${OPENCLAW_UPGRADE_SURVIVOR_TEST_STATE_TMPDIR:-$RUNTIME_ROOT/state-tmp}"
mkdir -p "$TMPDIR" "$OPENCLAW_TEST_STATE_TMPDIR"
if [ "$SCENARIO" = "legacy-operator-state" ]; then
  export npm_config_prefix="$RUNTIME_ROOT/npm-prefix"
else
  export npm_config_prefix="$ARTIFACT_ROOT/npm-prefix"
fi
export NPM_CONFIG_PREFIX="$npm_config_prefix"
export npm_config_cache="${OPENCLAW_UPGRADE_SURVIVOR_NPM_CACHE:-$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT/npm-cache}"
export NPM_CONFIG_CACHE="$npm_config_cache"
export npm_config_tmp="$TMPDIR"
mkdir -p "$npm_config_prefix" "$npm_config_cache"
chmod 700 "$npm_config_cache" || true
export PATH="$npm_config_prefix/bin:$PATH"

SUMMARY_JSON="${OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON:-$ARTIFACT_ROOT/summary.json}"
PHASE_LOG="$ARTIFACT_ROOT/phases.jsonl"
BASELINE_RAW="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE:?missing OPENCLAW_UPGRADE_SURVIVOR_BASELINE}"
CANDIDATE_KIND="${OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_KIND:-tarball}"
CANDIDATE_SPEC="${OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC:-${OPENCLAW_CURRENT_PACKAGE_TGZ:-}}"
UPDATE_RESTART_MODE="${OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE:-manual}"
OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL="stable"
if [ "$SCENARIO" = "prerelease-plugin-registry" ] ||
  { [ "$UPDATE_RESTART_MODE" = "auto-auth" ] &&
    [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] &&
    [[ "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION:-}" =~ -(alpha|beta)\.[1-9][0-9]*$ ]]; }; then
  OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL="beta"
fi
export OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL
ROOT_MANAGED_VPS="${OPENCLAW_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS:-0}"
COMMAND_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"
CURRENT_PHASE="setup"
FAILURE_PHASE=""
FAILURE_MESSAGE=""
FAILURE_SIGNAL=""
gateway_pid=""
plugin_registry_pid=""
clawhub_fixture_pid=""
mock_openai_pid=""
restart_mock_pid=""
restart_registry_pid=""
restart_runtime_evidence=""
restart_fixture_package=""
restart_inference=""
survival_assert_stage="survival"
baseline_spec=""
baseline_version=""
baseline_version_expected="0"
candidate_version=""
candidate_tarball=""
restart_fixture_version=""
restart_fixture_evidence=""
installed_version=""
candidate_install_mode="updater"
HISTORICAL_MOBILE_PAIRING_CANDIDATE_SHA="ea806575e6450e4d1efdfc72c19f04be982a1b9b"
start_seconds=""
status_seconds=""
healthz_seconds=""
readyz_seconds=""
update_restart_seconds=""
update_restart_source=""
update_repair_required="0"
initial_update_observation_root=""
last_update_observation_root=""
idempotence_seconds=""
run_completed="0"
update_outcome=""
update_exit_code=""

BASELINE_INSTALL_LOG="$ARTIFACT_ROOT/baseline-install.log"
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/post-update-validate.json"
POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/post-update-validate.err"
DOCTOR_LOG="$ARTIFACT_ROOT/doctor.log"
REPAIR_JSON="$ARTIFACT_ROOT/repair.json"
BASELINE_DOCTOR_LOG="$ARTIFACT_ROOT/baseline-doctor.log"
GATEWAY_LOG="$ARTIFACT_ROOT/gateway.log"
HEALTHZ_JSON="$ARTIFACT_ROOT/healthz.json"
READYZ_JSON="$ARTIFACT_ROOT/readyz.json"
STATUS_JSON="$ARTIFACT_ROOT/status.json"
STATUS_ERR="$ARTIFACT_ROOT/status.err"
LIVE_OPENAI_JSON="$ARTIFACT_ROOT/live-openai.json"
LIVE_OPENAI_ERR="$ARTIFACT_ROOT/live-openai.err"
BASELINE_CONFIG_VALIDATE_LOG="$ARTIFACT_ROOT/baseline-config-validate.log"
BASELINE_SERVICE_INSTALL_JSON="$ARTIFACT_ROOT/baseline-service-install.json"
BASELINE_SERVICE_INSTALL_ERR="$ARTIFACT_ROOT/baseline-service-install.err"
SYSTEMCTL_SHIM_LOG="$ARTIFACT_ROOT/systemctl-shim.log"
SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_ROOT/systemctl-shim.pid"
SYSTEMCTL_SHIM_DAEMON_LOG="$ARTIFACT_ROOT/systemctl-shim-gateway.log"
CONFIG_COVERAGE_JSON="$ARTIFACT_ROOT/config-recipe.json"
WATCH_RUNTIME_ROOT="$RUNTIME_ROOT/watchos-direct-node"
WATCH_STATE_JSON="$WATCH_RUNTIME_ROOT/state.json"
WATCH_SETUP_JSON="$WATCH_RUNTIME_ROOT/setup.json"
WATCH_NODES_JSON="$WATCH_RUNTIME_ROOT/nodes.json"
WATCH_DEVICES_JSON="$WATCH_RUNTIME_ROOT/devices.json"
WATCH_BASELINE_CONNECT_JSON="$ARTIFACT_ROOT/watchos-baseline-connect.json"
WATCH_BASELINE_STATE_JSON="$ARTIFACT_ROOT/watchos-baseline-state.json"
WATCH_CANDIDATE_CONNECT_JSON="$ARTIFACT_ROOT/watchos-candidate-connect.json"
WATCH_CANDIDATE_STATE_JSON="$ARTIFACT_ROOT/watchos-candidate-state.json"
WATCH_RESTART_CONNECT_JSON="$ARTIFACT_ROOT/watchos-restart-connect.json"
WATCH_RESTART_STATE_JSON="$ARTIFACT_ROOT/watchos-restart-state.json"
WATCH_TLS_ROOT="$WATCH_RUNTIME_ROOT/tls"
WATCH_TLS_CA_KEY="$WATCH_TLS_ROOT/ca-key.pem"
WATCH_TLS_CA_CERT="$WATCH_TLS_ROOT/ca-cert.pem"
WATCH_TLS_SERVER_KEY="$WATCH_TLS_ROOT/server-key.pem"
WATCH_TLS_SERVER_CSR="$WATCH_TLS_ROOT/server.csr"
WATCH_TLS_SERVER_CERT="$WATCH_TLS_ROOT/server-cert.pem"
WATCH_TLS_SERVER_EXT="$WATCH_TLS_ROOT/server.ext"
WATCH_GATEWAY_WS_URL="wss://localhost:18789"
WATCH_GATEWAY_HTTP_URL="https://localhost:18789"
MOBILE_PAIRING_ROOT="$RUNTIME_ROOT/mobile-pairing"
MOBILE_PAIRING_QR_JSON="$MOBILE_PAIRING_ROOT/qr.json"
MOBILE_PAIRING_QR_ERR="$MOBILE_PAIRING_ROOT/qr.err"
MOBILE_PAIRING_CREDENTIALS="$MOBILE_PAIRING_ROOT/credentials.json"
MOBILE_PAIRING_BASELINE_EVIDENCE="$ARTIFACT_ROOT/mobile-pairing-baseline.json"
MOBILE_PAIRING_CANDIDATE_FIRST_EVIDENCE="$ARTIFACT_ROOT/mobile-pairing-candidate-first.json"
MOBILE_PAIRING_CANDIDATE_RESTART_EVIDENCE="$ARTIFACT_ROOT/mobile-pairing-candidate-restart.json"
MOBILE_PAIRING_FINAL_EVIDENCE="$ARTIFACT_ROOT/mobile-pairing-final.json"
HISTORICAL_PACKAGE_REPLACEMENT_EVIDENCE="$ARTIFACT_ROOT/historical-package-replacement.json"
export OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON="$CONFIG_COVERAGE_JSON"
rm -f "$SUMMARY_JSON" "$CONFIG_COVERAGE_JSON"
: >"$PHASE_LOG"

validate_baseline_package_spec() {
  local spec="$1"
  if [[ "$spec" =~ ^openclaw@(alpha|beta|latest|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*|-(alpha|beta)\.[1-9][0-9]*)?)$ ]]; then
    return 0
  fi
  echo "OPENCLAW_UPGRADE_SURVIVOR_BASELINE must be openclaw@latest, openclaw@beta, openclaw@alpha, an exact OpenClaw release version, or a bare release version; got: $spec" >&2
  return 1
}

normalize_baseline() {
  local raw="${BASELINE_RAW//[[:space:]]/}"
  if [ -z "$raw" ]; then
    echo "OPENCLAW_UPGRADE_SURVIVOR_BASELINE cannot be empty" >&2
    return 1
  fi
  case "$raw" in
    openclaw@*)
      baseline_spec="$raw"
      baseline_version="${raw#openclaw@}"
      ;;
    *@*)
      echo "OPENCLAW_UPGRADE_SURVIVOR_BASELINE must be openclaw@<version> or a bare version" >&2
      return 1
      ;;
    *)
      baseline_version="$raw"
      baseline_spec="openclaw@$raw"
      ;;
  esac
  case "$baseline_version" in
    latest | beta | alpha)
      baseline_version=""
      baseline_version_expected="0"
      ;;
    dev | main | "")
      echo "OPENCLAW_UPGRADE_SURVIVOR_BASELINE must be openclaw@latest, openclaw@beta, openclaw@alpha, openclaw@<version>, or a bare version" >&2
      return 1
      ;;
    *)
      baseline_version_expected="1"
      ;;
  esac
  validate_baseline_package_spec "$baseline_spec"
}

validate_update_restart_mode() {
  case "$UPDATE_RESTART_MODE" in
    manual | auto-auth)
      ;;
    *)
      echo "OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE must be manual or auto-auth; got: $UPDATE_RESTART_MODE" >&2
      return 1
      ;;
  esac
}

json_event() {
  local phase="$1"
  local status="$2"
  PHASE_EVENT_PHASE="$phase" PHASE_EVENT_STATUS="$status" node <<'NODE' >>"$PHASE_LOG"
const event = {
  phase: process.env.PHASE_EVENT_PHASE,
  status: process.env.PHASE_EVENT_STATUS,
  at: new Date().toISOString(),
};
process.stdout.write(`${JSON.stringify(event)}\n`);
NODE
}

write_summary() {
  local status="$1"
  local message="${2:-}"
  mkdir -p "$(dirname "$SUMMARY_JSON")"
  SUMMARY_STATUS="$status" \
    SUMMARY_MESSAGE="$message" \
    SUMMARY_PHASE_LOG="$PHASE_LOG" \
    SUMMARY_JSON="$SUMMARY_JSON" \
    SUMMARY_BASELINE_SPEC="$baseline_spec" \
    SUMMARY_BASELINE_VERSION="$baseline_version" \
    SUMMARY_CANDIDATE_VERSION="$candidate_version" \
    SUMMARY_INSTALLED_VERSION="$installed_version" \
    SUMMARY_CANDIDATE_INSTALL_MODE="$candidate_install_mode" \
    SUMMARY_SCENARIO="$SCENARIO" \
    SUMMARY_UPDATE_RESTART_MODE="$UPDATE_RESTART_MODE" \
    SUMMARY_UPDATE_OUTCOME="${update_outcome:-success}" \
    SUMMARY_UPDATE_REPAIR_REQUIRED="$update_repair_required" \
    SUMMARY_UPDATE_RESTART_SOURCE="$update_restart_source" \
    SUMMARY_START_SECONDS="$start_seconds" \
    SUMMARY_UPDATE_RESTART_SECONDS="$update_restart_seconds" \
    SUMMARY_IDEMPOTENCE_SECONDS="$idempotence_seconds" \
    SUMMARY_HEALTHZ_SECONDS="$healthz_seconds" \
    SUMMARY_READYZ_SECONDS="$readyz_seconds" \
    SUMMARY_STATUS_SECONDS="$status_seconds" \
    SUMMARY_FAILURE_PHASE="$FAILURE_PHASE" \
    SUMMARY_CONFIG_COVERAGE="$CONFIG_COVERAGE_JSON" \
    SUMMARY_WATCH_BASELINE_CONNECT="$WATCH_BASELINE_CONNECT_JSON" \
    SUMMARY_WATCH_BASELINE_STATE="$WATCH_BASELINE_STATE_JSON" \
    SUMMARY_WATCH_CANDIDATE_CONNECT="$WATCH_CANDIDATE_CONNECT_JSON" \
    SUMMARY_WATCH_CANDIDATE_STATE="$WATCH_CANDIDATE_STATE_JSON" \
    SUMMARY_WATCH_RESTART_CONNECT="$WATCH_RESTART_CONNECT_JSON" \
    SUMMARY_WATCH_RESTART_STATE="$WATCH_RESTART_STATE_JSON" \
    SUMMARY_HISTORICAL_PACKAGE_REPLACEMENT="$HISTORICAL_PACKAGE_REPLACEMENT_EVIDENCE" \
    SUMMARY_RESTART_FIXTURE="$restart_fixture_evidence" \
    SUMMARY_RESTART_RUNTIME_FIXTURE="$restart_runtime_evidence" \
    SUMMARY_RESTART_INFERENCE="$restart_inference" \
    node <<'NODE'
const fs = require("node:fs");
const phaseLog = process.env.SUMMARY_PHASE_LOG;
const phases = fs.existsSync(phaseLog)
  ? fs.readFileSync(phaseLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];
const numberOrNull = (value) => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const readJsonOrNull = (file) => {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
const summary = {
  status: process.env.SUMMARY_STATUS,
  baseline: {
    spec: process.env.SUMMARY_BASELINE_SPEC || null,
    version: process.env.SUMMARY_BASELINE_VERSION || null,
  },
  scenario: process.env.SUMMARY_SCENARIO || "base",
  candidate: {
    kind: process.env.OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_KIND || null,
    spec: process.env.OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC || process.env.OPENCLAW_CURRENT_PACKAGE_TGZ || null,
    version: process.env.SUMMARY_CANDIDATE_VERSION || null,
  },
  installedVersion: process.env.SUMMARY_INSTALLED_VERSION || null,
  candidateInstallMode: process.env.SUMMARY_CANDIDATE_INSTALL_MODE || "updater",
  updateRestartMode: process.env.SUMMARY_UPDATE_RESTART_MODE || "manual",
  updateOutcome: process.env.SUMMARY_UPDATE_OUTCOME || "success",
  updateRecovery: process.env.SUMMARY_UPDATE_REPAIR_REQUIRED === "1" ? "capability-consent" : null,
  updateRestartSource: process.env.SUMMARY_UPDATE_RESTART_SOURCE || null,
  restartFixture: readJsonOrNull(process.env.SUMMARY_RESTART_FIXTURE),
  restartRuntimeFixture: readJsonOrNull(process.env.SUMMARY_RESTART_RUNTIME_FIXTURE),
  restartInference: process.env.SUMMARY_RESTART_INFERENCE || null,
  timings: {
    startupSeconds: numberOrNull(process.env.SUMMARY_START_SECONDS),
    updateRestartSeconds: numberOrNull(process.env.SUMMARY_UPDATE_RESTART_SECONDS),
    idempotenceSeconds: numberOrNull(process.env.SUMMARY_IDEMPOTENCE_SECONDS),
    healthzSeconds: numberOrNull(process.env.SUMMARY_HEALTHZ_SECONDS),
    readyzSeconds: numberOrNull(process.env.SUMMARY_READYZ_SECONDS),
    statusSeconds: numberOrNull(process.env.SUMMARY_STATUS_SECONDS),
  },
  config: readJsonOrNull(process.env.SUMMARY_CONFIG_COVERAGE),
  recovery: process.env.SUMMARY_SCENARIO === "recovery-cleanup"
    ? readJsonOrNull(require("node:path").join(require("node:path").dirname(process.env.SUMMARY_JSON), "recovery-evidence.json"))
    : undefined,
  watchosDirectNode: process.env.SUMMARY_SCENARIO === "watchos-direct-node"
    ? {
        contract: {
          signature: "v3",
          clientId: "openclaw-watchos",
          clientMode: "node",
          protocolRange: [4, 4],
          stableInstanceId: "watchos-upgrade-survivor",
          bootstrapAuthField: "bootstrapToken",
          reconnectAuthField: "deviceToken",
        },
        baseline: {
          connect: readJsonOrNull(process.env.SUMMARY_WATCH_BASELINE_CONNECT),
          state: readJsonOrNull(process.env.SUMMARY_WATCH_BASELINE_STATE),
        },
        candidate: {
          connect: readJsonOrNull(process.env.SUMMARY_WATCH_CANDIDATE_CONNECT),
          state: readJsonOrNull(process.env.SUMMARY_WATCH_CANDIDATE_STATE),
        },
        restart: {
          connect: readJsonOrNull(process.env.SUMMARY_WATCH_RESTART_CONNECT),
          state: readJsonOrNull(process.env.SUMMARY_WATCH_RESTART_STATE),
        },
      }
    : undefined,
  historicalPackageReplacement:
    process.env.SUMMARY_CANDIDATE_INSTALL_MODE === "historical-package-replacement"
      ? readJsonOrNull(process.env.SUMMARY_HISTORICAL_PACKAGE_REPLACEMENT)
      : undefined,
  failure: process.env.SUMMARY_STATUS === "passed"
    ? null
    : {
        phase: process.env.SUMMARY_FAILURE_PHASE || null,
        message: process.env.SUMMARY_MESSAGE || null,
      },
  phases,
};
fs.writeFileSync(process.env.SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`);
NODE
}

stop_gateway() {
  if [ -s "$SYSTEMCTL_SHIM_PID_FILE" ]; then
    systemctl --user stop openclaw-gateway.service >/dev/null 2>&1 || true
  fi
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  gateway_pid=""
  if [ -s "$SYSTEMCTL_SHIM_PID_FILE" ]; then
    local shim_pid
    shim_pid="$(cat "$SYSTEMCTL_SHIM_PID_FILE" 2>/dev/null || true)"
    if [[ "$shim_pid" =~ ^[0-9]+$ ]] && [ "$shim_pid" -gt 1 ]; then
      openclaw_e2e_terminate_gateways "$shim_pid"
    fi
  fi
  rm -f "$SYSTEMCTL_SHIM_PID_FILE"
}

watchos_gateway_call() {
  local method="$1"
  local params="$2"
  local output="$3"
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw gateway call "$method" \
    --url "$WATCH_GATEWAY_WS_URL" \
    --token "$GATEWAY_AUTH_TOKEN_REF" \
    --params "$params" \
    --timeout 20000 \
    --json >"$output"
  chmod 600 "$output"
}

watchos_assert_gateway_state() {
  local label="$1"
  local output="$2"
  watchos_gateway_call node.list '{}' "$WATCH_NODES_JSON"
  watchos_gateway_call device.pair.list '{}' "$WATCH_DEVICES_JSON"
  node scripts/e2e/lib/upgrade-survivor/watchos-direct-node.mjs assert-state \
    --state "$WATCH_STATE_JSON" \
    --nodes "$WATCH_NODES_JSON" \
    --devices "$WATCH_DEVICES_JSON" \
    --out "$output" \
    --label "$label"
}

watchos_connect() {
  local mode="$1"
  local credential="$2"
  local output="$3"
  local label="$4"
  local args=(
    scripts/e2e/lib/upgrade-survivor/watchos-direct-node.mjs
    connect
    --mode "$mode"
    --state "$WATCH_STATE_JSON"
    --out "$output"
    --label "$label"
  )
  if [ "$mode" = "bootstrap" ]; then
    args+=(--credential "$credential")
  fi
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" \
    node "${args[@]}"
}

watchos_pair_baseline() {
  mkdir -p "$WATCH_RUNTIME_ROOT"
  chmod 700 "$WATCH_RUNTIME_ROOT"
  start_gateway
  watchos_gateway_call device.pair.setupCode \
    '{"includeQr":false,"bootstrapProfile":"node","publicUrl":"wss://localhost:18789"}' \
    "$WATCH_SETUP_JSON"
  watchos_connect bootstrap "$WATCH_SETUP_JSON" "$WATCH_BASELINE_CONNECT_JSON" baseline
  watchos_assert_gateway_state baseline "$WATCH_BASELINE_STATE_JSON"
  stop_gateway
}

watchos_reconnect_candidate() {
  watchos_connect device "$WATCH_STATE_JSON" "$WATCH_CANDIDATE_CONNECT_JSON" candidate
  watchos_assert_gateway_state candidate "$WATCH_CANDIDATE_STATE_JSON"
}

watchos_reconnect_restarted_candidate() {
  watchos_connect device "$WATCH_STATE_JSON" "$WATCH_RESTART_CONNECT_JSON" restart
  watchos_assert_gateway_state restart "$WATCH_RESTART_STATE_JSON"
}

cleanup() {
  stop_gateway
  openclaw_e2e_stop_process "${plugin_registry_pid:-}"
  openclaw_e2e_stop_process "${clawhub_fixture_pid:-}"
  openclaw_e2e_stop_process "${mock_openai_pid:-}"
  openclaw_e2e_stop_process "${restart_mock_pid:-}"
  openclaw_e2e_stop_process "${restart_registry_pid:-}"
}

on_error() {
  local status="$1"
  FAILURE_PHASE="${CURRENT_PHASE:-unknown}"
  FAILURE_MESSAGE="phase ${FAILURE_PHASE} failed with status ${status}"
  json_event "$FAILURE_PHASE" failed || true
  return "$status"
}

on_signal() {
  local signal="$1"
  local status="$2"
  trap - HUP INT TERM
  FAILURE_PHASE="${CURRENT_PHASE:-unknown}"
  FAILURE_MESSAGE="phase ${FAILURE_PHASE} interrupted by ${signal}"
  FAILURE_SIGNAL="$signal"
  exit "$status"
}

on_exit() {
  local status="$1"
  trap - ERR EXIT HUP INT TERM
  set +e
  if [ "$status" -eq 0 ] && [ "$run_completed" != "1" ]; then
    status=1
    FAILURE_MESSAGE="upgrade survivor exited before all phases completed"
  fi
  # Capture before stop/cleanup can replace the first failing service evidence.
  if [ "$status" -ne 0 ]; then
    node scripts/e2e/lib/upgrade-survivor/diagnostics.mjs capture \
      "$ARTIFACT_ROOT" "${FAILURE_PHASE:-${CURRENT_PHASE:-unknown}}" "$status" "$FAILURE_SIGNAL" "$last_update_observation_root" ||
      echo "Upgrade survivor diagnostics missing; preserving original phase failure." >&3
  fi
  cleanup
  if [ "$status" -eq 0 ] && [ "$run_completed" = "1" ]; then
    write_summary passed ""
  else
    [ -n "$FAILURE_PHASE" ] || FAILURE_PHASE="${CURRENT_PHASE:-unknown}"
    [ -n "$FAILURE_MESSAGE" ] || FAILURE_MESSAGE="upgrade survivor failed with status $status"
    write_summary failed "$FAILURE_MESSAGE"
  fi
  echo "Upgrade survivor summary: $SUMMARY_JSON" >&3
  exit "$status"
}

trap 'on_error $?' ERR
trap 'on_exit $?' EXIT
trap 'on_signal SIGHUP 129' HUP
trap 'on_signal SIGINT 130' INT
trap 'on_signal SIGTERM 143' TERM

phase() {
  local name="$1" phase_status
  shift
  CURRENT_PHASE="$name"
  echo "==> upgrade-survivor:$name"
  json_event "$name" started
  "$@"
  phase_status=$?
  [ "$phase_status" -eq 0 ] || return "$phase_status"
  json_event "$name" passed
  CURRENT_PHASE=""
}

companion_survivor_scenario() {
  [ "$SCENARIO" = "watchos-direct-node" ] || [ "$SCENARIO" = "mobile-pairing-reconnect" ]
}

run_plugin_fixture_phase() {
  companion_survivor_scenario && return 0
  [ "$SCENARIO" = "legacy-operator-state" ] && return 0
  phase "$@"
}

package_root() {
  printf '%s/lib/node_modules/openclaw\n' "$npm_config_prefix"
}

legacy_runtime_deps_symlink_plugin() {
  local plugin="${OPENCLAW_UPGRADE_SURVIVOR_LEGACY_RUNTIME_DEPS_SYMLINK:-}"
  if [ -z "$plugin" ]; then
    return 1
  fi
  case "$plugin" in
    *[!A-Za-z0-9._-]*)
      echo "OPENCLAW_UPGRADE_SURVIVOR_LEGACY_RUNTIME_DEPS_SYMLINK must be a plugin id, got: $plugin" >&2
      return 2
      ;;
  esac
  printf '%s\n' "$plugin"
}

legacy_runtime_deps_symlink_target() {
  local plugin="$1"
  printf '%s/@openclaw-upgrade-survivor/%s-runtime-dep\n' "$(dirname "$(package_root)")" "$plugin"
}

legacy_runtime_deps_symlink_source() {
  local plugin="$1"
  printf '%s/.local/bundled-plugin-runtime-deps/%s-upgrade-survivor/node_modules\n' \
    "$(package_root)" \
    "$plugin"
}

configured_plugin_installs_enabled() {
  [ "$SCENARIO" = "configured-plugin-installs" ] || [ "$SCENARIO" = "sqlite-volume" ]
}

source_only_plugin_shadow_enabled() {
  [ "$SCENARIO" = "stale-source-plugin-shadow" ]
}

seed_source_only_plugin_shadow() {
  source_only_plugin_shadow_enabled || return 0

  local shadow_root="$OPENCLAW_STATE_DIR/extensions/opik-openclaw"
  mkdir -p "$shadow_root/src"
  cat >"$shadow_root/package.json" <<'JSON'
{
  "name": "@opik/opik-openclaw",
  "version": "0.0.0-upgrade-survivor",
  "openclaw": {
    "extensions": ["./src/index.ts"]
  }
}
JSON
  cat >"$shadow_root/openclaw.plugin.json" <<'JSON'
{
  "id": "opik-openclaw",
  "activation": {
    "onStartup": false
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
JSON
  cat >"$shadow_root/src/index.ts" <<'TS'
export default {
  id: "opik-openclaw",
  name: "Source-only Opik shadow",
  register() {},
};
TS
  echo "Seeded source-only plugin shadow: $shadow_root"
}

wait_for_fixture_port() {
  local pid="$1" port_file="$2" log_file="$3" label="$4"
  for _ in $(seq 1 100); do
    [ -s "$port_file" ] && return 0
    openclaw_e2e_process_alive "$pid" || break
    sleep 0.1
  done
  openclaw_e2e_print_log "$log_file" >&2
  echo "Timed out waiting for upgrade survivor $label." >&2
  return 1
}

configure_clawhub_fixture() {
  unset OPENCLAW_CLAWHUB_URL CLAWHUB_URL
  [ -z "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] && return 0
  local fixture_root="$ARTIFACT_ROOT/clawhub-fixture" port_file log_file
  port_file="$fixture_root/port"
  log_file="$fixture_root/server.log"
  mkdir -p "$fixture_root" && rm -f "$port_file"
  node "${OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER:-scripts/e2e/lib/clawhub-fixture-server.cjs}" \
    prepublish-artifacts "$port_file" \
    "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR/prepublish-plugin-registry.json" >"$log_file" 2>&1 &
  clawhub_fixture_pid="$!"
  wait_for_fixture_port "$clawhub_fixture_pid" "$port_file" "$log_file" "ClawHub fixture"
  export OPENCLAW_CLAWHUB_URL="http://127.0.0.1:$(cat "$port_file")"
}

assert_prepublish_fixture_idle() {
  [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] || return 0
  node "${OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER:-scripts/e2e/lib/clawhub-fixture-server.cjs}" \
    assert-no-requests "$OPENCLAW_CLAWHUB_URL"
}

assert_prepublish_plugin_install() {
  local allow_pending="${1:-0}" plugin_id="whatsapp" help consent
  local consent_supported=0 pending_args=()
  if [ "$SCENARIO" = "legacy-operator-state" ]; then
    plugin_id="discord"
  elif configured_plugin_installs_enabled; then
    plugin_id="matrix"
  fi
  help="$(openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw plugins install --help)" || return "$?"
  consent="$(printf '%s' "$help" | node scripts/e2e/lib/package-compat.mjs fixture-consent)" || return "$?"
  [ -z "$consent" ] || consent_supported=1
  if [ "$allow_pending" = "1" ] && [ "$update_repair_required" = "1" ]; then
    pending_args=("$UPDATE_JSON" "$initial_update_observation_root" "$baseline_version")
  fi
  # A served npm primary must match the prepared artifact. An empty ClawHub ledger alone
  # cannot prove installation; explicit ClawHub companion installs have their own audit.
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
    assert-npm-plugin-install "$plugin_id" "@openclaw/$plugin_id" "$candidate_version" \
    "$consent_supported" ${pending_args[@]+"${pending_args[@]}"} || return "$?"
  [ "$SCENARIO" = "legacy-operator-state" ] && return 0
  assert_prepublish_fixture_idle
}

configure_plugin_registry() {
  local stage="${1:-candidate}"
  local fixture_root="$ARTIFACT_ROOT/plugin-registry"
  local package_dir="$fixture_root/package"
  local tarball="$fixture_root/openclaw-brave-plugin-${candidate_version}.tgz"
  local registry_args=()
  local registry_dist_tags="${OPENCLAW_NPM_REGISTRY_DIST_TAGS-}"

  if [ "$SCENARIO" = "legacy-operator-state" ]; then
    if [ "$stage" = "baseline" ]; then
      mkdir -p "$fixture_root/baseline"
      # A moving selector preserves ordinary plugin updates; an exact spec is a pin.
      local baseline_tarball
      baseline_tarball="$(npm pack "@openclaw/discord@$baseline_version" \
        --registry=https://registry.npmjs.org --pack-destination "$fixture_root/baseline" --silent)"
      registry_args+=("@openclaw/discord" "$baseline_version" "$fixture_root/baseline/$baseline_tarball")
      registry_dist_tags="latest=$baseline_version,beta=$baseline_version"
    else
      registry_dist_tags="latest=$candidate_version,beta=$candidate_version"
    fi
    registry_args+=("openclaw" "$candidate_version" "$CANDIDATE_SPEC")
  fi

  if configured_plugin_installs_enabled; then
    mkdir -p "$package_dir"
    FIXTURE_PACKAGE_DIR="$package_dir" FIXTURE_PACKAGE_VERSION="$candidate_version" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FIXTURE_PACKAGE_DIR;
const version = process.env.FIXTURE_PACKAGE_VERSION;
if (!version) {
  throw new Error("missing fixture package version");
}
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(
  path.join(root, "package.json"),
  `${JSON.stringify(
    {
      name: "@openclaw/brave-plugin",
      version,
      openclaw: { extensions: ["./index.js"] },
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(root, "openclaw.plugin.json"),
  `${JSON.stringify(
    {
      id: "brave",
      activation: { onStartup: false },
      setup: { providers: [{ id: "brave", envVars: ["BRAVE_API_KEY"] }] },
      contracts: { webSearchProviders: ["brave"] },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          webSearch: {
            type: "object",
            additionalProperties: false,
            properties: {
              apiKey: { type: ["string", "object"] },
              mode: { type: "string", enum: ["web", "llm-context"] },
              baseUrl: { type: ["string", "object"] },
            },
          },
        },
      },
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(root, "index.js"),
  `module.exports = { id: "brave", name: "Brave Fixture", register() {} };\n`,
);
NODE
    tar -czf "$tarball" -C "$fixture_root" package
    registry_args+=("@openclaw/brave-plugin" "$candidate_version" "$tarball")
  fi

  if [ "${#registry_args[@]}" -eq 0 ]; then
    [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] || return 0
  fi

  if [ "$SCENARIO" = "legacy-operator-state" ]; then
    export OPENCLAW_NPM_REGISTRY_DIST_TAGS="$registry_dist_tags"
  fi
  openclaw_prepublish_plugin_registry_start \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" \
    "${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}" \
    "$candidate_version" \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256:-}" \
    "$fixture_root" \
    plugin_registry_pid \
    "${registry_args[@]}"
}

seed_legacy_runtime_deps_symlink() {
  local plugin
  plugin="$(legacy_runtime_deps_symlink_plugin)" || {
    local status=$?
    [ "$status" -eq 1 ] && return 0
    return "$status"
  }

  local plugin_dir
  plugin_dir="$(package_root)/dist/extensions/$plugin"
  if [ ! -d "$plugin_dir" ]; then
    echo "cannot seed legacy runtime deps symlink; packaged plugin is missing: $plugin_dir" >&2
    return 1
  fi

  local source_dir
  local target_dir
  source_dir="$(legacy_runtime_deps_symlink_source "$plugin")"
  target_dir="$(legacy_runtime_deps_symlink_target "$plugin")"
  mkdir -p "$source_dir"
  mkdir -p "$(dirname "$target_dir")"
  printf '{"name":"openclaw-upgrade-survivor-legacy-runtime-deps","version":"0.0.0"}\n' \
    >"$source_dir/package.json"
  rm -rf "$target_dir"
  ln -s "$source_dir" "$target_dir"
  if [ ! -L "$target_dir" ]; then
    echo "failed to create legacy runtime deps symlink: $target_dir" >&2
    return 1
  fi
  echo "Seeded legacy runtime deps symlink for $plugin: $target_dir -> $source_dir"
}

assert_legacy_runtime_deps_symlink_repaired() {
  local plugin
  plugin="$(legacy_runtime_deps_symlink_plugin)" || {
    local status=$?
    [ "$status" -eq 1 ] && return 0
    return "$status"
  }

  local target_dir source_dir
  target_dir="$(legacy_runtime_deps_symlink_target "$plugin")"
  source_dir="$(legacy_runtime_deps_symlink_source "$plugin")"
  if [ -e "$source_dir" ]; then
    if [ ! -L "$target_dir" ] || [ "$(readlink "$target_dir")" != "$source_dir" ]; then
      echo "valid runtime deps symlink was changed during update/doctor: $target_dir" >&2
      return 1
    fi
  elif [ -L "$target_dir" ]; then
    echo "dangling runtime deps symlink survived update/doctor: $target_dir" >&2
    return 1
  fi
  echo "Runtime deps symlink preserved or repaired according to target existence for $plugin."
}

read_installed_version() {
  node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1] + "/package.json", "utf8")).version' "$(package_root)"
}

storage_preflight() {
  echo "Storage preflight:"
  df -h "$ARTIFACT_ROOT" "$TMPDIR" /tmp || true
}

rm_rf_retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    rm -rf "$@" && return 0
    sleep "$attempt"
  done
  rm -rf "$@"
}

reset_run_state() {
  rm_rf_retry "$npm_config_prefix" "$TMPDIR" "$OPENCLAW_TEST_STATE_TMPDIR" "$STATE_HOME_ROOT"
  rm -f "$SYSTEMCTL_SHIM_PID_FILE" "$SYSTEMCTL_SHIM_DAEMON_LOG"
  mkdir -p "$npm_config_prefix" "$npm_config_cache" "$TMPDIR" "$OPENCLAW_TEST_STATE_TMPDIR"
}

install_baseline() {
  normalize_baseline
  echo "Installing baseline package: $baseline_spec"
  if ! openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix "$npm_config_prefix" "$baseline_spec" --no-fund --no-audit >"$BASELINE_INSTALL_LOG" 2>&1; then
    echo "baseline npm install failed" >&2
    openclaw_e2e_print_log "$BASELINE_INSTALL_LOG" >&2
    return 1
  fi
  if ! command -v openclaw >/dev/null; then
    echo "baseline install did not expose openclaw on PATH" >&2
    echo "PATH=$PATH" >&2
    find "$npm_config_prefix" -maxdepth 3 -type f -o -type l >&2 || true
    return 1
  fi
  installed_version="$(read_installed_version)"
  if [ "$baseline_version_expected" = "1" ] && [ "$installed_version" != "$baseline_version" ]; then
    echo "baseline package version mismatch: expected $baseline_version, got $installed_version" >&2
    cat "$(package_root)/package.json" >&2 || true
    return 1
  fi
  baseline_version="$installed_version"
  local version_output
  if ! version_output="$(openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw --version 2>&1)"; then
    echo "baseline openclaw --version failed" >&2
    echo "$version_output" >&2
    return 1
  fi
  if [[ "$version_output" != *"$baseline_version"* ]]; then
    echo "baseline openclaw --version mismatch: expected output to include $baseline_version" >&2
    echo "$version_output" >&2
    return 1
  fi
}

initialize_state() {
  local account_home=""
  openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_FUNCTION_B64:?missing OPENCLAW_TEST_STATE_FUNCTION_B64}"
  if [ "$ROOT_MANAGED_VPS" = "1" ]; then
    if [ "$(id -u)" -ne 0 ]; then
      echo "root-managed VPS survivor mode must run as uid 0" >&2
      return 1
    fi
    rm -rf /root/.openclaw /root/workspace
    openclaw_test_state_create /root minimal
  else
    openclaw_test_state_create "$STATE_HOME_ROOT" minimal
  fi
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    account_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
    if [ -z "$account_home" ]; then
      echo "Could not resolve the current account home" >&2
      return 1
    fi
    export HOME="$account_home"
    export USERPROFILE="$account_home"
    unset OPENCLAW_HOME
    export OPENCLAW_STATE_DIR="$account_home/.openclaw"
    export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
  fi
  export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION="$baseline_version"
}

seed_state() {
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed
}

apply_baseline_config_recipe() {
  if [ "$SCENARIO" = "legacy-operator-state" ]; then
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed-legacy-operator
    return
  fi
  # Source recipes need the runner's native tsx, not a host dependency mount.
  openclaw_e2e_run_script_entrypoint \
    scripts/e2e/lib/upgrade-survivor/config-recipe apply \
    --summary "$CONFIG_COVERAGE_JSON" \
    --baseline-version "$baseline_version"
}

install_companion_plugins() {
  openclaw_e2e_fixture_plugin_command openclaw -- \
    plugins install "@openclaw/discord@latest"
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-baseline-plugin "$baseline_version"
}

seed_legacy_operator_gateway() {
  export MOCK_REQUEST_LOG="$ARTIFACT_ROOT/legacy-operator-requests.jsonl"
  mock_openai_pid="$(openclaw_e2e_start_mock_openai 44081 "$ARTIFACT_ROOT/legacy-operator-mock.log")"
  openclaw_e2e_wait_mock_openai 44081
  start_gateway
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed-legacy-operator-default-cron
  stop_gateway
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed-legacy-operator-agent
  start_gateway
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed-legacy-operator-gateway
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs legacy-operator-turn baseline
  stop_gateway
}

prepare_schema_expectation() {
  if [ "$CANDIDATE_KIND" != "tarball" ]; then
    echo "legacy-operator-state requires one packed candidate tarball" >&2
    return 1
  fi
  node scripts/e2e/lib/upgrade-survivor/schema-expectation.mjs \
    prepare "$baseline_version" "$CANDIDATE_SPEC" "$OPENCLAW_STATE_DIR" \
    "$ARTIFACT_ROOT/schema-before.json" "$OPENCLAW_CONFIG_PATH"
}

assert_schema_outcome() {
  node scripts/e2e/lib/upgrade-survivor/schema-expectation.mjs assert \
    "$ARTIFACT_ROOT/schema-before.json" "$update_exit_code" "$installed_version" "$update_outcome" \
    "$ARTIFACT_ROOT/schema-after.json"
}

assert_legacy_operator_update_noop() {
  # An explicit tarball requests a refresh; the registry's exact candidate
  # version exercises the operator's already-current path without a reinstall.
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update \
    --tag "$candidate_version" --yes --no-restart --json \
    >"$ARTIFACT_ROOT/update-noop.json" 2>"$ARTIFACT_ROOT/update-noop.err"
  node --input-type=module - "$ARTIFACT_ROOT/update-noop.json" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
const text = fs.readFileSync(process.argv[2], "utf8");
const result = JSON.parse(text.slice(text.indexOf("{")));
assert.equal(result.status, "skipped", "second update was not a clean no-op");
assert.equal(result.reason, "already-current", "second update was not already current");
assert.deepEqual(result.steps, [], "second update executed package mutations");
assert(!result.nextAction, "second update requested repair");
console.log("Second update: already-current, no package mutations or repair required.");
NODE
  assert_survival || return "$?"
  check_gateway_probes
}

assert_legacy_operator_doctor_clean() {
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw doctor --lint --json \
    >"$ARTIFACT_ROOT/doctor-lint.json" 2>"$ARTIFACT_ROOT/doctor-lint.err"
  node --input-type=module - "$ARTIFACT_ROOT/doctor-lint.json" "$STATUS_JSON" "$candidate_version" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.equal(report.ok, true, "Doctor reported an unhealthy candidate");
assert(report.checksRun > 0, "Doctor did not run health checks");
assert.deepEqual(report.findings, [], "Doctor reported unresolved findings");
const gateway = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
assert.equal(gateway.gateway.version, process.argv[4], "Gateway is not serving the candidate version");
console.log(`Doctor clean; Gateway serves candidate ${process.argv[4]}.`);
NODE
}

probe_legacy_operator_migration() {
  start_gateway
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
    assert-legacy-operator-gateway post-update
  stop_gateway
}

configure_watchos_tls_fixture() {
  [ "${SCENARIO:-}" = "watchos-direct-node" ] || return 0
  command -v openssl >/dev/null || {
    echo "watchOS direct-node survivor requires openssl" >&2
    return 1
  }
  mkdir -p "$WATCH_TLS_ROOT"
  chmod 700 "$WATCH_TLS_ROOT"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
    -subj "/CN=OpenClaw watchOS survivor CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$WATCH_TLS_CA_KEY" \
    -out "$WATCH_TLS_CA_CERT" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=localhost" \
    -keyout "$WATCH_TLS_SERVER_KEY" \
    -out "$WATCH_TLS_SERVER_CSR" >/dev/null 2>&1
  printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" >"$WATCH_TLS_SERVER_EXT"
  openssl x509 -req \
    -in "$WATCH_TLS_SERVER_CSR" \
    -CA "$WATCH_TLS_CA_CERT" \
    -CAkey "$WATCH_TLS_CA_KEY" \
    -CAcreateserial \
    -days 1 \
    -sha256 \
    -extfile "$WATCH_TLS_SERVER_EXT" \
    -out "$WATCH_TLS_SERVER_CERT" >/dev/null 2>&1
  chmod 600 "$WATCH_TLS_CA_KEY" "$WATCH_TLS_CA_CERT" "$WATCH_TLS_SERVER_KEY" \
    "$WATCH_TLS_SERVER_CSR" "$WATCH_TLS_SERVER_CERT" "$WATCH_TLS_SERVER_EXT"
  local tls_config
  tls_config="$(
    node -e '
      process.stdout.write(JSON.stringify({
        enabled: true,
        autoGenerate: false,
        certPath: process.argv[1],
        keyPath: process.argv[2],
      }));
    ' "$WATCH_TLS_SERVER_CERT" "$WATCH_TLS_SERVER_KEY"
  )"
  openclaw config set gateway.tls "$tls_config" --strict-json >/dev/null
  export NODE_EXTRA_CA_CERTS="$WATCH_TLS_CA_CERT"
}

validate_baseline_config() {
  if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw config validate >"$BASELINE_CONFIG_VALIDATE_LOG" 2>&1; then
    echo "generated baseline config failed baseline validation" >&2
    openclaw_e2e_print_log "$BASELINE_CONFIG_VALIDATE_LOG" >&2
    return 1
  fi
}

run_mobile_pairing_client() {
  openclaw_e2e_run_script_entrypoint \
    scripts/e2e/lib/upgrade-survivor/mobile-pairing-client \
    "$@"
}

bootstrap_mobile_pairing() {
  if [ "$SCENARIO" != "mobile-pairing-reconnect" ]; then
    return 0
  fi
  mkdir -p "$MOBILE_PAIRING_ROOT"
  chmod 700 "$MOBILE_PAIRING_ROOT"
  : >"$MOBILE_PAIRING_QR_JSON"
  : >"$MOBILE_PAIRING_QR_ERR"
  chmod 600 "$MOBILE_PAIRING_QR_JSON" "$MOBILE_PAIRING_QR_ERR"
  local qr_status=0
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" \
    openclaw qr --json --url ws://127.0.0.1:18789 \
    >"$MOBILE_PAIRING_QR_JSON" 2>"$MOBILE_PAIRING_QR_ERR" || qr_status=$?
  if [ "$qr_status" -ne 0 ]; then
    rm -f "$MOBILE_PAIRING_QR_JSON" "$MOBILE_PAIRING_QR_ERR"
    echo "baseline mobile pairing QR bootstrap failed" >&2
    return "$qr_status"
  fi
  start_gateway
  local bootstrap_status=0
  run_mobile_pairing_client bootstrap \
    --package-root "$(package_root)" \
    --qr-json "$MOBILE_PAIRING_QR_JSON" \
    --credentials "$MOBILE_PAIRING_CREDENTIALS" \
    --evidence "$MOBILE_PAIRING_BASELINE_EVIDENCE" || bootstrap_status=$?
  local stop_status=0
  stop_gateway || stop_status=$?
  rm -f "$MOBILE_PAIRING_QR_JSON" "$MOBILE_PAIRING_QR_ERR"
  if [ "$bootstrap_status" -ne 0 ]; then
    return "$bootstrap_status"
  fi
  return "$stop_status"
}

mobile_pairing_expects_node_surface_reapproval() {
  case "$baseline_version" in
    2026.7.1 | 2026.7.1-*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

verify_mobile_pairing() {
  local phase_name="$1"
  local evidence_file="$2"
  local expect_known_node_surface_reapproval="false"
  if mobile_pairing_expects_node_surface_reapproval; then
    expect_known_node_surface_reapproval="true"
  fi
  run_mobile_pairing_client verify \
    --package-root "$(package_root)" \
    --credentials "$MOBILE_PAIRING_CREDENTIALS" \
    --evidence "$evidence_file" \
    --phase "$phase_name" \
    --expect-known-node-surface-reapproval "$expect_known_node_surface_reapproval"
}

verify_mobile_pairing_once() {
  local phase_name="$1"
  local evidence_file="$2"
  if [ "$SCENARIO" != "mobile-pairing-reconnect" ]; then
    return 0
  fi
  start_gateway || return "$?"
  local verify_status=0
  verify_mobile_pairing "$phase_name" "$evidence_file" || verify_status=$?
  local stop_status=0
  stop_gateway || stop_status=$?
  if [ "$verify_status" -ne 0 ]; then
    return "$verify_status"
  fi
  return "$stop_status"
}

source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$SYSTEMCTL_SHIM_LOG"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$SYSTEMCTL_SHIM_PID_FILE"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$SYSTEMCTL_SHIM_DAEMON_LOG"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON="$BASELINE_SERVICE_INSTALL_JSON"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR="$BASELINE_SERVICE_INSTALL_ERR"

write_update_restart_service_env() {
  mkdir -p "$OPENCLAW_STATE_DIR"
  local dotenv_path="$OPENCLAW_STATE_DIR/.env"
  local tmp_path="$dotenv_path.tmp.$$"
  if [ -f "$dotenv_path" ]; then
    grep -Ev '^(GATEWAY_AUTH_TOKEN_REF|OPENCLAW_CLAWHUB_URL)=' "$dotenv_path" >"$tmp_path" || true
  else
    : >"$tmp_path"
  fi
  # Managed restarts resolve auth and fixture routing from service-owned durable env.
  printf 'GATEWAY_AUTH_TOKEN_REF=%s\n' "$GATEWAY_AUTH_TOKEN_REF" >>"$tmp_path"
  if [ -n "${OPENCLAW_CLAWHUB_URL:-}" ]; then
    printf 'OPENCLAW_CLAWHUB_URL=%s\n' "$OPENCLAW_CLAWHUB_URL" >>"$tmp_path"
  fi
  chmod 600 "$tmp_path"
  mv "$tmp_path" "$dotenv_path"
}

prepare_update_restart_probe() {
  if [ "$UPDATE_RESTART_MODE" != "auto-auth" ]; then
    return 0
  fi
  echo "Preparing configured-auth gateway for automatic update restart."
  install_update_restart_systemctl_shim
  local probe_status=0 restore_status=0
  local authored_config="$RUNTIME_ROOT/baseline-authored-openclaw.json"
  local parking_helper="${OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER:-scripts/e2e/lib/upgrade-survivor/config-parking.mjs}"
  # Bootstrap only service auth; authored plugins must reach the actual updater unchanged.
  # The canonical path stays installed in the unit, with reload off until update owns restart.
  node "$parking_helper" \
    park-restart-probe "$OPENCLAW_CONFIG_PATH" "$authored_config" 18789 || probe_status=$?
  if [ "$probe_status" -eq 0 ]; then
    write_update_restart_service_env || probe_status=$?
  fi
  if [ "$probe_status" -eq 0 ]; then
    run_update_restart_probe_gateway install 18789 "$COMMAND_TIMEOUT" legacy-ready-log-ok || probe_status=$?
  fi
  if [ "$probe_status" -eq 0 ]; then
    local STATUS_JSON="$ARTIFACT_ROOT/baseline-status.json" STATUS_ERR="$ARTIFACT_ROOT/baseline-status.err"
    check_gateway_status || probe_status=$?
  fi
  if [ "$probe_status" -eq 0 ]; then
    if [ -n "${OPENCLAW_CLAWHUB_URL:-}" ]; then
      assert_prepublish_fixture_idle || probe_status=$?
    fi
  fi
  # The installed baseline must be offline before restoring authored config or seeding state.
  stop_update_restart_probe_gateway "$COMMAND_TIMEOUT" || return "$?"
  if [ -e "$authored_config" ]; then
    node "$parking_helper" restore "$OPENCLAW_CONFIG_PATH" "$authored_config" || restore_status=$?
  fi
  if [ "$restore_status" -ne 0 ]; then
    return "$restore_status"
  fi
  if [ "$probe_status" -ne 0 ]; then
    return "$probe_status"
  fi
}

assert_baseline_state() {
  OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE=baseline \
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-exec-approvals || return "$?"
  OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE=baseline \
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config || return "$?"
  OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE=baseline \
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state || return "$?"
}

resolve_candidate_version() {
  if [ -z "$CANDIDATE_SPEC" ]; then
    echo "missing OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC" >&2
    return 1
  fi
  case "$CANDIDATE_KIND" in
    tarball)
      candidate_version="$(
        node -e '
          const { execFileSync } = require("node:child_process");
          const packageJson = execFileSync("tar", ["-xOf", process.argv[1], "package/package.json"], {
            encoding: "utf8",
          });
          process.stdout.write(JSON.parse(packageJson).version);
        ' "$CANDIDATE_SPEC"
      )"
      ;;
    npm)
      candidate_version="$(npm view "$CANDIDATE_SPEC" version --silent)"
      ;;
    *)
      echo "unknown candidate kind: $CANDIDATE_KIND" >&2
      return 1
      ;;
  esac
  if [ -z "$candidate_version" ]; then
    echo "could not resolve candidate version from $CANDIDATE_KIND:$CANDIDATE_SPEC" >&2
    return 1
  fi
  OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(
    node scripts/e2e/lib/package-compat.mjs "$candidate_version"
  )"
  export OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT
}

resolve_candidate_install_mode() {
  candidate_install_mode="updater"
  if [ "$SCENARIO" = "mobile-pairing-reconnect" ] &&
    [ "$baseline_version" = "2026.7.1" ] &&
    [ "$candidate_version" = "2026.8.1" ] &&
    [ "${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}" = "$HISTORICAL_MOBILE_PAIRING_CANDIDATE_SHA" ]; then
    candidate_install_mode="historical-package-replacement"
  fi
}

prepare_candidate_tarball() {
  [ -n "$candidate_tarball" ] && return 0
  if [ "$CANDIDATE_KIND" = "tarball" ]; then
    candidate_tarball="${CANDIDATE_SPEC#file:}"
    return 0
  fi
  local package_dir
  package_dir="$(mktemp -d "$RUNTIME_ROOT/candidate-package.XXXXXX")" || return "$?"
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" npm pack "$CANDIDATE_SPEC" \
    --ignore-scripts --json --pack-destination "$package_dir" >"$package_dir/pack.json" || return "$?"
  candidate_tarball="$(node - "$package_dir" "$candidate_version" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [dir, expected] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(path.join(dir, "pack.json"), "utf8"));
if (!Array.isArray(result) || result.length !== 1 || result[0].name !== "openclaw" || result[0].version !== expected || typeof result[0].filename !== "string" || !result[0].filename.endsWith(".tgz") || path.basename(result[0].filename) !== result[0].filename) {
  throw new Error("Packed candidate identity differs from the selected release");
}
process.stdout.write(path.join(dir, result[0].filename));
NODE
  )" || return "$?"
}

candidate_update_spec() {
  if [ "$CANDIDATE_KIND" != "tarball" ]; then
    printf '%s\n' "$CANDIDATE_SPEC"
    return 0
  fi
  case "$CANDIDATE_SPEC" in
    file:*)
      printf '%s\n' "$CANDIDATE_SPEC"
      ;;
    *)
      printf 'file:%s\n' "$CANDIDATE_SPEC"
      ;;
  esac
}

update_candidate() {
  local after_repair="${1:-0}"
  local expected_version="${3:-$candidate_version}"
  local update_json="$UPDATE_JSON" update_err="$UPDATE_ERR"
  local observation_root
  # The old parent need not join its child. A fresh directory keeps a late exit
  # or the recovery update from substituting another invocation's observation.
  observation_root="$(mktemp -d "$ARTIFACT_ROOT/update-observation.XXXXXX")"
  last_update_observation_root="$observation_root"
  if [ "$after_repair" != "1" ]; then
    initial_update_observation_root="$observation_root"
  fi
  if [ "$after_repair" = "1" ]; then
    update_json="$ARTIFACT_ROOT/recovery-update.json"
    update_err="$ARTIFACT_ROOT/recovery-update.err"
  fi
  local update_spec
  update_spec="${2:-}"
  if [ -z "$update_spec" ]; then
    update_spec="$(candidate_update_spec)"
  fi
  echo "Updating baseline $baseline_spec to target $CANDIDATE_KIND:$update_spec ($expected_version)"
  local update_start=""
  local update_end=""
  local previous_service_pid="" previous_systemctl_lines=0 verify_restart=0
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ] && {
    [ "$after_repair" = "1" ] ||
    [ "$SCENARIO" = "legacy-operator-state" ]
  }; then
    verify_restart=1
    previous_service_pid="$(cat "$SYSTEMCTL_SHIM_PID_FILE")"
    previous_systemctl_lines="$(wc -l <"$SYSTEMCTL_SHIM_LOG")"
  fi
  local update_args=(update --tag "$update_spec" --yes --json)
  local update_env=(
    env
    -u OPENCLAW_GATEWAY_TOKEN
    -u OPENCLAW_GATEWAY_PASSWORD
    -u OPENCLAW_ALLOW_ROOT
  )
  # Historical updaters can restart before reporting denied capabilities.
  # Prove migrations first; only the current updater performs the auth restart.
  if [ "$verify_restart" != "1" ]; then
    update_args+=(--no-restart)
  else
    update_start="$(node -e "process.stdout.write(String(Date.now()))")"
  fi
  if [ "$ROOT_MANAGED_VPS" != "1" ]; then
    update_env+=(OPENCLAW_ALLOW_ROOT=1)
  fi
  update_env+=(
    "OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT=$observation_root"
    "NODE_OPTIONS=${NODE_OPTIONS:+$NODE_OPTIONS }--import=$PWD/scripts/e2e/lib/upgrade-survivor/diagnostics.mjs"
  )
  local update_status=0
  if [ "$SCENARIO" = "recovery-cleanup" ]; then
    # Keep sampler output outside the old updater's JSON and join its process group.
    openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" node scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs \
      "$ARTIFACT_ROOT/recovery-resources.tsv" update -- bash -c \
      'out="$1"; err="$2"; shift 2; exec "$@" >"$out" 2>"$err"' recovery-update \
      "$update_json" "$update_err" "${update_env[@]}" openclaw "${update_args[@]}" \
      >"$ARTIFACT_ROOT/recovery-update-metrics.log" 2>&1 || update_status=$?
  else
    openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${update_env[@]}" openclaw "${update_args[@]}" >"$update_json" 2>"$update_err" || update_status=$?
  fi
  # The package swap can precede a failed Doctor. Observe installed bytes before
  # classifying the result; an unreadable package must not retain the baseline.
  installed_version="$(read_installed_version)" || installed_version=""
  update_exit_code="$update_status"
  if [ "$after_repair" != "1" ] && [ "$update_status" -le 1 ] && node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
    assert-recoverable-update-json "$update_json" "$expected_version" "$observation_root" "$baseline_version" >"$ARTIFACT_ROOT/update-result-check.log" 2>&1; then
    update_repair_required="1"
    update_outcome="recoverable"
  elif [ "$update_status" -eq 0 ] && node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
    assert-successful-update-json "$update_json" "$expected_version" "$observation_root"; then
    update_outcome="success"
  else
    echo "openclaw update failed before the recoverable post-core boundary" >&2
    local validate_status=0
    openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw config validate --json >"$POST_UPDATE_VALIDATE_JSON" 2>"$POST_UPDATE_VALIDATE_ERR" || validate_status=$?
    echo "post-update config validation probe status=$validate_status" >&2
    openclaw_e2e_print_log "$POST_UPDATE_VALIDATE_ERR" >&2 || true
    openclaw_e2e_print_log "$POST_UPDATE_VALIDATE_JSON" >&2 || true
    openclaw_e2e_print_log "$update_err" >&2 || true
    openclaw_e2e_print_log "$update_json" >&2 || true
    [ "$update_status" -ne 0 ] || update_status=1
    return "$update_status"
  fi
  if [ "$verify_restart" = "1" ]; then
    update_end="$(node -e "process.stdout.write(String(Date.now()))")"
    update_restart_seconds=$(((update_end - update_start + 999) / 1000))
    # Accepted plugin warnings do not waive this invocation's restart proof.
    assert_update_restart_service_replaced "$previous_service_pid" "$previous_systemctl_lines" || return 1
    update_restart_source="candidate-update"
    if [ "$SCENARIO" = "legacy-operator-state" ]; then
      update_restart_source="baseline-update"
    elif [ "$update_repair_required" = "1" ]; then
      update_restart_source="candidate-after-repair"
    elif [ "$expected_version" != "$candidate_version" ]; then
      update_restart_source="candidate-to-future"
    fi
  fi
  if [ "$installed_version" != "$expected_version" ]; then
    echo "update did not leave the selected target installed: $installed_version (expected $expected_version)" >&2
    return 1
  fi
}

replace_historical_mobile_pairing_candidate() {
  local update_spec
  update_spec="$(candidate_update_spec)"
  local live_package
  live_package="$(package_root)"
  local npm_prefix
  npm_prefix="$(dirname "$(dirname "$(dirname "$live_package")")")"
  local install_status=0

  if [ "$live_package" != "$npm_prefix/lib/node_modules/openclaw" ]; then
    echo "historical package replacement could not derive the npm prefix" >&2
    return 1
  fi
  echo "Replacing baseline $baseline_spec with candidate $CANDIDATE_KIND:$update_spec through npm without updater or Doctor"
  openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" \
    npm install -g --prefix "$npm_prefix" "$update_spec" --no-fund --no-audit \
    >"$UPDATE_ERR" 2>&1 || install_status=$?
  if [ "$install_status" -ne 0 ]; then
    echo "historical mobile pairing package replacement failed" >&2
    openclaw_e2e_print_log "$UPDATE_ERR" >&2
    return "$install_status"
  fi

  installed_version="$(read_installed_version)"
  if [ "$installed_version" != "$candidate_version" ]; then
    echo "historical package replacement did not leave the candidate installed: $installed_version" >&2
    return 1
  fi
  UPDATE_BEFORE_VERSION="$baseline_version" \
    UPDATE_AFTER_VERSION="$installed_version" \
    node <<'NODE' >"$UPDATE_JSON"
const result = {
  status: "ok",
  mode: "historical-package-replacement",
  before: { version: process.env.UPDATE_BEFORE_VERSION },
  after: { version: process.env.UPDATE_AFTER_VERSION },
  updaterRun: false,
  doctorRun: false,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
NODE
  chmod 600 "$UPDATE_JSON" "$UPDATE_ERR"
}

update_candidate_for_install_mode() {
  case "$candidate_install_mode" in
    updater)
      update_candidate
      ;;
    historical-package-replacement)
      replace_historical_mobile_pairing_candidate
      ;;
    *)
      echo "unknown candidate install mode: $candidate_install_mode" >&2
      return 1
      ;;
  esac
}

assert_historical_package_replacement_prestart() {
  CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
    UPDATE_PATH="$UPDATE_JSON" \
    EVIDENCE_PATH="$HISTORICAL_PACKAGE_REPLACEMENT_EVIDENCE" \
    BASELINE_VERSION="$baseline_version" \
    CANDIDATE_VERSION="$candidate_version" \
    node <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
const update = JSON.parse(fs.readFileSync(process.env.UPDATE_PATH, "utf8"));
if (
  update.status !== "ok" ||
  update.mode !== "historical-package-replacement" ||
  update.updaterRun !== false ||
  update.doctorRun !== false
) {
  throw new Error("historical package replacement evidence changed");
}
if (!Object.hasOwn(config.meta ?? {}, "lastTouchedAt")) {
  throw new Error("historical package replacement did not preserve the baseline metadata defect");
}
const evidence = {
  mode: "historical-package-replacement",
  baselineVersion: process.env.BASELINE_VERSION,
  candidateVersion: process.env.CANDIDATE_VERSION,
  updaterRun: false,
  doctorRunBeforeCandidateStart: false,
  legacyLastTouchedAtPresentBeforeCandidateStart: true,
  legacyLastTouchedAtPresentAfterCandidateStart: null,
  candidateStartupRepairObserved: null,
};
fs.writeFileSync(process.env.EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
fs.chmodSync(process.env.EVIDENCE_PATH, 0o600);
NODE
}

assert_historical_package_replacement_startup_repair() {
  CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
    EVIDENCE_PATH="$HISTORICAL_PACKAGE_REPLACEMENT_EVIDENCE" \
    node <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
if (Object.hasOwn(config.meta ?? {}, "lastTouchedAt")) {
  throw new Error("candidate startup did not repair retired meta.lastTouchedAt");
}
const evidence = JSON.parse(fs.readFileSync(process.env.EVIDENCE_PATH, "utf8"));
evidence.legacyLastTouchedAtPresentAfterCandidateStart = false;
evidence.candidateStartupRepairObserved = true;
fs.writeFileSync(process.env.EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
fs.chmodSync(process.env.EVIDENCE_PATH, 0o600);
NODE
  assert_survival || return "$?"
}

assert_root_managed_vps_cli_usable() {
  if [ "$ROOT_MANAGED_VPS" != "1" ]; then
    return 0
  fi
  local root_cli_env=(
    env
    -u OPENCLAW_GATEWAY_TOKEN
    -u OPENCLAW_GATEWAY_PASSWORD
    -u OPENCLAW_ALLOW_ROOT
  )
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${root_cli_env[@]}" openclaw config file >"$ARTIFACT_ROOT/root-vps-config-file.out" 2>"$ARTIFACT_ROOT/root-vps-config-file.err"
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${root_cli_env[@]}" openclaw plugins >"$ARTIFACT_ROOT/root-vps-plugins.out" 2>"$ARTIFACT_ROOT/root-vps-plugins.err"
}

run_doctor() {
  if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw doctor --fix --non-interactive >"$DOCTOR_LOG" 2>&1; then
    echo "openclaw doctor failed" >&2
    openclaw_e2e_print_log "$DOCTOR_LOG" >&2
    return 1
  fi
}

prepare_restart_inference() {
  if [ "$LIVE_OPENAI" = "1" ]; then
    export OPENAI_API_KEY="$LIVE_OPENAI_API_KEY"
    restart_inference="live-openai"
    return 0
  fi
  restart_mock_pid="$(MOCK_REQUEST_LOG="$ARTIFACT_ROOT/restart-model-requests.jsonl" \
    openclaw_e2e_start_mock_openai 44213 "$ARTIFACT_ROOT/restart-model.log")" || return "$?"
  openclaw_e2e_wait_mock_openai 44213 || return "$?"
  node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai 44213 || return "$?"
  restart_inference="mock-openai"
}

prepare_restart_fixture() {
  prepare_candidate_tarball || return "$?"
  local fixture_dir fixture_package runtime_source
  fixture_dir="$(mktemp -d "$RUNTIME_ROOT/restart-fixture.XXXXXX")" || return "$?"
  fixture_package="$fixture_dir/future.tgz"
  node scripts/e2e/lib/update-first-hop-package-fixtures.mjs future-tarball \
    "$candidate_tarball" "$fixture_package" >"$fixture_dir/receipt.json" || return "$?"
  restart_fixture_version="$(node -p 'require(process.argv[1]).targetVersion' "$fixture_dir/receipt.json")" || return "$?"
  mv "$fixture_dir/receipt.json" "$ARTIFACT_ROOT/restart-fixture.json" || return "$?"
  restart_fixture_evidence="$ARTIFACT_ROOT/restart-fixture.json"
  restart_fixture_package="$fixture_package"
  runtime_source="$(node - "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:?managed restart requires the candidate plugin registry}" "$candidate_version" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [root, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "prepublish-plugin-registry.json"), "utf8"));
const entry = manifest.packages.find((item) => item.name === "@openclaw/codex" && item.version === version);
if (!entry) throw new Error("Sealed candidate registry is missing its matching Codex runtime");
const file = path.resolve(root, entry.tarball);
if (crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== entry.sha256) {
  throw new Error("Candidate runtime artifact digest differs from the sealed registry");
}
process.stdout.write(file);
NODE
  )" || return "$?"
  node scripts/e2e/lib/update-first-hop-package-fixtures.mjs future-runtime-tarball \
    "$runtime_source" "$fixture_dir/codex.tgz" >"$fixture_dir/runtime-receipt.json" || return "$?"
  mv "$fixture_dir/runtime-receipt.json" "$ARTIFACT_ROOT/restart-runtime-fixture.json" || return "$?"
  restart_runtime_evidence="$ARTIFACT_ROOT/restart-runtime-fixture.json"
  # The runtime is version-bound to its host. Serve the matching synthetic
  # cohort without changing the sealed candidate registry or its identity.
  OPENCLAW_NPM_REGISTRY_UPSTREAM="$NPM_CONFIG_REGISTRY" \
    openclaw_prepublish_plugin_registry_start \
      "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR" \
      "${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}" "$candidate_version" \
      "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256:-}" \
      "$fixture_dir/registry" restart_registry_pid \
      "@openclaw/codex" "$restart_fixture_version" "$fixture_dir/codex.tgz" || return "$?"
}

repair_update_restart_auth() {
  [ "$SCENARIO" = "legacy-operator-state" ] && return 0
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    # Historical preservation has already passed. This separate current-runtime
    # update needs a configured inference route for its real serving receipt.
    phase prepare-restart-inference prepare_restart_inference || return "$?"
    phase prepare-restart-fixture prepare_restart_fixture || return "$?"
    # Native service clients do not forward the newly created fixture registry.
    phase prepare-restart-manager install_update_restart_systemctl_shim || return "$?"
    # Start is preparation only. The following updater must replace this exact
    # supervisor itself; its existing replacement and auth assertions remain required.
    phase prepare-recovery-service run_update_restart_probe_gateway start 18789 "$COMMAND_TIMEOUT"
    local preparation_status=$?
    [ "$preparation_status" -eq 0 ] || return "$preparation_status"
    local STATUS_JSON="$ARTIFACT_ROOT/prepared-status.json" STATUS_ERR="$ARTIFACT_ROOT/prepared-status.err"
    phase prepared-gateway-auth check_gateway_status
    local auth_status=$?
    [ "$auth_status" -eq 0 ] || return "$auth_status"
    phase recovery-update-restart update_candidate 1 "file:$restart_fixture_package" "$restart_fixture_version"
    local recovery_status=$?
    [ "$recovery_status" -eq 0 ] || return "$recovery_status"
    if [ "$SCENARIO" != "watchos-direct-node" ] && [ "$SCENARIO" != "mobile-pairing-reconnect" ]; then
      phase assert-restart-serving-turn node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
        assert-restart-serving-turn "$ARTIFACT_ROOT/restart-serving-turn.json" || return "$?"
      survival_assert_stage="post-inference"
    fi
    assert_survival || return "$?"
    if [ "$update_repair_required" = "1" ]; then
      node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
        assert-recovered-plugin-installs "$UPDATE_JSON" "$candidate_version" "$initial_update_observation_root" "$baseline_version"
    fi
  fi
}

repair_fixture_plugin_consent() {
  if [ "$update_repair_required" = "1" ]; then
    # Migration assertions run first: explicit fixture consent must not conceal a
    # broken doctor migration. The candidate owns staged-artifact acceptance.
    if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update repair \
      --accept-capabilities --yes --no-restart --json >"$REPAIR_JSON" 2>"$ARTIFACT_ROOT/repair.err"; then
      echo "openclaw update repair failed" >&2
      openclaw_e2e_print_log "$ARTIFACT_ROOT/repair.err" >&2
      openclaw_e2e_print_log "$REPAIR_JSON" >&2
      return 1
    fi
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-repair-json "$REPAIR_JSON" || return "$?"
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
      assert-recovered-plugin-installs "$UPDATE_JSON" "$candidate_version" "$initial_update_observation_root" "$baseline_version" || return "$?"
    assert_survival || return "$?"
  fi
  repair_update_restart_auth || return "$?"
  if [ -n "${OPENCLAW_CLAWHUB_URL:-}" ]; then
    phase assert-prepublish-recovery-requests assert_prepublish_plugin_install
  fi
}

assert_volume_idempotence() {
  local started_at budget
  started_at="$(date +%s)"
  if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw doctor --fix --non-interactive >>"$DOCTOR_LOG" 2>&1; then
    echo "openclaw idempotence doctor failed" >&2
    openclaw_e2e_print_log "$DOCTOR_LOG" >&2
    return 1
  fi
  idempotence_seconds=$(($(date +%s) - started_at))
  budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_VOLUME_IDEMPOTENCE_BUDGET_SECONDS 60)"
  echo "SQLite volume idempotence doctor completed in ${idempotence_seconds}s (budget ${budget}s)."
  if [ "$idempotence_seconds" -gt "$budget" ]; then
    echo "SQLite volume idempotence exceeded budget: ${idempotence_seconds}s > ${budget}s" >&2
    return 1
  fi
  OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE="$survival_assert_stage" \
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state
}

validate_post_doctor_config() {
  if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw config validate >>"$DOCTOR_LOG" 2>&1; then
    echo "post-doctor config validation failed" >&2
    openclaw_e2e_print_log "$DOCTOR_LOG" >&2
    return 1
  fi
}

assert_survival() {
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-exec-approvals || return "$?"
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config || return "$?"
  OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE="$survival_assert_stage" \
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state || return "$?"
  installed_version="$(read_installed_version)" || return "$?"
  if [ "$baseline_version" = "2026.9.2" ] && [ "$candidate_version" = "2026.9.3" ]; then
    node scripts/e2e/lib/external-package-transition.mjs schema 16 \
      >"$ARTIFACT_ROOT/schema-after-update.json" || return "$?"
  fi
  local expected_version="${restart_fixture_version:-$candidate_version}"
  if [ "$installed_version" != "$expected_version" ]; then
    echo "selected package version mismatch: expected $expected_version, got $installed_version" >&2
    return 1
  fi
}

probe_gateway_endpoint() {
  local path="$1"
  local expect_kind="$2"
  local out_file="$3"
  local start_epoch
  local end_epoch
  local gateway_http_url="http://127.0.0.1:18789"
  if [ "${SCENARIO:-}" = "watchos-direct-node" ]; then
    gateway_http_url="$WATCH_GATEWAY_HTTP_URL"
  fi
  local args=(
    --base-url "$gateway_http_url"
    --path "$path"
    --expect "$expect_kind"
  )
  if [ -n "${OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING:-}" ]; then
    args+=(--allow-failing "$OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING")
  fi
  if [ "${OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED:-}" = "1" ]; then
    args+=(--allow-degraded-ready)
  fi
  args+=(--out "$out_file")
  start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  # Command substitution does not inherit errexit; preserve the probe failure.
  node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs "${args[@]}" || return "$?"
  end_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  printf '%s\n' "$(((end_epoch - start_epoch + 999) / 1000))"
}

start_gateway() {
  local port=18789
  local budget
  budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"
  local start_epoch
  local ready_epoch
  start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway --port "$port" --bind loopback --allow-unconfigured >"$GATEWAY_LOG" 2>&1 &
  gateway_pid="$!"
  local readiness_mode="strict"
  if [ "${SCENARIO:-}" = "watchos-direct-node" ]; then
    readiness_mode="legacy-ready-log-ok"
  fi
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360 "$port" "$readiness_mode" || return "$?"
  ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
  if [ "$start_seconds" -gt "$budget" ]; then
    echo "gateway startup exceeded survivor budget: ${start_seconds}s > ${budget}s" >&2
    openclaw_e2e_print_log "$GATEWAY_LOG" >&2
    return 1
  fi
}

ensure_gateway_started() {
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    return 0
  fi
  start_gateway
}

check_gateway_probes() {
  healthz_seconds="$(probe_gateway_endpoint /healthz live "$HEALTHZ_JSON")"
  readyz_seconds="$(probe_gateway_endpoint /readyz ready "$READYZ_JSON")"
}

check_gateway_status() {
  local port=18789
  local gateway_ws_url="ws://127.0.0.1:$port"
  if [ "${SCENARIO:-}" = "watchos-direct-node" ]; then
    gateway_ws_url="$WATCH_GATEWAY_WS_URL"
  fi
  local budget
  budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"
  local status_start
  local status_end
  status_start="$(node -e "process.stdout.write(String(Date.now()))")"
  local auth_args=(--token "$GATEWAY_AUTH_TOKEN_REF")
  if [ "$SCENARIO" = "mobile-pairing-reconnect" ]; then
    auth_args=(--password "$GATEWAY_AUTH_PASSWORD_REF")
  fi
  if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw gateway status --url "$gateway_ws_url" "${auth_args[@]}" --require-rpc --timeout 30000 --json >"$STATUS_JSON" 2>"$STATUS_ERR"; then
    echo "gateway status failed" >&2
    openclaw_e2e_print_log "$STATUS_ERR" >&2
    openclaw_e2e_print_log "$GATEWAY_LOG" >&2
    return 1
  fi
  status_end="$(node -e "process.stdout.write(String(Date.now()))")"
  status_seconds=$(((status_end - status_start + 999) / 1000))
  if [ "$status_seconds" -gt "$budget" ]; then
    echo "gateway status exceeded survivor budget: ${status_seconds}s > ${budget}s" >&2
    openclaw_e2e_print_log "$STATUS_JSON" >&2
    return 1
  fi
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-status-json "$STATUS_JSON"
}

run_live_openai() {
  local marker="OPENCLAW_UPGRADE_SURVIVOR_LIVE_OK"
  local model="${OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_MODEL:-openai/gpt-5.5}"
  local timeout_seconds
  local status=0
  timeout_seconds="$(
    openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_TIMEOUT_SECONDS 180
  )"
  stop_gateway
  (
    unset OPENCLAW_SKIP_PROVIDERS
    export OPENAI_API_KEY="$LIVE_OPENAI_API_KEY"
    openclaw_e2e_maybe_timeout "${timeout_seconds}s" \
      openclaw agent \
      --local \
      --agent main \
      --session-id upgrade-survivor-live-openai \
      --model "$model" \
      --message "Reply with exactly $marker and no other text." \
      --thinking off \
      --timeout "$timeout_seconds" \
      --json
  ) >"$LIVE_OPENAI_JSON" 2>"$LIVE_OPENAI_ERR" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "live OpenAI survivor turn failed" >&2
    openclaw_e2e_print_log "$LIVE_OPENAI_ERR" >&2
    openclaw_e2e_print_log "$LIVE_OPENAI_JSON" >&2
    return "$status"
  fi
  node --input-type=module - "$marker" "$LIVE_OPENAI_JSON" <<'NODE'
import { assertAgentReplyContainsMarker } from "./scripts/e2e/lib/agent-turn-output.mjs";
assertAgentReplyContainsMarker(process.argv[2], process.argv[3]);
NODE
}

phase storage-preflight storage_preflight
phase validate-update-restart-mode validate_update_restart_mode
phase reset-run-state reset_run_state
phase install-baseline install_baseline
phase initialize-state initialize_state
if [ "$SCENARIO" = "abandoned-update" ]; then
  source scripts/e2e/lib/upgrade-survivor/abandoned-update.sh
  run_abandoned_update_survivor
  run_completed="1"
  exit 0
fi
phase apply-baseline-config-recipe apply_baseline_config_recipe
if [ "$SCENARIO" = "watchos-direct-node" ]; then
  phase configure-watchos-tls configure_watchos_tls_fixture
fi
phase validate-baseline-config validate_baseline_config
phase resolve-candidate resolve_candidate_version
phase resolve-candidate-install-mode resolve_candidate_install_mode
if companion_survivor_scenario || [ "$SCENARIO" = "legacy-operator-state" ]; then
  unset OPENCLAW_CLAWHUB_URL CLAWHUB_URL
else
  phase configure-clawhub-fixture configure_clawhub_fixture
fi
phase prepare-update-restart-probe prepare_update_restart_probe
phase bootstrap-mobile-pairing bootstrap_mobile_pairing
# Start the published baseline before adding migration specimens: its startup
# guards correctly reject them, and baseline Doctor would consume candidate proof.
phase seed-state seed_state
if [ "$SCENARIO" = "legacy-operator-state" ]; then
  phase configure-baseline-plugin-registry configure_plugin_registry baseline
  phase install-companion-plugin install_companion_plugins
  phase seed-legacy-operator-gateway seed_legacy_operator_gateway
  openclaw_e2e_stop_process "$plugin_registry_pid"
  phase configure-candidate-plugin-registry configure_plugin_registry
fi
run_plugin_fixture_phase install-baseline-plugin-dependencies install_baseline_plugin_dependencies
run_plugin_fixture_phase seed-legacy-plugin-dependency-debris seed_legacy_plugin_dependency_debris
run_plugin_fixture_phase assert-legacy-plugin-dependency-debris assert_legacy_plugin_dependency_debris_present
run_plugin_fixture_phase seed-source-only-plugin-shadow seed_source_only_plugin_shadow
if [ "$SCENARIO" = "sqlite-volume" ]; then
  phase seed-baseline-shared-state node scripts/e2e/lib/upgrade-survivor/sqlite-volume-shared-state.mjs \
    seed-baseline-plugin-state "$(package_root)"
  phase seed-volume-state node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed-volume
  phase validate-volume-baseline-config validate_baseline_config
fi
phase assert-baseline assert_baseline_state
if [ "$SCENARIO" = "watchos-direct-node" ]; then
  phase watchos-baseline-pair watchos_pair_baseline
fi
if [ "$SCENARIO" = "recovery-cleanup" ]; then
  phase seed-recovery-state node scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs seed
fi
run_plugin_fixture_phase seed-legacy-runtime-deps-symlink seed_legacy_runtime_deps_symlink
if [ "$SCENARIO" = "recovery-cleanup" ]; then
  if [ "$CANDIDATE_KIND" != "tarball" ]; then
    echo "recovery-cleanup requires one packed candidate tarball" >&2
    exit 1
  fi
  phase recovery-package-evidence node scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs packages "$baseline_spec" "$CANDIDATE_SPEC"
fi
run_plugin_fixture_phase configure-plugin-registry configure_plugin_registry
if [ "$SCENARIO" = "legacy-operator-state" ]; then
  phase prepare-schema-expectation prepare_schema_expectation
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    phase prepare-baseline-update-manager install_update_restart_systemctl_shim
    phase prepare-baseline-update-service run_update_restart_probe_gateway start 18789 "$COMMAND_TIMEOUT"
  fi
  # Reload is disabled: retain the serving baseline while reproducing missing-plugin config.
  phase seed-formerly-bundled-plugin node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
    seed-legacy-operator-external-plugin
fi
phase update-candidate update_candidate_for_install_mode
if [ "$SCENARIO" = "legacy-operator-state" ]; then
  phase assert-formerly-bundled-plugin node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
    assert-npm-plugin-install duckduckgo @openclaw/duckduckgo-plugin "$candidate_version" 1
  phase assert-formerly-bundled-plugin-config node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
    assert-legacy-operator-external-plugin "$candidate_version"
  phase assert-candidate-schemas assert_schema_outcome
fi
if [ "$candidate_install_mode" = "historical-package-replacement" ]; then
  phase assert-historical-package-replacement-prestart \
    assert_historical_package_replacement_prestart
else
  # A standalone Doctor pass would conceal missing migrations in the updater.
  phase assert-automatic-migration assert_survival
fi
if [ "$SCENARIO" = "legacy-operator-state" ]; then
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    phase legacy-operator-first-hop-cron node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
      assert-legacy-operator-gateway post-update
  else
    phase legacy-operator-first-hop-cron probe_legacy_operator_migration
  fi
fi
phase mobile-pairing-candidate-first verify_mobile_pairing_once \
  candidate-first "$MOBILE_PAIRING_CANDIDATE_FIRST_EVIDENCE"
if [ "$candidate_install_mode" = "historical-package-replacement" ]; then
  phase assert-historical-package-replacement-startup-repair \
    assert_historical_package_replacement_startup_repair
fi
phase mobile-pairing-candidate-restart verify_mobile_pairing_once \
  candidate-restart "$MOBILE_PAIRING_CANDIDATE_RESTART_EVIDENCE"
if [ "$SCENARIO" = "recovery-cleanup" ]; then
  phase assert-recovery-migration node scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs migrated
fi
if [ -n "${OPENCLAW_CLAWHUB_URL:-}" ]; then
  run_plugin_fixture_phase assert-prepublish-requests assert_prepublish_plugin_install 1
fi
phase root-managed-vps-cli-usable assert_root_managed_vps_cli_usable
run_plugin_fixture_phase assert-package-local-dependency-cleanup assert_legacy_plugin_dependency_debris_cleaned
if [ "$SCENARIO" != "sqlite-volume" ] && [ "$SCENARIO" != "recovery-cleanup" ] && [ "$SCENARIO" != "legacy-operator-state" ]; then
  phase doctor run_doctor
fi
run_plugin_fixture_phase assert-legacy-plugin-dependency-debris-cleaned assert_legacy_plugin_dependency_debris_cleaned
run_plugin_fixture_phase assert-legacy-runtime-deps-symlink-repaired assert_legacy_runtime_deps_symlink_repaired
phase validate-post-doctor-config validate_post_doctor_config
phase assert-survival assert_survival
run_plugin_fixture_phase fixture-plugin-consent repair_fixture_plugin_consent
if [ "$SCENARIO" = "legacy-operator-state" ]; then
  phase fixture-plugin-consent repair_fixture_plugin_consent
fi
if companion_survivor_scenario; then
  repair_update_restart_auth
fi
if [ "$SCENARIO" = "recovery-cleanup" ]; then
  phase recovery-custom-restore node scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs custom-restore
fi
if [ "$SCENARIO" = "meeting-transcripts-sqlite" ]; then
  # Export recreates the archived source path. Finish every repeated survival
  # check before exercising the explicit artifact materialization command.
  phase transcript-export node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-meeting-transcript-export
fi
phase gateway-start ensure_gateway_started
phase gateway-probes check_gateway_probes
phase gateway-status check_gateway_status
if [ "$SCENARIO" = "legacy-operator-state" ]; then
  phase legacy-operator-cron-owners node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
    assert-legacy-operator-gateway candidate
  phase legacy-operator-agent-turn node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
    legacy-operator-turn candidate
  phase legacy-operator-plugin assert_prepublish_plugin_install
  phase legacy-operator-update-noop assert_legacy_operator_update_noop
  phase legacy-operator-doctor-clean assert_legacy_operator_doctor_clean
  phase formerly-bundled-doctor node scripts/e2e/lib/upgrade-survivor/formerly-bundled-plugin-doctor.mjs \
    "$candidate_version"
fi
if [ "$SCENARIO" = "watchos-direct-node" ]; then
  phase watchos-candidate-reconnect watchos_reconnect_candidate
  phase gateway-stop stop_gateway
  phase gateway-restart start_gateway
  phase gateway-restart-probes check_gateway_probes
  phase gateway-restart-status check_gateway_status
  phase watchos-restart-reconnect watchos_reconnect_restarted_candidate
  phase assert-restarted-survival assert_survival
fi
if [ "$SCENARIO" = "mobile-pairing-reconnect" ]; then
  phase mobile-pairing-final verify_mobile_pairing final "$MOBILE_PAIRING_FINAL_EVIDENCE"
  phase mobile-pairing-credential-continuity \
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-mobile-pairing-evidence \
    "$MOBILE_PAIRING_BASELINE_EVIDENCE" \
    "$MOBILE_PAIRING_CANDIDATE_FIRST_EVIDENCE" \
    "$MOBILE_PAIRING_CANDIDATE_RESTART_EVIDENCE" \
    "$MOBILE_PAIRING_FINAL_EVIDENCE"
fi
if [ "$SCENARIO" = "recovery-cleanup" ]; then
  phase recovery-live node scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs live
  phase gateway-stop stop_gateway
  phase recovery-offline node scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs offline
  phase gateway-restart start_gateway
  phase gateway-restart-probes check_gateway_probes
  phase gateway-restart-status check_gateway_status
  phase recovery-restarted node scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs restarted
  phase assert-restarted-survival assert_survival
fi
if [ "$SCENARIO" = "sqlite-volume" ]; then
  phase gateway-volume-history node scripts/e2e/lib/upgrade-survivor/probe-volume-gateway.mjs \
    --url ws://127.0.0.1:18789 --out "$ARTIFACT_ROOT/volume-gateway.json"
  phase gateway-stop stop_gateway
  phase assert-volume-idempotence assert_volume_idempotence
  phase gateway-restart start_gateway
  phase gateway-restart-probes check_gateway_probes
  phase gateway-restart-volume-history node scripts/e2e/lib/upgrade-survivor/probe-volume-gateway.mjs \
    --url ws://127.0.0.1:18789 --out "$ARTIFACT_ROOT/volume-gateway-restarted.json"
  phase assert-restarted-survival assert_survival
fi
if [ "$LIVE_OPENAI" = "1" ]; then
  phase live-openai run_live_openai
fi

run_completed="1"
echo "Upgrade survivor Docker E2E passed baseline=${baseline_spec} scenario=${SCENARIO} candidate=${candidate_version} updateRestartMode=${UPDATE_RESTART_MODE} idempotence=${idempotence_seconds:-n/a}s startup=${start_seconds}s updateRestart=${update_restart_seconds:-manual}s healthz=${healthz_seconds}s readyz=${readyz_seconds}s status=${status_seconds}s."
