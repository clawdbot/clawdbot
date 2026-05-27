#!/usr/bin/env bash
# Shared in-container lifecycle helpers for Docker/Bash E2E lanes.
openclaw_e2e_eval_test_state_from_b64() {
  local encoded="${1:?missing OpenClaw test-state script}"
  local decoded
  if ! decoded="$(printf '%s' "$encoded" | base64 -d)"; then
    echo "Invalid OpenClaw test-state base64 payload" >&2
    return 1
  fi
  if [ -z "${decoded//[[:space:]]/}" ]; then
    echo "OpenClaw test-state base64 payload decoded to an empty script" >&2
    return 1
  fi
  eval "$decoded"
}
openclaw_e2e_resolve_entrypoint() {
  local entry
  for entry in dist/index.mjs dist/index.js; do
    [ -f "$entry" ] && { printf '%s\n' "$entry"; return 0; }
  done
  echo "OpenClaw entrypoint not found under dist/" >&2
  return 1
}
openclaw_e2e_package_root() {
  local prefix="${1:-}"
  if [ -n "$prefix" ]; then
    printf '%s/lib/node_modules/openclaw\n' "$prefix"
    return 0
  fi
  printf '%s/openclaw\n' "$(npm root -g)"
}
openclaw_e2e_package_entrypoint() {
  local root="${1:?missing package root}"
  local entry
  for entry in "$root/dist/index.mjs" "$root/dist/index.js"; do
    [ -f "$entry" ] && { printf '%s\n' "$entry"; return 0; }
  done
  echo "OpenClaw package entrypoint not found under $root/dist/" >&2
  return 1
}
openclaw_e2e_maybe_timeout() {
  local timeout_value="$1"
  shift
  if [ -z "$timeout_value" ] || [ "$timeout_value" = "0" ]; then
    "$@"
    return
  fi
  local timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_bin="gtimeout"
  fi
  if [ -z "$timeout_bin" ]; then
    if command -v node >/dev/null 2>&1; then
      echo "timeout command not found; using Node watchdog for OpenClaw E2E command timeout $timeout_value" >&2
      node - "$timeout_value" "$@" <<'NODE'
const [, , timeoutValue, command, ...args] = process.argv;
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
  console.error(`OpenClaw E2E command timed out after ${timeoutValue}`);
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
NODE
      return
    fi
    echo "timeout command not found and Node is unavailable; cannot bound OpenClaw E2E command after $timeout_value" >&2
    return 127
  fi
  if "$timeout_bin" --kill-after=1s 1s true >/dev/null 2>&1; then
    "$timeout_bin" --kill-after=30s "$timeout_value" "$@"
  else
    "$timeout_bin" "$timeout_value" "$@"
  fi
}
openclaw_e2e_install_package() {
  local log_file="$1"
  local label="${2:-mounted OpenClaw package}"
  local prefix="${3:-}"
  local package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
  local timeout_value="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}"
  local args=(-g)
  if [ -n "$prefix" ]; then
    args+=("--prefix" "$prefix")
  fi
  echo "Installing $label..."
  local had_errexit=0
  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e
  openclaw_e2e_maybe_timeout "$timeout_value" npm install "${args[@]}" "$package_tgz" --no-fund --no-audit >"$log_file" 2>&1
  local install_status=$?
  if [ "$had_errexit" -eq 1 ]; then
    set -e
  else
    set +e
  fi
  if [ "$install_status" -ne 0 ]; then
    if [ "$install_status" -eq 124 ] || [ "$install_status" -eq 137 ]; then
      echo "npm install timed out after $timeout_value for $label" >&2
    fi
    echo "npm install failed for $label" >&2
    if [ -f "$log_file" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        printf '%s\n' "$line" >&2
      done <"$log_file"
    fi
    exit 1
  fi
}
openclaw_e2e_assert_package_extensions() {
  local root="$1"
  shift
  local extension
  for extension in "$@"; do
    [ -d "$root/dist/extensions/$extension" ] || {
      echo "Missing packaged extension: $extension" >&2
      exit 1
    }
  done
}
openclaw_e2e_find_dep_package() {
  local dep_path="$1"
  shift
  find "$@" -path "*/node_modules/$dep_path/package.json" -print -quit 2>/dev/null || true
}
openclaw_e2e_assert_dep_absent() {
  local dep_path="$1"
  shift
  if [ -n "$(openclaw_e2e_find_dep_package "$dep_path" "$@")" ]; then
    echo "$dep_path should not be installed" >&2
    find "$@" -path "*/node_modules/$dep_path/package.json" -print 2>/dev/null >&2 || true
    exit 1
  fi
}
openclaw_e2e_assert_dep_present() {
  local dep_path="$1"
  shift
  if [ -n "$(openclaw_e2e_find_dep_package "$dep_path" "$@")" ]; then
    return 0
  fi
  echo "$dep_path was not installed on demand" >&2
  find "$@" -maxdepth 6 -type d -name node_modules -print 2>/dev/null >&2 || true
  exit 1
}
openclaw_e2e_write_state_env() {
  local target="${1:-/tmp/openclaw-test-state-env}"
  {
    printf 'export HOME=%q\n' "$HOME"
    printf 'export OPENCLAW_HOME=%q\n' "$OPENCLAW_HOME"
    printf 'export OPENCLAW_STATE_DIR=%q\n' "$OPENCLAW_STATE_DIR"
    printf 'export OPENCLAW_CONFIG_PATH=%q\n' "$OPENCLAW_CONFIG_PATH"
    printf 'export OPENCLAW_AGENT_DIR=%q\n' "${OPENCLAW_AGENT_DIR-}"
    printf 'export PI_CODING_AGENT_DIR=%q\n' "${PI_CODING_AGENT_DIR-}"
  } >"$target"
}
openclaw_e2e_install_trash_shim() {
  export PATH="/tmp/openclaw-bin:$PATH"
  mkdir -p /tmp/openclaw-bin
  cat >/tmp/openclaw-bin/trash <<'TRASH'
#!/usr/bin/env bash
set -euo pipefail
trash_dir="$HOME/.Trash"
mkdir -p "$trash_dir"
for target in "$@"; do
  [ -e "$target" ] || continue
  base="$(basename "$target")"
  dest="$trash_dir/$base"
  [ -e "$dest" ] && dest="$trash_dir/${base}-$(date +%s)-$$"
  mv "$target" "$dest"
done
TRASH
  chmod +x /tmp/openclaw-bin/trash
}
openclaw_e2e_run_script_with_pty() {
  local command="$1"
  local log_path="$2"
  local timeout_value="${OPENCLAW_E2E_COMMAND_TIMEOUT:-300s}"
  if script --version >/dev/null 2>&1; then
    openclaw_e2e_maybe_timeout "$timeout_value" script -q -f -c "$command" "$log_path"
  elif node -e 'import("@lydell/node-pty")' >/dev/null 2>&1; then
    openclaw_e2e_maybe_timeout "$timeout_value" node scripts/e2e/lib/run-with-pty.mjs "$log_path" /bin/bash -lc "$command"
  else
    openclaw_e2e_maybe_timeout "$timeout_value" script -q -F "$log_path" /bin/bash -lc "$command"
  fi
}
openclaw_e2e_stop_process() {
  local pid="${1:-}" _
  [ -n "$pid" ] || return 0
  kill "$pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    ! kill -0 "$pid" >/dev/null 2>&1 && { wait "$pid" >/dev/null 2>&1 || true; return 0; }
    sleep 0.25
  done
  kill -9 "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}
openclaw_e2e_terminate_gateways() {
  local pid="${1:-}" _
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  if command -v pkill >/dev/null 2>&1; then
    pkill -TERM -f "[o]penclaw-gateway" 2>/dev/null || true
  fi
  for _ in $(seq 1 100); do
    local alive=0
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      alive=1
    fi
    if command -v pgrep >/dev/null 2>&1 && pgrep -f "[o]penclaw-gateway" >/dev/null 2>&1; then
      alive=1
    fi
    [ "$alive" = "0" ] && break
    sleep 0.1
  done
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  if command -v pkill >/dev/null 2>&1; then
    pkill -KILL -f "[o]penclaw-gateway" 2>/dev/null || true
  fi
  if [ -n "$pid" ]; then
    wait "$pid" 2>/dev/null || true
  fi
}
openclaw_e2e_start_mock_openai() { MOCK_PORT="$1" node scripts/e2e/mock-openai-server.mjs >"$2" 2>&1 & printf '%s\n' "$!"; }
openclaw_e2e_wait_mock_openai() {
  local port="$1" attempts="${2:-80}" timeout_ms="${3:-400}" _
  for _ in $(seq 1 "$attempts"); do
    openclaw_e2e_probe_http "http://127.0.0.1:${port}/health" ok "$timeout_ms" && return 0
    sleep 0.1
  done
  openclaw_e2e_probe_http "http://127.0.0.1:${port}/health" ok "$timeout_ms"
}
openclaw_e2e_start_gateway() { node "$1" gateway --port "$2" --bind loopback --allow-unconfigured >"$3" 2>&1 & printf '%s\n' "$!"; }
openclaw_e2e_exec_gateway() { exec node "$1" gateway --port "$2" --bind "${3:-loopback}" --allow-unconfigured >"$4" 2>&1; }
openclaw_e2e_wait_gateway_ready() {
  local pid="$1" log="$2" attempts="${3:-300}" _
  for _ in $(seq 1 "$attempts"); do
    ! kill -0 "$pid" >/dev/null 2>&1 && {
      echo "Gateway exited before becoming ready"
      wait "$pid" || true
      tail -n 120 "$log" 2>/dev/null || true
      return 1
    }
    grep -q '\[gateway\] ready' "$log" 2>/dev/null && return 0
    sleep 0.25
  done
  echo "Gateway did not become ready"
  tail -n 120 "$log" 2>/dev/null || true
  return 1
}
openclaw_e2e_probe_tcp() {
  node --input-type=module -e '
    import net from "node:net";
    const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
    const timeout = setTimeout(() => { socket.destroy(); process.exit(1); }, Number(process.argv[3] ?? 400));
    socket.on("connect", () => { clearTimeout(timeout); socket.end(); process.exit(0); });
    socket.on("error", () => { clearTimeout(timeout); process.exit(1); });
  ' "$1" "$2" "${3:-400}"
}
openclaw_e2e_probe_http() {
  node --input-type=module -e '
    const expected = process.argv[2] ?? "ok";
    const timeoutMs = Number(process.argv[3] ?? 400);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let exitCode = 1;
    try {
      const response = await fetch(process.argv[1], { signal: controller.signal });
      const passed = expected === "ok" ? response.ok : response.status === Number(expected);
      exitCode = passed ? 0 : 1;
    } catch {
      exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
    process.exit(exitCode);
  ' "$1" "${2:-ok}" "${3:-400}"
}
openclaw_e2e_probe_http_status() {
  openclaw_e2e_probe_http "$1" "${2:-200}" "${3:-400}"
}
openclaw_e2e_assert_file() { [ -f "$1" ] || { echo "Missing file: $1"; exit 1; }; }
openclaw_e2e_assert_dir() { [ -d "$1" ] || { echo "Missing dir: $1"; exit 1; }; }
openclaw_e2e_assert_log_not_contains() {
  ! grep -q "$2" "$1" || { echo "Unexpected log output: $2"; exit 1; }
}
openclaw_e2e_run_logged() {
  local label="$1" log_path="/tmp/openclaw-onboard-${1}.log"
  shift
  openclaw_e2e_run_command "$@" >"$log_path" 2>&1 || { cat "$log_path"; exit 1; }
}
openclaw_e2e_run_command() {
  local timeout_value="${OPENCLAW_E2E_COMMAND_TIMEOUT:-300s}"
  openclaw_e2e_maybe_timeout "$timeout_value" "$@"
}
openclaw_e2e_enable_openclaw_cli_timeout() {
  OPENCLAW_E2E_CLI_BIN="$(type -P openclaw)"
  if [ -z "$OPENCLAW_E2E_CLI_BIN" ]; then
    echo "OpenClaw CLI binary not found on PATH" >&2
    return 1
  fi
  export OPENCLAW_E2E_CLI_BIN
  openclaw() {
    openclaw_e2e_run_command "$OPENCLAW_E2E_CLI_BIN" "$@"
  }
}
openclaw_e2e_dump_logs() {
  local path
  for path in "$@"; do
    [ -f "$path" ] || continue
    echo "--- $path ---"; tail -n "${OPENCLAW_E2E_LOG_TAIL_LINES:-120}" "$path" || true
  done
}
