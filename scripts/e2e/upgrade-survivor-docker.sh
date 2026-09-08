#!/usr/bin/env bash
# Installs the packed OpenClaw tarball over dirty old-user state. When
# OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC is set, installs that published
# baseline first and upgrades it to the selected candidate.
set -euo pipefail

PACKAGE_TGZ=""
AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT=""
run_completed="0"
diagnostics_ready=0
cleanup_outer() {
  local exit_status="$?"
  trap - EXIT
  set +e
  # Bash 3.2 can enter EXIT with status 0 after a fatal nounset expansion.
  # Only a successfully joined scenario may turn cleanup into a successful exit.
  if [ "$exit_status" -eq 0 ] && [ "$run_completed" != "1" ]; then
    echo "Upgrade survivor exited before the scenario completed." >&2
    exit_status=1
  fi
  if [ "$exit_status" -ne 0 ]; then
    if [ "$diagnostics_ready" = "1" ]; then
      publish_diagnostics ||
        echo "Upgrade survivor diagnostics missing; preserving original lane failure." >&2
    else
      echo "Upgrade survivor diagnostics missing: no private capture prepared." >&2
    fi
  fi
  if [ -n "$PACKAGE_TGZ" ]; then
    docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
  fi
  if [ -n "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT" ]; then
    rm -rf "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT"
  fi
  if [ "$exit_status" -ne 0 ]; then
    printf '[upgrade-survivor] FAILED (exit %s)\n' "$exit_status" >&2
  fi
  exit "$exit_status"
}
trap cleanup_outer EXIT

HARNESS_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT_DIR="$(cd "${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$HARNESS_ROOT_DIR}" && pwd)"
DOCKER_E2E_HARNESS_ROOT_DIR="$HARNESS_ROOT_DIR"
source "$HARNESS_ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$HARNESS_ROOT_DIR/scripts/lib/docker-e2e-package.sh"
source "$HARNESS_ROOT_DIR/scripts/lib/upgrade-survivor-diagnostics.sh"
source "$HARNESS_ROOT_DIR/scripts/lib/openclaw-e2e-instance.sh"
source "$HARNESS_ROOT_DIR/scripts/lib/frozen-target-compat.sh"
source "$HARNESS_ROOT_DIR/scripts/e2e/lib/prepublish-plugin-registry.sh"

UPGRADE_ASSERTION_ARGS=()
UPGRADE_ASSERTIONS="$(openclaw_resolve_frozen_target_file \
  "$ROOT_DIR" scripts/e2e/lib/upgrade-survivor/assertions.mjs)"
if [ -n "$UPGRADE_ASSERTIONS" ]; then
  # Upgrade survival is defined by the selected release's shipped state contract.
  UPGRADE_ASSERTION_ARGS+=(
    -v "$UPGRADE_ASSERTIONS:/app/scripts/e2e/lib/upgrade-survivor/assertions.mjs:ro"
  )
fi

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-upgrade-survivor-e2e" OPENCLAW_UPGRADE_SURVIVOR_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_UPGRADE_SURVIVOR_E2E_SKIP_BUILD:-0}"
DOCKER_RUN_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:-1200s}"
BASELINE_SPEC="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:-}"
SCENARIO="${OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:-base}"
UPDATE_RESTART_MODE="${OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE:-manual}"
if [ "$SCENARIO" = "abandoned-update" ] && [ -z "${OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE:-}" ]; then
  UPDATE_RESTART_MODE="auto-auth"
fi
COMMAND_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"
START_BUDGET_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"
STATUS_BUDGET_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"
PROBE_TIMEOUT_MS="$(openclaw_e2e_read_nonnegative_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS 60000)"
PROBE_ATTEMPT_TIMEOUT_MS="$(
  openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS 5000
)"
PROBE_MAX_BODY_BYTES="$(
  openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES 1048576
)"
ROOT_MANAGED_VPS="${OPENCLAW_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS:-0}"
LIVE_OPENAI="${OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI:-0}"
LIVE_OPENAI_ENV_ARGS=()
case "$LIVE_OPENAI" in
  0)
    ;;
  1)
    if [ "${OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" != "1" ]; then
      echo "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI=1 requires OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1" >&2
      exit 2
    fi
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI=1 requires OPENAI_API_KEY" >&2
      exit 2
    fi
    LIVE_OPENAI_TIMEOUT_SECONDS="$(
      openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_TIMEOUT_SECONDS 180
    )"
    LIVE_OPENAI_ENV_ARGS=(
      -e OPENAI_API_KEY
      -e OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI=1
      -e OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_MODEL="${OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_MODEL:-openai/gpt-5.5}"
      -e OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_TIMEOUT_SECONDS="$LIVE_OPENAI_TIMEOUT_SECONDS"
    )
    ;;
  *)
    echo "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI must be 0 or 1; got: $LIVE_OPENAI" >&2
    exit 2
    ;;
esac

if { [ "$SCENARIO" = "sqlite-volume" ] || [ "$SCENARIO" = "recovery-cleanup" ] || [ "$SCENARIO" = "legacy-operator-state" ]; } && [ "${OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" != "1" ]; then
  echo "$SCENARIO requires OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1" >&2
  exit 1
fi
if [ "$SCENARIO" = "mobile-pairing-reconnect" ] && [ "${OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" != "1" ]; then
  echo "mobile-pairing-reconnect requires OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1" >&2
  exit 1
fi
if [ "$SCENARIO" = "recovery-cleanup" ] && { [ "$UPDATE_RESTART_MODE" != "manual" ] || [ "$ROOT_MANAGED_VPS" != "0" ] || [ "$LIVE_OPENAI" != "0" ]; }; then
  echo "recovery-cleanup requires the isolated manual-restart fixture without live provider credentials" >&2
  exit 1
fi
if [ "$SCENARIO" = "mobile-pairing-reconnect" ] && { [ "$UPDATE_RESTART_MODE" != "manual" ] || [ "$ROOT_MANAGED_VPS" != "0" ] || [ "$LIVE_OPENAI" != "0" ]; }; then
  echo "mobile-pairing-reconnect requires the isolated manual-restart fixture without live provider credentials" >&2
  exit 1
fi

if [ "$SCENARIO" = "abandoned-update" ] && {
  [ "${OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" != "1" ] ||
  [ "$UPDATE_RESTART_MODE" != "auto-auth" ] || [ "$ROOT_MANAGED_VPS" != "0" ] || [ "$LIVE_OPENAI" != "0" ];
}; then
  echo "abandoned-update requires the published baseline, auto-auth service fixture, and no live provider" >&2
  exit 1
fi

resolve_lane_artifact_suffix() {
  if [ -n "${OPENCLAW_DOCKER_ALL_LANE_NAME:-}" ]; then
    printf "%s" "$OPENCLAW_DOCKER_ALL_LANE_NAME"
    return
  fi

  if [ "$ROOT_MANAGED_VPS" = "1" ]; then
    printf "root-managed-vps-upgrade"
  elif [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    printf "update-restart-auth"
  elif [ "${OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" = "1" ]; then
    printf "published-upgrade-survivor"
  else
    printf "upgrade-survivor"
  fi

  if [ -n "${BASELINE_SPEC// }" ]; then
    printf -- "-%s" "$BASELINE_SPEC"
  fi
  if [ "$SCENARIO" != "base" ]; then
    printf -- "-%s" "$SCENARIO"
  fi
}

LANE_ARTIFACT_SUFFIX="$(resolve_lane_artifact_suffix)"
LANE_ARTIFACT_SUFFIX="${LANE_ARTIFACT_SUFFIX//[^A-Za-z0-9_.-]/_}"
ARTIFACT_DIR="${OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/upgrade-survivor/$LANE_ARTIFACT_SUFFIX}"
DOCKER_RUN_USER_ARGS=()
PROBE_ENV_ARGS=(
  -e OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS="$PROBE_TIMEOUT_MS"
  -e OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS="$PROBE_ATTEMPT_TIMEOUT_MS"
  -e OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES="$PROBE_MAX_BODY_BYTES"
)
if [ -n "${OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING:-}" ]; then
  PROBE_ENV_ARGS+=(
    -e OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING="$OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING"
  )
fi
if [ -n "${OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED:-}" ]; then
  PROBE_ENV_ARGS+=(
    -e OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED="$OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED"
  )
fi
if [ "$ROOT_MANAGED_VPS" = "1" ]; then
  if [ "${OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" != "1" ]; then
    echo "OPENCLAW_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS=1 requires OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1" >&2
    exit 1
  fi
  DOCKER_RUN_USER_ARGS+=(--user root -e HOME=/root -e USER=root)
fi

normalize_npm_candidate() {
  local raw="$1"
  case "$raw" in
    latest | beta)
      printf 'openclaw@%s\n' "$raw"
      ;;
    openclaw@*)
      printf '%s\n' "$raw"
      ;;
    *@*)
      echo "OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE must be current, latest, beta, openclaw@<version>, a bare version, or a .tgz path." >&2
      return 1
      ;;
    *)
      printf 'openclaw@%s\n' "$raw"
      ;;
  esac
}

if [ "${OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" = "1" ]; then
  if [ -z "${BASELINE_SPEC// }" ]; then
    echo "OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC is required for published upgrade survivor" >&2
    exit 1
  fi

  mkdir -p "$ARTIFACT_DIR"
  chmod -R a+rwX "$ARTIFACT_DIR" || true
  prepare_diagnostics_capture

  DOCKER_E2E_PACKAGE_ARGS=()
  CANDIDATE_RAW="${OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE:-current}"
  CANDIDATE_KIND="npm"
  CANDIDATE_IS_CURRENT=0
  CANDIDATE_SPEC=""

  if [ -n "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ]; then
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz upgrade-survivor "$OPENCLAW_CURRENT_PACKAGE_TGZ")"
    CANDIDATE_KIND="tarball"
    CANDIDATE_IS_CURRENT=1
    CANDIDATE_SPEC="/tmp/openclaw-current.tgz"
  elif [ "$CANDIDATE_RAW" = "current" ]; then
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz upgrade-survivor)"
    CANDIDATE_KIND="tarball"
    CANDIDATE_IS_CURRENT=1
    CANDIDATE_SPEC="/tmp/openclaw-current.tgz"
  elif [[ "$CANDIDATE_RAW" == *.tgz ]]; then
    if [ ! -f "$CANDIDATE_RAW" ]; then
      echo "OpenClaw candidate tarball does not exist: $CANDIDATE_RAW" >&2
      exit 1
    fi
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz upgrade-survivor "$CANDIDATE_RAW")"
    CANDIDATE_KIND="tarball"
    CANDIDATE_SPEC="/tmp/openclaw-current.tgz"
  else
    CANDIDATE_KIND="npm"
    CANDIDATE_SPEC="$(normalize_npm_candidate "$CANDIDATE_RAW")"
  fi

  if [ "$CANDIDATE_IS_CURRENT" = "1" ] && [ -z "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
    AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT="$(
      mktemp -d "${TMPDIR:-/tmp}/openclaw-upgrade-survivor-plugin-registry.XXXXXX"
    )"
    OPENCLAW_DOCKER_ALL_LANES=published-upgrade-survivor \
      OPENCLAW_DOCKER_ALL_LOG_DIR="$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT" \
      OPENCLAW_DOCKER_ALL_TIMINGS=0 \
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS="$BASELINE_SPEC" \
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS="$SCENARIO" \
      node "$HARNESS_ROOT_DIR/scripts/test-docker-all.mjs" --prepare-plugin-registry
    export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR="$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT/prepublish-plugin-registry"
  fi

  if [ -n "$PACKAGE_TGZ" ]; then
    docker_e2e_package_mount_args "$PACKAGE_TGZ"
  elif [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
    openclaw_prepublish_plugin_registry_configure_docker_args "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR"
    DOCKER_E2E_PACKAGE_ARGS=("${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS[@]}")
  fi

  OPENCLAW_TEST_STATE_FUNCTION_B64="$(docker_e2e_test_state_function_b64)"

  docker_e2e_build_or_reuse "$IMAGE_NAME" upgrade-survivor "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

  echo "Running published upgrade survivor Docker E2E..."
  # Keep candidate images from selecting an older copy of the trusted release runner.
  docker_e2e_run_with_harness \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e OPENCLAW_TEST_STATE_FUNCTION_B64="$OPENCLAW_TEST_STATE_FUNCTION_B64" \
    -e OPENCLAW_UPGRADE_SURVIVOR_BASELINE="$BASELINE_SPEC" \
    -e OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_KIND="$CANDIDATE_KIND" \
    -e OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC="$CANDIDATE_SPEC" \
    -e OPENCLAW_DOCKER_E2E_SELECTED_SHA="${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}" \
    -e OPENCLAW_UPGRADE_SURVIVOR_SCENARIO="$SCENARIO" \
    -e OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="${OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT:-/tmp/openclaw-upgrade-survivor-runtime}" \
    -e OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE="$UPDATE_RESTART_MODE" \
    -e OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT="$COMMAND_TIMEOUT" \
    -e OPENCLAW_UPGRADE_SURVIVOR_VOLUME_SESSIONS="${OPENCLAW_UPGRADE_SURVIVOR_VOLUME_SESSIONS:-}" \
    -e OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION="${OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION:-}" \
    -e OPENCLAW_UPGRADE_SURVIVOR_VOLUME_CRON_JOBS="${OPENCLAW_UPGRADE_SURVIVOR_VOLUME_CRON_JOBS:-}" \
    -e OPENCLAW_UPGRADE_SURVIVOR_VOLUME_IDEMPOTENCE_BUDGET_SECONDS="${OPENCLAW_UPGRADE_SURVIVOR_VOLUME_IDEMPOTENCE_BUDGET_SECONDS:-60}" \
    -e OPENCLAW_UPGRADE_SURVIVOR_LEGACY_RUNTIME_DEPS_SYMLINK="${OPENCLAW_UPGRADE_SURVIVOR_LEGACY_RUNTIME_DEPS_SYMLINK:-}" \
    -e OPENCLAW_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS="$ROOT_MANAGED_VPS" \
    -e OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON=/tmp/openclaw-upgrade-survivor-artifacts/summary.json \
    -e OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS="$START_BUDGET_SECONDS" \
    -e OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS="$STATUS_BUDGET_SECONDS" \
    -e OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER=/tmp/openclaw-clawhub-fixture-server.cjs \
    -e OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER=/tmp/openclaw-config-parking.mjs \
    "${PROBE_ENV_ARGS[@]}" \
    ${LIVE_OPENAI_ENV_ARGS[@]+"${LIVE_OPENAI_ENV_ARGS[@]}"} \
    -v "$ARTIFACT_DIR:/tmp/openclaw-upgrade-survivor-artifacts" \
    -v "$HARNESS_ROOT_DIR/scripts/e2e/lib/clawhub-fixture-server.cjs:/tmp/openclaw-clawhub-fixture-server.cjs:ro" \
    -v "$HARNESS_ROOT_DIR/scripts/e2e/lib/upgrade-survivor/config-parking.mjs:/tmp/openclaw-config-parking.mjs:ro" \
    -v "$HARNESS_ROOT_DIR/scripts/e2e/lib/upgrade-survivor/run.sh:/tmp/openclaw-upgrade-survivor-run.sh:ro" \
    ${UPGRADE_ASSERTION_ARGS[@]+"${UPGRADE_ASSERTION_ARGS[@]}"} \
    ${DOCKER_E2E_PACKAGE_ARGS[@]+"${DOCKER_E2E_PACKAGE_ARGS[@]}"} \
    ${DOCKER_RUN_USER_ARGS[@]+"${DOCKER_RUN_USER_ARGS[@]}"} \
    "$IMAGE_NAME" \
    timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash /tmp/openclaw-upgrade-survivor-run.sh
  run_completed="1"
  exit 0
fi

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz upgrade-survivor "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
if [ -z "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
  AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT="$(
    mktemp -d "${TMPDIR:-/tmp}/openclaw-upgrade-survivor-plugin-registry.XXXXXX"
  )"
  planner_lane="upgrade-survivor"
  if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    planner_lane="update-restart-auth"
  fi
  OPENCLAW_DOCKER_ALL_LANES="$planner_lane" \
    OPENCLAW_DOCKER_ALL_LOG_DIR="$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT" \
    OPENCLAW_DOCKER_ALL_TIMINGS=0 \
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS="$SCENARIO" \
    node "$HARNESS_ROOT_DIR/scripts/test-docker-all.mjs" --prepare-plugin-registry
  export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR="$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT/prepublish-plugin-registry"
fi
docker_e2e_package_mount_args "$PACKAGE_TGZ"
OPENCLAW_TEST_STATE_FUNCTION_B64="$(docker_e2e_test_state_function_b64)"
mkdir -p "$ARTIFACT_DIR"
chmod -R a+rwX "$ARTIFACT_DIR" || true
prepare_diagnostics_capture

docker_e2e_build_or_reuse "$IMAGE_NAME" upgrade-survivor "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

echo "Running upgrade survivor Docker E2E..."
docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_TEST_STATE_FUNCTION_B64="$OPENCLAW_TEST_STATE_FUNCTION_B64" \
  -e OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT=/tmp/openclaw-upgrade-survivor-artifacts \
  -e OPENCLAW_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS="$ROOT_MANAGED_VPS" \
  -e OPENCLAW_UPGRADE_SURVIVOR_SCENARIO="$SCENARIO" \
  -e OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE="$UPDATE_RESTART_MODE" \
  -e OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT="$COMMAND_TIMEOUT" \
  -e OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS="$START_BUDGET_SECONDS" \
  -e OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS="$STATUS_BUDGET_SECONDS" \
  -e OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER=/tmp/openclaw-clawhub-fixture-server.cjs \
  -e OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER=/tmp/openclaw-config-parking.mjs \
  "${PROBE_ENV_ARGS[@]}" \
  -v "$ARTIFACT_DIR:/tmp/openclaw-upgrade-survivor-artifacts" \
  -v "$HARNESS_ROOT_DIR/scripts/e2e/lib/clawhub-fixture-server.cjs:/tmp/openclaw-clawhub-fixture-server.cjs:ro" \
  -v "$HARNESS_ROOT_DIR/scripts/e2e/lib/upgrade-survivor/config-parking.mjs:/tmp/openclaw-config-parking.mjs:ro" \
  ${UPGRADE_ASSERTION_ARGS[@]+"${UPGRADE_ASSERTION_ARGS[@]}"} \
  ${DOCKER_E2E_PACKAGE_ARGS[@]+"${DOCKER_E2E_PACKAGE_ARGS[@]}"} \
  ${DOCKER_RUN_USER_ARGS[@]+"${DOCKER_RUN_USER_ARGS[@]}"} \
  "$IMAGE_NAME" \
 timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash -lc 'set -euo pipefail
 source scripts/lib/openclaw-e2e-instance.sh
 source scripts/e2e/lib/prepublish-plugin-registry.sh

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="${OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT:-/tmp/openclaw-upgrade-survivor-artifacts}"
export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="${OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT:-/tmp/openclaw-upgrade-survivor-runtime}"
mkdir -p "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"
export TMPDIR="${OPENCLAW_UPGRADE_SURVIVOR_TMPDIR:-$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT/tmp}"
export OPENCLAW_TEST_STATE_TMPDIR="${OPENCLAW_UPGRADE_SURVIVOR_TEST_STATE_TMPDIR:-$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT/state-tmp}"
export npm_config_prefix="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/npm-prefix"
export NPM_CONFIG_PREFIX="$npm_config_prefix"
export npm_config_cache="${OPENCLAW_UPGRADE_SURVIVOR_NPM_CACHE:-$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT/npm-cache}"
export NPM_CONFIG_CACHE="$npm_config_cache"
export npm_config_tmp="$TMPDIR"
mkdir -p "$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT" "$TMPDIR" "$OPENCLAW_TEST_STATE_TMPDIR" "$npm_config_prefix" "$npm_config_cache"
chmod 700 "$npm_config_cache" || true
export PATH="$npm_config_prefix/bin:$PATH"
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
SCENARIO="${OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:-base}"
if [ "$SCENARIO" = "feishu-channel" ]; then
  export FEISHU_APP_SECRET="upgrade-survivor-feishu-secret"
fi
if [ "$SCENARIO" = "configured-plugin-installs" ] || [ "$SCENARIO" = "sqlite-volume" ]; then
  export BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"
fi

UPDATE_RESTART_MODE="${OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE:-manual}"
command_timeout="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"
PORT=18789
START_BUDGET="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"
STATUS_BUDGET="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"
GATEWAY_LOG="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/gateway.log"
SYSTEMCTL_SHIM_LOG="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/systemctl-shim.log"
SYSTEMCTL_SHIM_PID_FILE="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/systemctl-shim.pid"
SYSTEMCTL_SHIM_DAEMON_LOG="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/systemctl-shim-gateway.log"
BASELINE_SERVICE_INSTALL_JSON="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/baseline-service-install.json"
BASELINE_SERVICE_INSTALL_ERR="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/baseline-service-install.err"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$SYSTEMCTL_SHIM_LOG"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$SYSTEMCTL_SHIM_PID_FILE"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$SYSTEMCTL_SHIM_DAEMON_LOG"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON="$BASELINE_SERVICE_INSTALL_JSON"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR="$BASELINE_SERVICE_INSTALL_ERR"

gateway_pid=""
plugin_registry_pid=""
clawhub_fixture_pid=""
run_completed="0"
cleanup() {
  if [ -s "$SYSTEMCTL_SHIM_PID_FILE" ]; then
    systemctl --user stop openclaw-gateway.service >/dev/null 2>&1 || true
  fi
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  if [ -s "$SYSTEMCTL_SHIM_PID_FILE" ]; then
    openclaw_e2e_terminate_gateways "$(cat "$SYSTEMCTL_SHIM_PID_FILE" 2>/dev/null || true)"
  fi
  openclaw_e2e_stop_process "${plugin_registry_pid:-}"
  openclaw_e2e_stop_process "${clawhub_fixture_pid:-}"
}
CURRENT_PHASE="setup"
on_exit() {
  local result="$1"
  trap - EXIT
  set +e
  if [ "$result" -eq 0 ] && [ "$run_completed" != "1" ]; then
    echo "Upgrade survivor exited before all assertions completed." >&2
    result=1
  fi
  if [ "$result" -ne 0 ]; then
    node scripts/e2e/lib/upgrade-survivor/diagnostics.mjs capture \
      "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT" "$CURRENT_PHASE" "$result" ||
      echo "Upgrade survivor diagnostics missing; preserving original phase failure." >&2
  fi
  cleanup
  exit "$result"
}
trap '"'"'on_exit $?'"'"' EXIT

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
  local fixture_root="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/clawhub-fixture" port_file log_file
  port_file="$fixture_root/port"
  log_file="$fixture_root/server.log"
  mkdir -p "$fixture_root"
  node "$OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER" \
    prepublish-artifacts "$port_file" \
    "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR/prepublish-plugin-registry.json" >"$log_file" 2>&1 &
  clawhub_fixture_pid="$!"
  wait_for_fixture_port "$clawhub_fixture_pid" "$port_file" "$log_file" "ClawHub fixture"
  export OPENCLAW_CLAWHUB_URL="http://127.0.0.1:$(cat "$port_file")"
}

 configure_plugin_registry() {
   local fixture_root="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/plugin-registry"
   local package_dir="$fixture_root/package"
   local tarball="$fixture_root/openclaw-brave-plugin-2026.5.2.tgz"
   local registry_args=()

   if [ "${OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:-base}" = "configured-plugin-installs" ]; then
    mkdir -p "$package_dir"
    FIXTURE_PACKAGE_DIR="$package_dir" node <<'"'"'NODE'"'"'
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
    registry_args+=("@openclaw/brave-plugin" "2026.5.2" "$tarball")
  fi

   if [ "${#registry_args[@]}" -eq 0 ]; then
     [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] || return 0
   fi

 openclaw_prepublish_plugin_registry_start \
     "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" \
     "${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}" \
     "$package_version" \
     "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256:-}" \
     "$fixture_root" \
     plugin_registry_pid \
     ${registry_args[@]+"${registry_args[@]}"}
 }

install_companion_plugins() {
  local authored_config="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/companion-install-authored.json"
  local install_status=0
  local restore_status=0
  node "$OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER" \
    park-companion-install "$OPENCLAW_CONFIG_PATH" "$authored_config"

  set +e
  openclaw_e2e_fixture_plugin_command openclaw -- \
    plugins install "npm:@openclaw/discord@$package_version" --pin
  install_status=$?
  if [ "$install_status" -eq 0 ]; then
    openclaw_e2e_fixture_plugin_command openclaw -- \
      plugins install "clawhub:@openclaw/whatsapp@$package_version"
    install_status=$?
  fi
  if [ "$install_status" -eq 0 ]; then
    node "$OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER" \
      assert-prepublish-requests "$OPENCLAW_CLAWHUB_URL" "@openclaw/whatsapp" "$package_version"
    install_status=$?
  fi
  if [ "$install_status" -eq 0 ]; then
    openclaw_e2e_fixture_plugin_command openclaw -- \
      plugins install "npm:@openclaw/codex@$package_version" --pin
    install_status=$?
  fi
  if [ "$install_status" -eq 0 ]; then
    # Inspection validates config too; keep the legacy migration specimen parked
    # until companion installation and its provenance checks have both finished.
    node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
      assert-companion-installs "$package_version" \
      "${OPENCLAW_E2E_LAST_FIXTURE_PLUGIN_CAPABILITY_CONSENT_SUPPORTED:?missing candidate capability-consent support}"
    install_status=$?
  fi
  node "$OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER" \
    restore "$OPENCLAW_CONFIG_PATH" "$authored_config"
  restore_status=$?
  set -e

  if [ "$install_status" -ne 0 ]; then
    return "$install_status"
  fi
  if [ "$restore_status" -ne 0 ]; then
    return "$restore_status"
  fi
}

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_FUNCTION_B64:?missing OPENCLAW_TEST_STATE_FUNCTION_B64}"
if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
  account_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
  if [ -z "$account_home" ]; then
    echo "Could not resolve the current account home" >&2
    exit 1
  fi
  openclaw_test_state_create "$account_home" upgrade-survivor
  export HOME="$account_home"
  export USERPROFILE="$account_home"
  export OPENCLAW_STATE_DIR="$account_home/.openclaw"
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
  unset OPENCLAW_HOME
else
  openclaw_test_state_create upgrade-survivor upgrade-survivor
fi
node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed

CURRENT_PHASE="install-candidate"
openclaw_e2e_install_package "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/install.log" "upgrade survivor package" "$npm_config_prefix"
command -v openclaw >/dev/null
package_version="$(node -p "JSON.parse(require(\"node:fs\").readFileSync(process.argv[1] + \"/lib/node_modules/openclaw/package.json\", \"utf8\")).version" "$npm_config_prefix")"
OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(
  node scripts/e2e/lib/package-compat.mjs "$package_version"
)"
export OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT

echo "Checking dirty-state config before update..."
CURRENT_PHASE="prepare-state"
OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE=baseline node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config
OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE=baseline node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state
configure_clawhub_fixture
configure_plugin_registry
install_companion_plugins
if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
  # shellcheck disable=SC1091
  source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh
  prepare_update_restart_probe_current_install "$PORT" "$GATEWAY_LOG"
  pre_update_service_pid="$(cat "$SYSTEMCTL_SHIM_PID_FILE")"
  pre_update_systemctl_lines="$(wc -l <"$SYSTEMCTL_SHIM_LOG")"
fi

echo "Running package update against the mounted tarball..."
CURRENT_PHASE="update-candidate"
update_args=(update --tag "${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}" --yes --json)
if [ "$UPDATE_RESTART_MODE" != "auto-auth" ]; then
  update_args+=(--no-restart)
fi
set +e
openclaw_e2e_maybe_timeout "$command_timeout" env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD OPENCLAW_ALLOW_ROOT=1 NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=$PWD/scripts/e2e/lib/upgrade-survivor/diagnostics.mjs" openclaw "${update_args[@]}" >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.json" 2>"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.err"
update_status=$?
set -e
if [ "$update_status" -ne 0 ]; then
  echo "openclaw update failed" >&2
  validate_status=0
  openclaw_e2e_maybe_timeout "$command_timeout" openclaw config validate --json >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json" 2>"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.err" || validate_status=$?
  echo "post-update config validation probe status=$validate_status" >&2
  openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.err" >&2 || true
  openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json" >&2 || true
  openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.err" >&2 || true
  openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.json" >&2 || true
  exit "$update_status"
fi
if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
  echo "Skipping doctor repair until after restart proof."
else
  echo "Running non-interactive doctor repair..."
  CURRENT_PHASE="doctor"
  if ! openclaw_e2e_maybe_timeout "$command_timeout" openclaw doctor --fix --non-interactive >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/doctor.log" 2>&1; then
    echo "openclaw doctor failed" >&2
    openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/doctor.log" >&2
    exit 1
  fi
  if ! openclaw_e2e_maybe_timeout "$command_timeout" openclaw config validate >>"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/doctor.log" 2>&1; then
    echo "post-doctor config validation failed" >&2
    openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/doctor.log" >&2
    exit 1
  fi
fi

echo "Verifying config and state survived update..."
CURRENT_PHASE="assert-state"
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state

startup_summary="n/a"
if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
  assert_update_restart_service_replaced "$pre_update_service_pid" "$pre_update_systemctl_lines"
  echo "Gateway restart was handled by openclaw update."
else
  echo "Starting gateway from upgraded state..."
  CURRENT_PHASE="start-gateway"
  start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured >"$GATEWAY_LOG" 2>&1 &
  gateway_pid="$!"
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360 "$PORT"
  ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
  if [ "$start_seconds" -gt "$START_BUDGET" ]; then
    echo "gateway startup exceeded survivor budget: ${start_seconds}s > ${START_BUDGET}s" >&2
    openclaw_e2e_print_log "$GATEWAY_LOG" >&2
    exit 1
  fi
  startup_summary="${start_seconds}s"
fi

echo "Checking gateway HTTP probes..."
CURRENT_PHASE="http-probes"
node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs \
  --base-url "http://127.0.0.1:$PORT" \
  --path /healthz \
  --expect live \
  --out "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/healthz.json"

readyz_probe_args=(
  --base-url "http://127.0.0.1:$PORT"
  --path /readyz
  --expect ready
)
if [ -n "${OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING:-}" ]; then
  readyz_probe_args+=(--allow-failing "$OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING")
fi
if [ "${OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED:-}" = "1" ]; then
  readyz_probe_args+=(--allow-degraded-ready)
fi
readyz_probe_args+=(--out "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/readyz.json")
node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs "${readyz_probe_args[@]}"

echo "Checking gateway RPC status..."
CURRENT_PHASE="status"
status_start="$(node -e "process.stdout.write(String(Date.now()))")"
if ! openclaw_e2e_maybe_timeout "$command_timeout" openclaw gateway status --url "ws://127.0.0.1:$PORT" --token "$GATEWAY_AUTH_TOKEN_REF" --require-rpc --timeout 30000 --json >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.json" 2>"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.err"; then
  echo "gateway status failed" >&2
  openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.err" >&2
  openclaw_e2e_print_log "$GATEWAY_LOG" >&2
  openclaw_e2e_print_log "$SYSTEMCTL_SHIM_DAEMON_LOG" >&2
  exit 1
fi
status_end="$(node -e "process.stdout.write(String(Date.now()))")"
status_seconds=$(((status_end - status_start + 999) / 1000))
if [ "$status_seconds" -gt "$STATUS_BUDGET" ]; then
  echo "gateway status exceeded survivor budget: ${status_seconds}s > ${STATUS_BUDGET}s" >&2
  openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.json" >&2
  exit 1
fi
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-status-json "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.json"

echo "Upgrade survivor Docker E2E passed scenario=${OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:-base} updateRestartMode=${UPDATE_RESTART_MODE} startup=${startup_summary} status=${status_seconds}s."
run_completed="1"
'
run_completed="1"
