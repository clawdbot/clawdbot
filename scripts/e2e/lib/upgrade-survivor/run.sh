#!/usr/bin/env bash
set -Eeuo pipefail
# Signal traps inherit the foreground command's redirections. Keep harness stdout separate so the
# final summary location cannot corrupt a command artifact when the run is interrupted.
exec 3>&1

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/prepublish-plugin-registry.sh

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
export OPENAI_API_KEY="sk-openclaw-upgrade-survivor"
export DISCORD_BOT_TOKEN="upgrade-survivor-discord-token"
export TELEGRAM_BOT_TOKEN="123456:upgrade-survivor-telegram-token"
if [ "$SCENARIO" = "feishu-channel" ]; then
  export FEISHU_APP_SECRET="upgrade-survivor-feishu-secret"
fi
if [ "$SCENARIO" = "configured-plugin-installs" ] || [ "$SCENARIO" = "sqlite-volume" ]; then
  export MATRIX_ACCESS_TOKEN="upgrade-survivor-matrix-token"
  export BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"
fi

ARTIFACT_ROOT="$(dirname "${OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON:-/tmp/openclaw-upgrade-survivor-artifacts/summary.json}")"
export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="${OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT:-/tmp/openclaw-upgrade-survivor-runtime}"
RUNTIME_ROOT="$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT"
STATE_HOME_ROOT="${OPENCLAW_UPGRADE_SURVIVOR_STATE_HOME_ROOT:-$RUNTIME_ROOT/state-home}"
mkdir -p "$ARTIFACT_ROOT"
mkdir -p "$RUNTIME_ROOT"
export TMPDIR="${OPENCLAW_UPGRADE_SURVIVOR_TMPDIR:-$RUNTIME_ROOT/tmp}"
export OPENCLAW_TEST_STATE_TMPDIR="${OPENCLAW_UPGRADE_SURVIVOR_TEST_STATE_TMPDIR:-$RUNTIME_ROOT/state-tmp}"
mkdir -p "$TMPDIR" "$OPENCLAW_TEST_STATE_TMPDIR"
export npm_config_prefix="$ARTIFACT_ROOT/npm-prefix"
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
ROOT_MANAGED_VPS="${OPENCLAW_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS:-0}"
COMMAND_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"
CURRENT_PHASE="setup"
FAILURE_PHASE=""
FAILURE_MESSAGE=""
gateway_pid=""
plugin_registry_pid=""
clawhub_fixture_pid=""
baseline_spec=""
baseline_version=""
baseline_version_expected="0"
candidate_version=""
installed_version=""
start_seconds=""
status_seconds=""
healthz_seconds=""
readyz_seconds=""
update_restart_seconds=""
migration_seconds=""
idempotence_seconds=""
run_completed="0"

BASELINE_INSTALL_LOG="$ARTIFACT_ROOT/baseline-install.log"
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/post-update-validate.json"
POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/post-update-validate.err"
DOCTOR_LOG="$ARTIFACT_ROOT/doctor.log"
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
PREPUBLISH_AUTHORED_CONFIG="$RUNTIME_ROOT/prepublish-authored-openclaw.json"
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
    SUMMARY_SCENARIO="$SCENARIO" \
    SUMMARY_UPDATE_RESTART_MODE="$UPDATE_RESTART_MODE" \
    SUMMARY_START_SECONDS="$start_seconds" \
    SUMMARY_UPDATE_RESTART_SECONDS="$update_restart_seconds" \
    SUMMARY_MIGRATION_SECONDS="$migration_seconds" \
    SUMMARY_IDEMPOTENCE_SECONDS="$idempotence_seconds" \
    SUMMARY_HEALTHZ_SECONDS="$healthz_seconds" \
    SUMMARY_READYZ_SECONDS="$readyz_seconds" \
    SUMMARY_STATUS_SECONDS="$status_seconds" \
    SUMMARY_FAILURE_PHASE="$FAILURE_PHASE" \
    SUMMARY_CONFIG_COVERAGE="$CONFIG_COVERAGE_JSON" \
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
  updateRestartMode: process.env.SUMMARY_UPDATE_RESTART_MODE || "manual",
  timings: {
    startupSeconds: numberOrNull(process.env.SUMMARY_START_SECONDS),
    updateRestartSeconds: numberOrNull(process.env.SUMMARY_UPDATE_RESTART_SECONDS),
    migrationSeconds: numberOrNull(process.env.SUMMARY_MIGRATION_SECONDS),
    idempotenceSeconds: numberOrNull(process.env.SUMMARY_IDEMPOTENCE_SECONDS),
    healthzSeconds: numberOrNull(process.env.SUMMARY_HEALTHZ_SECONDS),
    readyzSeconds: numberOrNull(process.env.SUMMARY_READYZ_SECONDS),
    statusSeconds: numberOrNull(process.env.SUMMARY_STATUS_SECONDS),
  },
  config: readJsonOrNull(process.env.SUMMARY_CONFIG_COVERAGE),
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

cleanup() {
  stop_gateway
  openclaw_e2e_stop_process "${plugin_registry_pid:-}"
  openclaw_e2e_stop_process "${clawhub_fixture_pid:-}"
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
  exit "$status"
}

on_exit() {
  local status="$1"
  trap - ERR EXIT HUP INT TERM
  set +e
  cleanup
  if [ "$status" -eq 0 ] && [ "$run_completed" = "1" ]; then
    write_summary passed ""
  else
    if [ "$status" -eq 0 ]; then
      status=1
      FAILURE_MESSAGE="upgrade survivor exited before all phases completed"
    fi
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
  local name="$1"
  shift
  CURRENT_PHASE="$name"
  echo "==> upgrade-survivor:$name"
  json_event "$name" started
  "$@"
  json_event "$name" passed
  CURRENT_PHASE=""
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

plugin_deps_cleanup_enabled() {
  [ "$SCENARIO" = "plugin-deps-cleanup" ]
}

plugin_deps_cleanup_plugins() {
  printf '%s\n' "${OPENCLAW_UPGRADE_SURVIVOR_PLUGIN_DEPS_CLEANUP_PLUGINS:-discord telegram}"
}

plugin_deps_cleanup_plugin_dirs() {
  local plugin="$1"
  printf '%s\n' \
    "$(package_root)/dist/extensions/$plugin" \
    "$(package_root)/extensions/$plugin"
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

prepublish_auto_auth_enabled() {
  [ "$UPDATE_RESTART_MODE" = "auto-auth" ] &&
    [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]
}

park_prepublish_authored_config() {
  prepublish_auto_auth_enabled || return 0
  node "${OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER:-scripts/e2e/lib/upgrade-survivor/config-parking.mjs}" \
    park-prepublish "$OPENCLAW_CONFIG_PATH" "$PREPUBLISH_AUTHORED_CONFIG"
}

assert_prepublish_fixture_idle() {
  prepublish_auto_auth_enabled || return 0
  node "${OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER:-scripts/e2e/lib/clawhub-fixture-server.cjs}" \
    assert-no-requests "$OPENCLAW_CLAWHUB_URL"
}

restore_prepublish_authored_config() {
  prepublish_auto_auth_enabled || return 0
  node "${OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER:-scripts/e2e/lib/upgrade-survivor/config-parking.mjs}" \
    restore "$OPENCLAW_CONFIG_PATH" "$PREPUBLISH_AUTHORED_CONFIG"
}

configure_plugin_registry() {
  local fixture_root="$ARTIFACT_ROOT/plugin-registry"
  local package_dir="$fixture_root/package"
  local tarball="$fixture_root/openclaw-brave-plugin-${candidate_version}.tgz"
  local registry_args=()

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

  openclaw_prepublish_plugin_registry_start \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" \
    "${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}" \
    "$candidate_version" \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256:-}" \
    "$fixture_root" \
    plugin_registry_pid \
    "${registry_args[@]}"
}

legacy_plugin_dependency_probe_paths() {
  local plugin="$1"
  local plugin_dir
  while IFS= read -r plugin_dir; do
    printf '%s\n' \
      "$plugin_dir/node_modules" \
      "$plugin_dir/.openclaw-runtime-deps.json" \
      "$plugin_dir/.openclaw-runtime-deps-stamp.json" \
      "$plugin_dir/.openclaw-runtime-deps-copy-upgrade-survivor" \
      "$plugin_dir/.openclaw-install-stage-upgrade-survivor" \
      "$plugin_dir/.openclaw-pnpm-store"
  done < <(plugin_deps_cleanup_plugin_dirs "$plugin")
  printf '%s\n' \
    "$(package_root)/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor" \
    "$OPENCLAW_STATE_DIR/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor" \
    "$OPENCLAW_STATE_DIR/plugin-runtime-deps/$plugin-upgrade-survivor"
}

install_baseline_plugin_dependencies() {
  plugin_deps_cleanup_enabled || return 0
  echo "Skipping baseline doctor for plugin dependency cleanup scenario; candidate doctor owns stale dependency cleanup."
}

seed_legacy_plugin_dependency_debris() {
  plugin_deps_cleanup_enabled || return 0

  local found=0
  local plugin
  for plugin in $(plugin_deps_cleanup_plugins); do
    local plugin_dir
    plugin_dir=""
    local candidate_dir
    while IFS= read -r candidate_dir; do
      if [ -d "$candidate_dir" ]; then
        plugin_dir="$candidate_dir"
        break
      fi
    done < <(plugin_deps_cleanup_plugin_dirs "$plugin")
    [ -n "$plugin_dir" ] || continue
    found=1
    mkdir -p \
      "$plugin_dir/node_modules/openclaw-upgrade-survivor-dep" \
      "$plugin_dir/.openclaw-runtime-deps-copy-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep" \
      "$plugin_dir/.openclaw-install-stage-upgrade-survivor" \
      "$plugin_dir/.openclaw-pnpm-store" \
      "$(package_root)/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep" \
      "$OPENCLAW_STATE_DIR/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep" \
      "$OPENCLAW_STATE_DIR/plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$plugin_dir/node_modules/openclaw-upgrade-survivor-dep/package.json"
    printf '{"plugin":"%s","scenario":"plugin-deps-cleanup"}\n' "$plugin" \
      >"$plugin_dir/.openclaw-runtime-deps.json"
    printf '{"plugin":"%s","scenario":"plugin-deps-cleanup","stale":true}\n' "$plugin" \
      >"$plugin_dir/.openclaw-runtime-deps-stamp.json"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$plugin_dir/.openclaw-runtime-deps-copy-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$(package_root)/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$OPENCLAW_STATE_DIR/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
    printf '{"name":"openclaw-upgrade-survivor-dep","version":"0.0.0"}\n' \
      >"$OPENCLAW_STATE_DIR/plugin-runtime-deps/$plugin-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
    echo "Seeded legacy plugin dependency debris for configured plugin: $plugin"
  done

  if [ "$found" -ne 1 ]; then
    echo "plugin-deps-cleanup scenario could not find a packaged Discord or Telegram plugin directory" >&2
    find "$(package_root)/dist" -maxdepth 3 -type d 2>/dev/null >&2 || true
    find "$(package_root)/extensions" -maxdepth 2 -type d 2>/dev/null >&2 || true
    return 1
  fi
}

assert_legacy_plugin_dependency_debris_present() {
  plugin_deps_cleanup_enabled || return 0

  local found
  found="$(legacy_plugin_dependency_debris_count)"
  if [ "$found" -eq 0 ]; then
    echo "plugin-deps-cleanup scenario did not create legacy plugin dependency debris" >&2
    return 1
  fi
}

legacy_plugin_dependency_debris_count() {
  local found=0
  local plugin
  for plugin in $(plugin_deps_cleanup_plugins); do
    local probe
    while IFS= read -r probe; do
      if [ -e "$probe" ] || [ -L "$probe" ]; then
        found=1
      fi
    done < <(legacy_plugin_dependency_probe_paths "$plugin")
  done
  printf '%s\n' "$found"
}

assert_legacy_plugin_dependency_debris_before_doctor() {
  plugin_deps_cleanup_enabled || return 0

  local found
  found="$(legacy_plugin_dependency_debris_count)"
  if [ "$found" -eq 0 ]; then
    echo "Legacy plugin dependency debris was already removed before doctor; post-doctor cleanup assertion will verify it stays gone."
  else
    echo "Legacy plugin dependency debris survived update and will be cleaned by doctor."
  fi
}

assert_legacy_plugin_dependency_debris_cleaned() {
  plugin_deps_cleanup_enabled || return 0

  local remaining=0
  local plugin
  for plugin in $(plugin_deps_cleanup_plugins); do
    local probe
    while IFS= read -r probe; do
      if [ -e "$probe" ] || [ -L "$probe" ]; then
        echo "legacy plugin dependency debris survived update/doctor: $probe" >&2
        remaining=1
      fi
    done < <(legacy_plugin_dependency_probe_paths "$plugin")
  done
  if [ "$remaining" -ne 0 ]; then
    return 1
  fi
  echo "Legacy plugin dependency debris cleaned for configured plugin dependencies."
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

  local target_dir
  target_dir="$(legacy_runtime_deps_symlink_target "$plugin")"
  if [ -L "$target_dir" ]; then
    echo "legacy runtime deps symlink survived update/doctor: $target_dir -> $(readlink "$target_dir")" >&2
    return 1
  fi
  echo "Legacy runtime deps symlink repaired for $plugin."
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

seed_state() {
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
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed
}

apply_baseline_config_recipe() {
  local tsx_import="${OPENCLAW_UPGRADE_SURVIVOR_TSX_IMPORT:-tsx}"
  local recipe_runner=(
    node --import "$tsx_import" scripts/e2e/lib/upgrade-survivor/config-recipe.mts
  )
  if [ ! -f scripts/e2e/lib/upgrade-survivor/config-recipe.mts ]; then
    recipe_runner=(node scripts/e2e/lib/upgrade-survivor/config-recipe.mjs)
  fi
  "${recipe_runner[@]}" apply \
    --summary "$CONFIG_COVERAGE_JSON" \
    --baseline-version "$baseline_version"
}

validate_baseline_config() {
  if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw config validate >"$BASELINE_CONFIG_VALIDATE_LOG" 2>&1; then
    echo "generated baseline config failed baseline validation" >&2
    openclaw_e2e_print_log "$BASELINE_CONFIG_VALIDATE_LOG" >&2
    return 1
  fi
}

install_update_restart_systemctl_shim() {
  local shim_dir="$npm_config_prefix/bin"
  mkdir -p "$shim_dir"
  cat >"$shim_dir/systemctl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail

log_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG:-/tmp/openclaw-systemctl-shim.log}"
pid_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE:-/tmp/openclaw-systemctl-shim.pid}"
daemon_log="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG:-/tmp/openclaw-systemctl-shim-gateway.log}"
supervisor_script="${pid_file}.supervisor.mjs"
printf '%s\n' "$*" >>"$log_file"

filtered=()
system_scope=1
property=""
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  case "$arg" in
    --user)
      system_scope=0
      ;;
    --quiet | --no-page | --now | --value)
      ;;
    --property)
      i=$((i + 1))
      property="${!i}"
      ;;
    --property=*)
      property="${arg#--property=}"
      ;;
    *)
      filtered+=("$arg")
      ;;
  esac
done

command="${filtered[0]:-status}"

is_running() {
  [ -s "$pid_file" ] || return 1
  local pid stat_line stat_tail
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  stat_line="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
  stat_tail="${stat_line##*) }"
  [[ "$stat_line" == "$pid ("*") $stat_tail" &&
    "$stat_tail" =~ ^Z([[:space:]]+-?[0-9]+){49,}$ ]] && return 1
  return 0
}

stop_gateway() {
  local pid=""
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    # The supervisor gives its child 30s, so keep this outer deadline comfortably longer.
    for _ in $(seq 1 350); do
      is_running || break
      sleep 0.1
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file" "$supervisor_script"
}

unit_path() {
  printf '%s/.config/systemd/user/openclaw-gateway.service\n' "${HOME:?missing HOME}"
}

load_unit_environment() {
  local unit="$1"
  while IFS= read -r line; do
    case "$line" in
      EnvironmentFile=*)
        local spec="${line#EnvironmentFile=}"
        for token in $spec; do
          local file="${token#-}"
          [ -f "$file" ] || continue
          set -a
          # shellcheck disable=SC1090
          . "$file"
          set +a
        done
        ;;
      Environment=*)
        local assignment="${line#Environment=}"
        assignment="${assignment#\"}"
        assignment="${assignment%\"}"
        export "$assignment"
        ;;
    esac
  done <"$unit"
}

start_gateway() {
  local unit
  local exec_start
  unit="$(unit_path)"
  exec_start="$(sed -n 's/^ExecStart=//p' "$unit" | tail -n 1)"
  [ -n "$exec_start" ] || {
    echo "systemctl shim could not find ExecStart in $unit" >&2
    return 1
  }
  rm -f "$pid_file" "$supervisor_script"
  cat >"$supervisor_script" <<'SUPERVISOR'
import fs from "node:fs";
import { spawn } from "node:child_process";

const command = process.env.OPENCLAW_SYSTEMCTL_SHIM_EXEC_START;
const daemonLog = process.env.OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG;
if (!command || !daemonLog) {
  process.exit(2);
}

const output = fs.openSync(daemonLog, "a");
const childEnv = { ...process.env };
delete childEnv.OPENCLAW_SYSTEMCTL_SHIM_EXEC_START;
delete childEnv.OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG;
// systemd does not pass transient systemctl-caller update state into the service.
for (const key of Object.keys(childEnv)) {
  if (key.startsWith("OPENCLAW_UPDATE_")) {
    delete childEnv[key];
  }
}
delete childEnv.OPENCLAW_COMPATIBILITY_HOST_VERSION;
const restartDelayMs = 5_000;
const restartWindowMs = 60_000;
const restartBurst = 5;
const stopTimeoutMs = 30_000;
const starts = [];
let child;
let activeGroupPid;
let drainingGroupPid;
let stopping = false;

const finish = () => {
  try {
    fs.closeSync(output);
  } catch {}
  process.exit(0);
};

const signalProcessGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      fs.writeSync(output, `[systemctl-shim] gateway process group ${signal} failed: ${String(error)}\n`);
    }
  }
};

const isProcessGroupRunning = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const drainProcessGroup = (pid, onStopped) => {
  if (!pid) return onStopped();
  if (drainingGroupPid === pid) return;
  drainingGroupPid = pid;
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    if (drainingGroupPid === pid) drainingGroupPid = undefined;
    if (activeGroupPid === pid) activeGroupPid = undefined;
    onStopped();
  };
  signalProcessGroup(pid, "SIGTERM");
  const forceKill = setTimeout(() => {
    signalProcessGroup(pid, "SIGKILL");
    complete();
  }, stopTimeoutMs);
  const finishWhenStopped = () => {
    if (completed) return;
    if (isProcessGroupRunning(pid)) {
      setTimeout(finishWhenStopped, 25);
      return;
    }
    clearTimeout(forceKill);
    complete();
  };
  finishWhenStopped();
};

const stop = () => {
  if (stopping) return;
  stopping = true;
  if (drainingGroupPid) return;
  if (activeGroupPid) {
    drainProcessGroup(activeGroupPid, finish);
    return;
  }
  if (child) {
    child.kill("SIGTERM");
    return;
  }
  finish();
};

const start = () => {
  if (stopping) return finish();
  const now = Date.now();
  while (starts.length > 0 && starts[0] <= now - restartWindowMs) {
    starts.shift();
  }
  if (starts.length >= restartBurst) {
    fs.writeSync(output, "[systemctl-shim] gateway restart limit reached\n");
    return finish();
  }
  starts.push(now);
  child = spawn("bash", ["-lc", `exec ${command}`], {
    detached: true,
    env: childEnv,
    stdio: ["ignore", output, output],
  });
  activeGroupPid = child.pid;
  const childGroupPid = activeGroupPid;
  child.on("error", (error) => {
    fs.writeSync(output, `[systemctl-shim] gateway spawn failed: ${String(error)}\n`);
  });
  child.once("close", (code) => {
    child = undefined;
    drainProcessGroup(childGroupPid, () => {
      if (stopping) return finish();
      // Match the generated systemd unit's RestartPreventExitStatus contract.
      if (code === 78) return finish();
      setTimeout(start, restartDelayMs);
    });
  });
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
start();
SUPERVISOR
  (
    load_unit_environment "$unit"
    OPENCLAW_SYSTEMCTL_SHIM_EXEC_START="$exec_start" \
      OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG="$daemon_log" \
      nohup node "$supervisor_script" </dev/null >/dev/null 2>&1 &
    printf '%s\n' "$!" >"$pid_file"
  )
}

case "$command" in
  daemon-reload | enable | disable)
    exit 0
    ;;
  status)
    is_running && exit 0
    exit 0
    ;;
  stop)
    stop_gateway
    exit 0
    ;;
  restart | start)
    stop_gateway
    start_gateway
    exit 0
    ;;
  is-enabled)
    exit 0
    ;;
  is-active)
    is_running && exit 0
    exit 3
    ;;
  show)
    if [ "$system_scope" = "1" ]; then
      case "$property" in
        LoadState)
          printf 'not-found\n'
          ;;
        UnitPath)
          printf '/etc/systemd/system /usr/lib/systemd/system\n'
          ;;
        *)
          echo "systemctl shim unsupported system-scope show: $*" >&2
          exit 1
          ;;
      esac
      exit 0
    fi
    if is_running; then
      printf 'ActiveState=active\nSubState=running\nMainPID=%s\nExecMainStatus=0\nExecMainCode=0\n' "$(cat "$pid_file")"
    else
      printf 'ActiveState=inactive\nSubState=dead\nMainPID=0\nExecMainStatus=0\nExecMainCode=0\n'
    fi
    exit 0
    ;;
  *)
    echo "systemctl shim unsupported command: $*" >&2
    exit 1
    ;;
esac
SHIM
  chmod +x "$shim_dir/systemctl"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$SYSTEMCTL_SHIM_LOG"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$SYSTEMCTL_SHIM_PID_FILE"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$SYSTEMCTL_SHIM_DAEMON_LOG"
  export PATH="$shim_dir:$PATH"
}

install_update_restart_service_unit() {
  if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway install --force --json >"$BASELINE_SERVICE_INSTALL_JSON" 2>"$BASELINE_SERVICE_INSTALL_ERR"; then
    echo "baseline gateway service install failed" >&2
    openclaw_e2e_print_log "$BASELINE_SERVICE_INSTALL_ERR" >&2
    openclaw_e2e_print_log "$BASELINE_SERVICE_INSTALL_JSON" >&2
    return 1
  fi
}

seed_update_restart_probe_device_auth() {
  node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.OPENCLAW_STATE_DIR;
if (!stateDir) {
  throw new Error("missing OPENCLAW_STATE_DIR");
}

const base64UrlEncode = (buf) =>
  buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
const rawPublicKey =
  spki.length === ed25519SpkiPrefix.length + 32 &&
  spki.subarray(0, ed25519SpkiPrefix.length).equals(ed25519SpkiPrefix)
    ? spki.subarray(ed25519SpkiPrefix.length)
    : spki;
const publicKeyRaw = base64UrlEncode(rawPublicKey);
const deviceId = crypto.createHash("sha256").update(rawPublicKey).digest("hex");
const token = base64UrlEncode(crypto.randomBytes(32));
const now = Date.now();
const scopes = ["operator.read"];

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort inside Docker
  }
}

writeJson(path.join(stateDir, "identity", "device.json"), {
  version: 1,
  deviceId,
  publicKeyPem,
  privateKeyPem,
  createdAtMs: now,
});
writeJson(path.join(stateDir, "identity", "device-auth.json"), {
  version: 1,
  deviceId,
  tokens: {
    operator: {
      token,
      role: "operator",
      scopes,
      updatedAtMs: now,
    },
  },
});
writeJson(path.join(stateDir, "devices", "paired.json"), {
  [deviceId]: {
    deviceId,
    publicKey: publicKeyRaw,
    displayName: "upgrade survivor restart probe",
    platform: process.platform,
    clientId: "upgrade-survivor",
    clientMode: "probe",
    role: "operator",
    roles: ["operator"],
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: {
        token,
        role: "operator",
        scopes,
        createdAtMs: now,
      },
    },
    createdAtMs: now,
    approvedAtMs: now,
  },
});
writeJson(path.join(stateDir, "devices", "pending.json"), {});
NODE
}

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
  seed_update_restart_probe_device_auth
  park_prepublish_authored_config
  local probe_status=0
  start_gateway legacy-ready-log-ok || probe_status=$?
  if [ "$probe_status" -eq 0 ]; then
    assert_prepublish_fixture_idle || probe_status=$?
  fi
  local restore_status=0
  restore_prepublish_authored_config || restore_status=$?
  if [ "$probe_status" -ne 0 ]; then
    return "$probe_status"
  fi
  if [ "$restore_status" -ne 0 ]; then
    return "$restore_status"
  fi
  assert_baseline_state
  write_update_restart_service_env
  install_update_restart_service_unit
}

assert_baseline_state() {
  OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE=baseline \
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config
  OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE=baseline \
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state
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

assert_update_json_ok() {
  local file="$1"
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const raw = fs.readFileSync(file, "utf8");
    let result;
    try {
      result = JSON.parse(raw);
    } catch (err) {
      // Published baselines may emit legacy service-control logs before the JSON payload.
      const jsonStart = raw.indexOf("{");
      if (jsonStart === -1) {
        throw err;
      }
      result = JSON.parse(raw.slice(jsonStart));
    }
    if (!result || result.status !== "ok") {
      throw new Error(`update JSON did not report ok status: ${JSON.stringify(result)}`);
    }
  ' "$file"
}

update_candidate() {
  local update_spec
  update_spec="$(candidate_update_spec)"
  echo "Updating baseline $baseline_spec to candidate $CANDIDATE_KIND:$update_spec ($candidate_version)"
  local update_start=""
  local update_end=""
  local update_args=(update --tag "$update_spec" --yes --json)
  local update_env=(
    env
    -u OPENCLAW_GATEWAY_TOKEN
    -u OPENCLAW_GATEWAY_PASSWORD
    -u OPENCLAW_ALLOW_ROOT
  )
  if [ "$UPDATE_RESTART_MODE" = "manual" ]; then
    update_args+=(--no-restart)
  else
    update_start="$(node -e "process.stdout.write(String(Date.now()))")"
  fi
  if [ "$ROOT_MANAGED_VPS" != "1" ]; then
    update_env+=(OPENCLAW_ALLOW_ROOT=1)
  fi
  local update_status=0
  openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${update_env[@]}" openclaw "${update_args[@]}" >"$UPDATE_JSON" 2>"$UPDATE_ERR" || update_status=$?
  if [ "$update_status" -ne 0 ]; then
    echo "openclaw update failed" >&2
    local validate_status=0
    openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw config validate --json >"$POST_UPDATE_VALIDATE_JSON" 2>"$POST_UPDATE_VALIDATE_ERR" || validate_status=$?
    echo "post-update config validation probe status=$validate_status" >&2
    openclaw_e2e_print_log "$POST_UPDATE_VALIDATE_ERR" >&2 || true
    openclaw_e2e_print_log "$POST_UPDATE_VALIDATE_JSON" >&2 || true
    openclaw_e2e_print_log "$UPDATE_ERR" >&2 || true
    openclaw_e2e_print_log "$UPDATE_JSON" >&2 || true
    return "$update_status"
  fi
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    update_end="$(node -e "process.stdout.write(String(Date.now()))")"
    update_restart_seconds=$(((update_end - update_start + 999) / 1000))
    assert_update_json_ok "$UPDATE_JSON"
  fi
  installed_version="$(read_installed_version)"
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
  local started_at budget
  started_at="$(date +%s)"
  if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw doctor --fix --non-interactive >"$DOCTOR_LOG" 2>&1; then
    echo "openclaw doctor failed" >&2
    openclaw_e2e_print_log "$DOCTOR_LOG" >&2
    return 1
  fi
  if [ "$SCENARIO" = "sqlite-volume" ]; then
    migration_seconds=$(($(date +%s) - started_at))
    budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_VOLUME_MIGRATION_BUDGET_SECONDS 120)"
    echo "SQLite volume migration doctor completed in ${migration_seconds}s (budget ${budget}s)."
    if [ "$migration_seconds" -gt "$budget" ]; then
      echo "SQLite volume migration exceeded budget: ${migration_seconds}s > ${budget}s" >&2
      return 1
    fi
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
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state
  installed_version="$(read_installed_version)"
  if [ "$installed_version" != "$candidate_version" ]; then
    echo "candidate package version mismatch: expected $candidate_version, got $installed_version" >&2
    return 1
  fi
}

probe_gateway_endpoint() {
  local path="$1"
  local expect_kind="$2"
  local out_file="$3"
  local start_epoch
  local end_epoch
  local args=(
    --base-url "http://127.0.0.1:18789"
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
  node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs "${args[@]}"
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
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    printf '%s\n' "$gateway_pid" >"$SYSTEMCTL_SHIM_PID_FILE"
  fi
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360 "$port" "${1:-strict}"
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
  local budget
  budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"
  local status_start
  local status_end
  status_start="$(node -e "process.stdout.write(String(Date.now()))")"
  if ! openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw gateway status --url "ws://127.0.0.1:$port" --token "$GATEWAY_AUTH_TOKEN_REF" --require-rpc --timeout 30000 --json >"$STATUS_JSON" 2>"$STATUS_ERR"; then
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
phase seed-state seed_state
phase apply-baseline-config-recipe apply_baseline_config_recipe
phase validate-baseline-config validate_baseline_config
phase install-baseline-plugin-dependencies install_baseline_plugin_dependencies
phase seed-legacy-plugin-dependency-debris seed_legacy_plugin_dependency_debris
phase assert-legacy-plugin-dependency-debris assert_legacy_plugin_dependency_debris_present
phase seed-source-only-plugin-shadow seed_source_only_plugin_shadow
if [ "$SCENARIO" = "sqlite-volume" ]; then
  phase seed-volume-state node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed-volume
fi
phase assert-baseline assert_baseline_state
phase seed-legacy-runtime-deps-symlink seed_legacy_runtime_deps_symlink
phase resolve-candidate resolve_candidate_version
phase configure-clawhub-fixture configure_clawhub_fixture
phase prepare-update-restart-probe prepare_update_restart_probe
phase configure-plugin-registry configure_plugin_registry
phase update-candidate update_candidate
if [ -n "${OPENCLAW_CLAWHUB_URL:-}" ]; then
  clawhub_security_mode="$(
    node scripts/e2e/lib/package-compat.mjs --clawhub-release-security-mode "$candidate_version"
  )"
  prepublish_package="@openclaw/whatsapp"
  if configured_plugin_installs_enabled; then
    prepublish_package="@openclaw/matrix"
  fi
  phase assert-prepublish-requests node \
    "${OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER:-scripts/e2e/lib/clawhub-fixture-server.cjs}" \
    assert-prepublish-requests "$OPENCLAW_CLAWHUB_URL" "$prepublish_package" "$candidate_version" "$clawhub_security_mode"
fi
phase root-managed-vps-cli-usable assert_root_managed_vps_cli_usable
phase assert-legacy-plugin-dependency-debris-before-doctor assert_legacy_plugin_dependency_debris_before_doctor
phase doctor run_doctor
phase assert-legacy-plugin-dependency-debris-cleaned assert_legacy_plugin_dependency_debris_cleaned
phase assert-legacy-runtime-deps-symlink-repaired assert_legacy_runtime_deps_symlink_repaired
phase validate-post-doctor-config validate_post_doctor_config
phase assert-survival assert_survival
if [ "$SCENARIO" = "sqlite-volume" ]; then
  phase assert-volume-idempotence assert_volume_idempotence
fi
phase gateway-start ensure_gateway_started
phase gateway-probes check_gateway_probes
phase gateway-status check_gateway_status
if [ "$LIVE_OPENAI" = "1" ]; then
  phase live-openai run_live_openai
fi

run_completed="1"
echo "Upgrade survivor Docker E2E passed baseline=${baseline_spec} scenario=${SCENARIO} candidate=${candidate_version} updateRestartMode=${UPDATE_RESTART_MODE} migration=${migration_seconds:-n/a}s idempotence=${idempotence_seconds:-n/a}s startup=${start_seconds}s updateRestart=${update_restart_seconds:-manual}s healthz=${healthz_seconds}s readyz=${readyz_seconds}s status=${status_seconds}s."
