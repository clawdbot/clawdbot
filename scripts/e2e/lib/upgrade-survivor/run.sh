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
CURRENT_PHASE="setup"
FAILURE_PHASE=""
FAILURE_MESSAGE=""
gateway_pid=""
baseline_spec=""
baseline_version=""
baseline_version_expected="0"
candidate_version=""
installed_version=""
start_seconds=""
status_seconds=""
healthz_seconds=""
readyz_seconds=""

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
CONFIG_COVERAGE_JSON="$ARTIFACT_ROOT/config-recipe.json"
export OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON="$CONFIG_COVERAGE_JSON"
rm -f "$SUMMARY_JSON" "$CONFIG_COVERAGE_JSON"
: >"$PHASE_LOG"

validate_baseline_package_spec() {
  local spec="$1"
  if [[ "$spec" =~ ^openclaw@(beta|latest|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*|-beta\.[1-9][0-9]*)?)$ ]]; then
    return 0
  fi
  echo "OPENCLAW_UPGRADE_SURVIVOR_BASELINE must be openclaw@latest, openclaw@beta, an exact OpenClaw release version, or a bare release version; got: $spec" >&2
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
    latest | beta)
      baseline_version=""
      baseline_version_expected="0"
      ;;
    dev | main | "")
      echo "OPENCLAW_UPGRADE_SURVIVOR_BASELINE must be openclaw@latest, openclaw@beta, openclaw@<version>, or a bare version" >&2
      return 1
      ;;
    *)
      baseline_version_expected="1"
      ;;
  esac
  validate_baseline_package_spec "$baseline_spec"
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
    SUMMARY_START_SECONDS="$start_seconds" \
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
  timings: {
    startupSeconds: numberOrNull(process.env.SUMMARY_START_SECONDS),
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
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
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
  printf '%s/dist/extensions/%s/node_modules\n' "$(package_root)" "$plugin"
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

legacy_plugin_dependency_probe_paths() {
  local plugin="$1"
  local plugin_dir
  plugin_dir="$(package_root)/dist/extensions/$plugin"
  printf '%s\n' \
    "$plugin_dir/node_modules" \
    "$plugin_dir/.openclaw-runtime-deps.json" \
    "$plugin_dir/.openclaw-runtime-deps-stamp.json" \
    "$plugin_dir/.openclaw-runtime-deps-copy-upgrade-survivor" \
    "$plugin_dir/.openclaw-install-stage-upgrade-survivor" \
    "$plugin_dir/.openclaw-pnpm-store" \
    "$(package_root)/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor" \
    "$OPENCLAW_STATE_DIR/.local/bundled-plugin-runtime-deps/$plugin-upgrade-survivor" \
    "$OPENCLAW_STATE_DIR/plugin-runtime-deps/$plugin-upgrade-survivor"
}

install_baseline_plugin_dependencies() {
  plugin_deps_cleanup_enabled || return 0
  echo "Running baseline doctor to install configured plugin dependencies before update."
  if ! openclaw doctor --fix --non-interactive >"$BASELINE_DOCTOR_LOG" 2>&1; then
    echo "baseline openclaw doctor failed while preparing plugin dependency cleanup scenario" >&2
    cat "$BASELINE_DOCTOR_LOG" >&2 || true
    return 1
  fi
}

seed_legacy_plugin_dependency_debris() {
  plugin_deps_cleanup_enabled || return 0

  local found=0
  local plugin
  for plugin in $(plugin_deps_cleanup_plugins); do
    local plugin_dir
    plugin_dir="$(package_root)/dist/extensions/$plugin"
    if [ ! -d "$plugin_dir" ]; then
      continue
    fi
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
  if ! openclaw update --tag "$CANDIDATE_SPEC" --yes --json --no-restart >"$UPDATE_JSON" 2>"$UPDATE_ERR"; then
    echo "openclaw update failed" >&2
    cat "$UPDATE_ERR" >&2 || true
    cat "$UPDATE_JSON" >&2 || true
    return 1
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
  openclaw gateway --port "$port" --bind loopback --allow-unconfigured >"$GATEWAY_LOG" 2>&1 &
  gateway_pid="$!"
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360
  ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
  if [ "$start_seconds" -gt "$budget" ]; then
    echo "gateway startup exceeded survivor budget: ${start_seconds}s > ${budget}s" >&2
    cat "$GATEWAY_LOG" >&2 || true
    return 1
  fi
}

check_gateway_probes() {
  healthz_seconds="$(probe_gateway_endpoint /healthz live "$HEALTHZ_JSON")"
  export OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING="discord,telegram,whatsapp,feishu"
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
phase reset-run-state reset_run_state
phase install-baseline install_baseline
phase seed-state seed_state
phase apply-baseline-config-recipe apply_baseline_config_recipe
phase validate-baseline-config validate_baseline_config
phase install-baseline-plugin-dependencies install_baseline_plugin_dependencies
phase seed-legacy-plugin-dependency-debris seed_legacy_plugin_dependency_debris
phase assert-legacy-plugin-dependency-debris assert_legacy_plugin_dependency_debris_present
phase assert-baseline assert_baseline_state
phase seed-legacy-runtime-deps-symlink seed_legacy_runtime_deps_symlink
phase resolve-candidate resolve_candidate_version
phase update-candidate update_candidate
phase assert-legacy-plugin-dependency-debris-before-doctor assert_legacy_plugin_dependency_debris_before_doctor
phase doctor run_doctor
phase assert-legacy-plugin-dependency-debris-cleaned assert_legacy_plugin_dependency_debris_cleaned
phase assert-legacy-runtime-deps-symlink-repaired assert_legacy_runtime_deps_symlink_repaired
phase validate-post-doctor-config validate_post_doctor_config
phase assert-survival assert_survival
phase gateway-start start_gateway
phase gateway-probes check_gateway_probes
phase gateway-status check_gateway_status

echo "Upgrade survivor Docker E2E passed baseline=${baseline_spec} scenario=${SCENARIO} candidate=${candidate_version} startup=${start_seconds}s healthz=${healthz_seconds}s readyz=${readyz_seconds}s status=${status_seconds}s."
