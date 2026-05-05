#!/usr/bin/env bash
set -Eeuo pipefail

source scripts/lib/openclaw-e2e-instance.sh

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export CI=true
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1
export OPENCLAW_SKIP_PROVIDERS=1
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_DISABLE_BONJOUR=1
export GATEWAY_AUTH_TOKEN_REF="upgrade-survivor-token"
export OPENAI_API_KEY="sk-openclaw-upgrade-survivor"
export DISCORD_BOT_TOKEN="upgrade-survivor-discord-token"
export TELEGRAM_BOT_TOKEN="123456:upgrade-survivor-telegram-token"
export FEISHU_APP_SECRET="upgrade-survivor-feishu-secret"
export MATRIX_ACCESS_TOKEN="upgrade-survivor-matrix-token"
export BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"

ARTIFACT_ROOT="$(dirname "${OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON:-/tmp/openclaw-upgrade-survivor-artifacts/summary.json}")"
mkdir -p "$ARTIFACT_ROOT"
export TMPDIR="$ARTIFACT_ROOT/tmp"
mkdir -p "$TMPDIR"
export npm_config_prefix="$ARTIFACT_ROOT/npm-prefix"
export NPM_CONFIG_PREFIX="$npm_config_prefix"
export npm_config_cache="$ARTIFACT_ROOT/npm-cache"
export npm_config_tmp="$TMPDIR"
mkdir -p "$npm_config_prefix" "$npm_config_cache"
export PATH="$npm_config_prefix/bin:$PATH"

SUMMARY_JSON="${OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON:-$ARTIFACT_ROOT/summary.json}"
PHASE_LOG="$ARTIFACT_ROOT/phases.jsonl"
BASELINE_RAW="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE:?missing OPENCLAW_UPGRADE_SURVIVOR_BASELINE}"
CANDIDATE_KIND="${OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_KIND:-tarball}"
CANDIDATE_SPEC="${OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC:-${OPENCLAW_CURRENT_PACKAGE_TGZ:-}}"
SCENARIO="${OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:-base}"
UPDATE_RESTART_MODE="${OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE:-manual}"
CURRENT_PHASE="setup"
FAILURE_PHASE=""
FAILURE_MESSAGE=""
gateway_pid=""
plugin_registry_pid=""
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

BASELINE_INSTALL_LOG="$ARTIFACT_ROOT/baseline-install.log"
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
DOCTOR_LOG="$ARTIFACT_ROOT/doctor.log"
BASELINE_DOCTOR_LOG="$ARTIFACT_ROOT/baseline-doctor.log"
GATEWAY_LOG="$ARTIFACT_ROOT/gateway.log"
HEALTHZ_JSON="$ARTIFACT_ROOT/healthz.json"
READYZ_JSON="$ARTIFACT_ROOT/readyz.json"
STATUS_JSON="$ARTIFACT_ROOT/status.json"
STATUS_ERR="$ARTIFACT_ROOT/status.err"
BASELINE_CONFIG_VALIDATE_LOG="$ARTIFACT_ROOT/baseline-config-validate.log"
BASELINE_SERVICE_INSTALL_JSON="$ARTIFACT_ROOT/baseline-service-install.json"
BASELINE_SERVICE_INSTALL_ERR="$ARTIFACT_ROOT/baseline-service-install.err"
SYSTEMCTL_SHIM_LOG="$ARTIFACT_ROOT/systemctl-shim.log"
SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_ROOT/systemctl-shim.pid"
SYSTEMCTL_SHIM_DAEMON_LOG="$ARTIFACT_ROOT/systemctl-shim-gateway.log"
CONFIG_COVERAGE_JSON="$ARTIFACT_ROOT/config-recipe.json"
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

cleanup() {
  if [ -n "${plugin_registry_pid:-}" ]; then
    kill "$plugin_registry_pid" >/dev/null 2>&1 || true
  fi
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  if [ -s "$SYSTEMCTL_SHIM_PID_FILE" ]; then
    local shim_pid
    shim_pid="$(cat "$SYSTEMCTL_SHIM_PID_FILE" 2>/dev/null || true)"
    if [[ "$shim_pid" =~ ^[0-9]+$ ]] && [ "$shim_pid" -gt 1 ]; then
      openclaw_e2e_terminate_gateways "$shim_pid"
    fi
  fi
}

on_error() {
  local status="$1"
  FAILURE_PHASE="${CURRENT_PHASE:-unknown}"
  FAILURE_MESSAGE="phase ${FAILURE_PHASE} failed with status ${status}"
  json_event "$FAILURE_PHASE" failed || true
  return "$status"
}

on_exit() {
  local status="$1"
  set +e
  cleanup
  if [ "$status" -eq 0 ]; then
    write_summary passed ""
  else
    [ -n "$FAILURE_PHASE" ] || FAILURE_PHASE="${CURRENT_PHASE:-unknown}"
    [ -n "$FAILURE_MESSAGE" ] || FAILURE_MESSAGE="upgrade survivor failed with status $status"
    write_summary failed "$FAILURE_MESSAGE"
  fi
  echo "Upgrade survivor summary: $SUMMARY_JSON"
  cat "$SUMMARY_JSON" 2>/dev/null || true
  exit "$status"
}

trap 'on_error $?' ERR
trap 'on_exit $?' EXIT

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
  [ "$SCENARIO" = "configured-plugin-installs" ]
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

configure_configured_plugin_install_fixture_registry() {
  configured_plugin_installs_enabled || return 0

  local fixture_root="$ARTIFACT_ROOT/configured-plugin-installs-npm-fixture"
  local package_dir="$fixture_root/package"
  local tarball="$fixture_root/openclaw-brave-plugin-2026.5.2.tgz"
  local port_file="$fixture_root/npm-registry-port"
  local log_file="$fixture_root/npm-registry.log"
  mkdir -p "$package_dir"
  FIXTURE_PACKAGE_DIR="$package_dir" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FIXTURE_PACKAGE_DIR;
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(
  path.join(root, "package.json"),
  `${JSON.stringify(
    {
      name: "@openclaw/brave-plugin",
      version: "2026.5.2",
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
      providerAuthEnvVars: { brave: ["BRAVE_API_KEY"] },
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
  node scripts/e2e/lib/plugins/npm-registry-server.mjs \
    "$port_file" \
    "@openclaw/brave-plugin" \
    "2026.5.2" \
    "$tarball" \
    >"$log_file" 2>&1 &
  plugin_registry_pid="$!"

  for _ in $(seq 1 100); do
    if [ -s "$port_file" ]; then
      export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$port_file")"
      export npm_config_registry="$NPM_CONFIG_REGISTRY"
      return 0
    fi
    if ! kill -0 "$plugin_registry_pid" 2>/dev/null; then
      cat "$log_file" >&2 || true
      return 1
    fi
    sleep 0.1
  done

  cat "$log_file" >&2 || true
  echo "Timed out waiting for configured plugin install npm fixture registry." >&2
  return 1
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
  rm_rf_retry "$npm_config_prefix" "$TMPDIR" "$ARTIFACT_ROOT/state-home"
  rm -f "$SYSTEMCTL_SHIM_PID_FILE" "$SYSTEMCTL_SHIM_DAEMON_LOG"
  mkdir -p "$npm_config_prefix" "$npm_config_cache" "$TMPDIR"
}

install_baseline() {
  normalize_baseline
  echo "Installing baseline package: $baseline_spec"
  if ! npm install -g --prefix "$npm_config_prefix" "$baseline_spec" --no-fund --no-audit >"$BASELINE_INSTALL_LOG" 2>&1; then
    echo "baseline npm install failed" >&2
    cat "$BASELINE_INSTALL_LOG" >&2 || true
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
  if ! version_output="$(openclaw --version 2>&1)"; then
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
  openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_FUNCTION_B64:?missing OPENCLAW_TEST_STATE_FUNCTION_B64}"
  openclaw_test_state_create "$ARTIFACT_ROOT/state-home" minimal
  export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION="$baseline_version"
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed
}

apply_baseline_config_recipe() {
  node scripts/e2e/lib/upgrade-survivor/config-recipe.mjs apply \
    --summary "$CONFIG_COVERAGE_JSON" \
    --baseline-version "$baseline_version"
}

validate_baseline_config() {
  if ! openclaw config validate >"$BASELINE_CONFIG_VALIDATE_LOG" 2>&1; then
    echo "generated baseline config failed baseline validation" >&2
    cat "$BASELINE_CONFIG_VALIDATE_LOG" >&2 || true
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
printf '%s\n' "$*" >>"$log_file"

filtered=()
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  case "$arg" in
    --user | --quiet | --no-page | --now)
      ;;
    --property)
      i=$((i + 1))
      ;;
    *)
      filtered+=("$arg")
      ;;
  esac
done

command="${filtered[0]:-status}"

is_running() {
  [ -s "$pid_file" ] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

stop_gateway() {
  [ -s "$pid_file" ] || return 0
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 100); do
      kill -0 "$pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
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
  (
    load_unit_environment "$unit"
    nohup bash -lc "exec $exec_start" >>"$daemon_log" 2>&1 &
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
  if ! env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway install --force --json >"$BASELINE_SERVICE_INSTALL_JSON" 2>"$BASELINE_SERVICE_INSTALL_ERR"; then
    echo "baseline gateway service install failed" >&2
    cat "$BASELINE_SERVICE_INSTALL_ERR" >&2 || true
    cat "$BASELINE_SERVICE_INSTALL_JSON" >&2 || true
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

write_update_restart_service_secretref_env() {
  mkdir -p "$OPENCLAW_STATE_DIR"
  local dotenv_path="$OPENCLAW_STATE_DIR/.env"
  local tmp_path="$dotenv_path.tmp.$$"
  if [ -f "$dotenv_path" ]; then
    grep -v '^GATEWAY_AUTH_TOKEN_REF=' "$dotenv_path" >"$tmp_path" || true
  else
    : >"$tmp_path"
  fi
  # Managed restarts resolve SecretRefs from service-owned durable env, not the update caller.
  printf 'GATEWAY_AUTH_TOKEN_REF=%s\n' "$GATEWAY_AUTH_TOKEN_REF" >>"$tmp_path"
  mv "$tmp_path" "$dotenv_path"
}

write_update_restart_service_auth_env() {
  mkdir -p "$OPENCLAW_STATE_DIR"
  local dotenv_path="$OPENCLAW_STATE_DIR/.env"
  local tmp_path="$dotenv_path.tmp.$$"
  if [ -f "$dotenv_path" ]; then
    grep -v '^GATEWAY_AUTH_TOKEN_REF=' "$dotenv_path" >"$tmp_path" || true
  else
    : >"$tmp_path"
  fi
  printf 'GATEWAY_AUTH_TOKEN_REF=%s\n' "$GATEWAY_AUTH_TOKEN_REF" >>"$tmp_path"
  mv "$tmp_path" "$dotenv_path"
  local systemd_env_path="$OPENCLAW_STATE_DIR/gateway.systemd.env"
  printf 'GATEWAY_AUTH_TOKEN_REF=%s\n' "$GATEWAY_AUTH_TOKEN_REF" >"$systemd_env_path"
}

prepare_update_restart_probe() {
  if [ "$UPDATE_RESTART_MODE" != "auto-auth" ]; then
    return 0
  fi
  echo "Preparing configured-auth gateway for automatic update restart."
  install_update_restart_systemctl_shim
  seed_update_restart_probe_device_auth
  start_gateway
  write_update_restart_service_secretref_env
  install_update_restart_service_unit
}

prepare_update_restart_probe_current_install() {
  if [ "$UPDATE_RESTART_MODE" != "auto-auth" ]; then
    return 0
  fi
  echo "Preparing candidate-auth gateway for automatic update restart."
  install_update_restart_systemctl_shim
  seed_update_restart_probe_device_auth
  start_gateway
  write_update_restart_service_auth_env
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

update_candidate() {
  echo "Updating baseline $baseline_spec to candidate $CANDIDATE_KIND:$CANDIDATE_SPEC ($candidate_version)"
  local update_start=""
  local update_end=""
  local update_args=(update --tag "$CANDIDATE_SPEC" --yes --json)
  if [ "$UPDATE_RESTART_MODE" = "manual" ]; then
    update_args+=(--no-restart)
  else
    update_start="$(node -e "process.stdout.write(String(Date.now()))")"
  fi
  if ! env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw "${update_args[@]}" >"$UPDATE_JSON" 2>"$UPDATE_ERR"; then
    echo "openclaw update failed" >&2
    cat "$UPDATE_ERR" >&2 || true
    cat "$UPDATE_JSON" >&2 || true
    return 1
  fi
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    update_end="$(node -e "process.stdout.write(String(Date.now()))")"
    update_restart_seconds=$(((update_end - update_start + 999) / 1000))
    node -e '
      const fs = require("node:fs");
      const file = process.argv[1];
      const result = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!result || result.status !== "ok") {
        throw new Error(`update JSON did not report ok status: ${JSON.stringify(result)}`);
      }
    ' "$UPDATE_JSON"
  fi
  installed_version="$(read_installed_version)"
}

run_doctor() {
  if ! openclaw doctor --fix --non-interactive >"$DOCTOR_LOG" 2>&1; then
    echo "openclaw doctor failed" >&2
    cat "$DOCTOR_LOG" >&2 || true
    return 1
  fi
}

validate_post_doctor_config() {
  if ! openclaw config validate >>"$DOCTOR_LOG" 2>&1; then
    echo "post-doctor config validation failed" >&2
    cat "$DOCTOR_LOG" >&2 || true
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
  args+=(--out "$out_file")
  start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs "${args[@]}"
  end_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  printf '%s\n' "$(((end_epoch - start_epoch + 999) / 1000))"
}

start_gateway() {
  local port=18789
  local budget="${OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS:-90}"
  local start_epoch
  local ready_epoch
  start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway --port "$port" --bind loopback --allow-unconfigured >"$GATEWAY_LOG" 2>&1 &
  gateway_pid="$!"
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    printf '%s\n' "$gateway_pid" >"$SYSTEMCTL_SHIM_PID_FILE"
  fi
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360
  ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
  if [ "$start_seconds" -gt "$budget" ]; then
    echo "gateway startup exceeded survivor budget: ${start_seconds}s > ${budget}s" >&2
    cat "$GATEWAY_LOG" >&2 || true
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
  export OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING="discord,telegram,whatsapp,feishu,matrix"
  readyz_seconds="$(probe_gateway_endpoint /readyz ready "$READYZ_JSON")"
  unset OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING
}

check_gateway_status() {
  local port=18789
  local budget="${OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS:-30}"
  local status_start
  local status_end
  status_start="$(node -e "process.stdout.write(String(Date.now()))")"
  if ! openclaw gateway status --url "ws://127.0.0.1:$port" --token "$GATEWAY_AUTH_TOKEN_REF" --require-rpc --timeout 30000 --json >"$STATUS_JSON" 2>"$STATUS_ERR"; then
    echo "gateway status failed" >&2
    cat "$STATUS_ERR" >&2 || true
    cat "$GATEWAY_LOG" >&2 || true
    return 1
  fi
  status_end="$(node -e "process.stdout.write(String(Date.now()))")"
  status_seconds=$(((status_end - status_start + 999) / 1000))
  if [ "$status_seconds" -gt "$budget" ]; then
    echo "gateway status exceeded survivor budget: ${status_seconds}s > ${budget}s" >&2
    cat "$STATUS_JSON" >&2 || true
    return 1
  fi
  node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-status-json "$STATUS_JSON"
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
phase assert-baseline assert_baseline_state
phase seed-legacy-runtime-deps-symlink seed_legacy_runtime_deps_symlink
phase resolve-candidate resolve_candidate_version
phase prepare-update-restart-probe prepare_update_restart_probe
phase update-candidate update_candidate
phase assert-legacy-plugin-dependency-debris-before-doctor assert_legacy_plugin_dependency_debris_before_doctor
phase configure-configured-plugin-install-fixture-registry configure_configured_plugin_install_fixture_registry
phase doctor run_doctor
phase assert-legacy-plugin-dependency-debris-cleaned assert_legacy_plugin_dependency_debris_cleaned
phase assert-legacy-runtime-deps-symlink-repaired assert_legacy_runtime_deps_symlink_repaired
phase validate-post-doctor-config validate_post_doctor_config
phase assert-survival assert_survival
phase gateway-start ensure_gateway_started
phase gateway-probes check_gateway_probes
phase gateway-status check_gateway_status

echo "Upgrade survivor Docker E2E passed baseline=${baseline_spec} scenario=${SCENARIO} candidate=${candidate_version} updateRestartMode=${UPDATE_RESTART_MODE} startup=${start_seconds}s updateRestart=${update_restart_seconds:-manual}s healthz=${healthz_seconds}s readyz=${readyz_seconds}s status=${status_seconds}s."
