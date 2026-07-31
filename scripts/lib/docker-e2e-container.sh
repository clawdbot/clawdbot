#!/usr/bin/env bash
#
# Shared helpers for Docker E2E scripts that keep a named container running
# while polling readiness from the host.

DOCKER_E2E_CONTAINER_LIB_DIR="${BASH_SOURCE[0]}"
if [[ "$DOCKER_E2E_CONTAINER_LIB_DIR" == */* ]]; then
  DOCKER_E2E_CONTAINER_LIB_DIR="${DOCKER_E2E_CONTAINER_LIB_DIR%/*}"
else
  DOCKER_E2E_CONTAINER_LIB_DIR=.
fi
DOCKER_E2E_CONTAINER_LIB_DIR="$(cd "$DOCKER_E2E_CONTAINER_LIB_DIR" && pwd)"
source "$DOCKER_E2E_CONTAINER_LIB_DIR/docker-e2e-resource-diagnostics.sh"

docker_e2e_timeout_bin() {
  if command -v timeout >/dev/null 2>&1; then
    printf '%s\n' timeout
  elif command -v gtimeout >/dev/null 2>&1; then
    printf '%s\n' gtimeout
  else
    return 1
  fi
}

docker_e2e_timeout_cmd() {
  local timeout_value="$1"
  shift
  local timeout_bin
  if ! timeout_bin="$(docker_e2e_timeout_bin)"; then
    if command -v node >/dev/null 2>&1; then
      echo "timeout command not found; using Node watchdog for Docker command timeout ${timeout_value}" >&2
      node --input-type=module -e '
const [, timeoutValue, command, ...args] = process.argv;

const parseTimeoutMs = (value) => {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)?$/u.exec(String(value ?? "").trim());
  if (!match) {
    throw new Error(`unsupported timeout value: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.max(1, Math.ceil(amount * multiplier));
};

if (!command) {
  console.error("missing command for Node watchdog");
  process.exit(1);
}

const { spawn } = await import("node:child_process");
let timeoutMs;
try {
  timeoutMs = parseTimeoutMs(timeoutValue);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  stdio: "inherit",
});
let timedOut = false;
let parentSignal = null;
let parentSignalTimer = null;
const signalExitCodes = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
const killGraceMs = Number.parseInt(
  process.env.OPENCLAW_DOCKER_TIMEOUT_KILL_GRACE_MS || "30000",
  10,
);
const killTarget = process.platform === "win32" ? child.pid : -child.pid;
const killChild = (signal) => {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(killTarget, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
};
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Docker command timed out after ${timeoutValue}`);
  killChild("SIGTERM");
  setTimeout(() => killChild("SIGKILL"), killGraceMs).unref();
}, timeoutMs);
const forwardSignal = (signal) => {
  if (parentSignal) {
    killChild("SIGKILL");
    process.exit(signalExitCodes.get(signal) ?? 1);
  }
  parentSignal = signal;
  clearTimeout(timer);
  killChild(signal);
  parentSignalTimer = setTimeout(() => {
    killChild("SIGKILL");
    process.exit(signalExitCodes.get(signal) ?? 1);
  }, killGraceMs);
  parentSignalTimer.unref();
};
process.once("SIGINT", forwardSignal);
process.once("SIGTERM", forwardSignal);
process.once("SIGHUP", forwardSignal);
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (parentSignalTimer) {
    clearTimeout(parentSignalTimer);
  }
  if (timedOut) {
    process.exit(124);
  }
  if (parentSignal) {
    process.exit(signalExitCodes.get(parentSignal) ?? 1);
  }
  if (code !== null) {
    process.exit(code);
  }
  if (signal) {
    process.kill(process.pid, signal);
  }
  process.exit(1);
});
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exit(127);
});
' "$timeout_value" "$@"
      return
    fi
    echo "timeout command not found; cannot bound Docker command after ${timeout_value}" >&2
    return 127
  fi
  if "$timeout_bin" --kill-after=1s 1s true >/dev/null 2>&1; then
    "$timeout_bin" --kill-after=30s "$timeout_value" "$@"
  else
    "$timeout_bin" "$timeout_value" "$@"
  fi
}

docker_e2e_docker_cmd() {
  local timeout_value="${DOCKER_COMMAND_TIMEOUT:-600s}"
  if [ "${1:-}" = "run" ]; then
    shift
    docker_e2e_docker_run_resource_args "$@" || return $?
    docker_e2e_docker_run_with_resource_diagnostics "$timeout_value" "$@"
    return
  fi
  docker_e2e_timeout_cmd "$timeout_value" docker "$@"
}

docker_e2e_docker_run_cmd() {
  local timeout_value="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_DOCKER_E2E_RUN_TIMEOUT:-3600s}}"
  if [ "${1:-}" = "run" ]; then
    shift
    docker_e2e_docker_run_resource_args "$@" || return $?
    docker_e2e_docker_run_with_resource_diagnostics "$timeout_value" "$@"
    return
  fi
  docker_e2e_timeout_cmd "$timeout_value" docker "$@"
}

docker_e2e_resource_limits_disabled() {
  case "${OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS:-}" in
    1 | true | TRUE | yes | YES | on | ON)
      return 0
      ;;
  esac
  return 1
}

docker_e2e_resource_value_disabled() {
  case "${1:-}" in
    "" | 0 | none | NONE | off | OFF | false | FALSE)
      return 0
      ;;
  esac
  return 1
}

docker_e2e_detect_available_cpus() {
  if [ -n "${OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS:-}" ]; then
    printf '%s\n' "$OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS"
    return 0
  fi
  if command -v nproc >/dev/null 2>&1; then
    nproc
    return 0
  fi
  if command -v getconf >/dev/null 2>&1; then
    getconf _NPROCESSORS_ONLN
    return 0
  fi
  return 1
}

docker_e2e_resolve_cpus() {
  local requested="$1"
  local available=""
  available="$(docker_e2e_detect_available_cpus 2>/dev/null || true)"
  if [[ "$requested" =~ ^[0-9]+$ ]] && [[ "$available" =~ ^[0-9]+$ ]] && [ "$requested" -gt "$available" ]; then
    printf '%s\n' "$available"
    return 0
  fi
  printf '%s\n' "$requested"
}

docker_e2e_run_arg_present() {
  local option="$1"
  shift
  local arg
  for arg in "$@"; do
    if [ "$arg" = "$option" ] || [[ "$arg" == "$option="* ]]; then
      return 0
    fi
    case "$option:$arg" in
      --memory:-m | --memory:-m=*)
        return 0
        ;;
    esac
  done
  return 1
}

docker_e2e_resolve_pids_limit() {
  local pids_limit="$1"
  if [[ ! "$pids_limit" =~ ^[0-9]+$ ]] || (( 10#$pids_limit < 1 )); then
    echo "invalid OPENCLAW_DOCKER_E2E_PIDS_LIMIT: $pids_limit" >&2
    return 2
  fi
  printf '%s\n' "$((10#$pids_limit))"
}

docker_e2e_docker_run_resource_args() {
  DOCKER_E2E_RUN_RESOURCE_ARGS=()
  if docker_e2e_resource_limits_disabled; then
    return 0
  fi

  local memory="${OPENCLAW_DOCKER_E2E_MEMORY:-8g}"
  local cpus="${OPENCLAW_DOCKER_E2E_CPUS:-16}"
  local pids_limit="${OPENCLAW_DOCKER_E2E_PIDS_LIMIT:-2048}"
  cpus="$(docker_e2e_resolve_cpus "$cpus")"

  if ! docker_e2e_resource_value_disabled "$memory" && ! docker_e2e_run_arg_present --memory "$@"; then
    DOCKER_E2E_RUN_RESOURCE_ARGS+=(--memory "$memory")
  fi
  if ! docker_e2e_resource_value_disabled "$cpus" && ! docker_e2e_run_arg_present --cpus "$@"; then
    DOCKER_E2E_RUN_RESOURCE_ARGS+=(--cpus "$cpus")
  fi
  if ! docker_e2e_resource_value_disabled "$pids_limit" && ! docker_e2e_run_arg_present --pids-limit "$@"; then
    pids_limit="$(docker_e2e_resolve_pids_limit "$pids_limit")" || return $?
    DOCKER_E2E_RUN_RESOURCE_ARGS+=(--pids-limit "$pids_limit")
  fi
}

docker_e2e_container_running() {
  local container_name="$1"
  [ "$(docker_e2e_docker_cmd inspect -f '{{.State.Running}}' "$container_name" 2>/dev/null || echo false)" = "true" ]
}

docker_e2e_container_exec_bash() {
  local container_name="$1"
  shift
  docker_e2e_docker_cmd exec "$container_name" bash -lc "$*"
}

docker_e2e_wait_container_bash() {
  local container_name="$1"
  shift
  docker_e2e_wait_container_bash_while_running "$container_name" "$container_name" "$@"
}

docker_e2e_wait_container_bash_while_running() {
  local running_container_name="$1"
  local exec_container_name="$2"
  local attempts="$3"
  local sleep_seconds="$4"
  shift 4
  local probe="$*"

  for _ in $(seq 1 "$attempts"); do
    if ! docker_e2e_container_running "$running_container_name"; then
      return 1
    fi
    if docker_e2e_container_exec_bash "$exec_container_name" "$probe" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
  done
  return 1
}

docker_e2e_tail_container_file_if_running() {
  local container_name="$1"
  local file_path="$2"
  local lines="${3:-120}"
  if docker_e2e_container_running "$container_name"; then
    docker_e2e_container_exec_bash "$container_name" "tail -n $lines $file_path" || true
  else
    docker_e2e_docker_cmd logs "$container_name" 2>&1 | tail -n "$lines" || true
  fi
}
