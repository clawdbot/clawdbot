#!/usr/bin/env bash
#
# Shared helpers for Docker E2E scripts that keep a named container running
# while polling readiness from the host.

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
  setTimeout(() => killChild("SIGKILL"), 30_000).unref();
}, timeoutMs);
const forwardSignal = (signal) => {
  killChild(signal);
};
process.once("SIGINT", forwardSignal);
process.once("SIGTERM", forwardSignal);
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) {
    process.exit(124);
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
  docker_e2e_timeout_cmd "${DOCKER_COMMAND_TIMEOUT:-600s}" docker "$@"
}

docker_e2e_docker_run_cmd() {
  docker_e2e_timeout_cmd "${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_DOCKER_E2E_RUN_TIMEOUT:-3600s}}" docker "$@"
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
