#!/usr/bin/env bash
# Shared in-container lifecycle helpers for Docker/Bash E2E lanes.
openclaw_e2e_eval_test_state_from_b64() { eval "$(printf '%s' "${1:?missing OpenClaw test-state script}" | base64 -d)"; }
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
openclaw_e2e_install_package() {
  local log_file="$1"
  local label="${2:-mounted OpenClaw package}"
  local prefix="${3:-}"
  local package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
  local args=(-g)
  if [ -n "$prefix" ]; then
    args+=("--prefix" "$prefix")
  fi
  echo "Installing $label..."
  if ! npm install "${args[@]}" "$package_tgz" --no-fund --no-audit >"$log_file" 2>&1; then
    echo "npm install failed for $label" >&2
    cat "$log_file" >&2 || true
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
  local port="$1" attempts="${2:-80}" _
  local probe="fetch('http://127.0.0.1:' + process.argv[1] + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  for _ in $(seq 1 "$attempts"); do
    node -e "$probe" "$port" && return 0
    sleep 0.1
  done
  node -e "$probe" "$port"
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
openclaw_e2e_probe_http_status() {
  node -e 'fetch(process.argv[1]).then(r=>process.exit(r.status===Number(process.argv[2])?0:1)).catch(()=>process.exit(1))' "$1" "${2:-200}"
}
openclaw_e2e_assert_file() { [ -f "$1" ] || { echo "Missing file: $1"; exit 1; }; }
openclaw_e2e_assert_dir() { [ -d "$1" ] || { echo "Missing dir: $1"; exit 1; }; }
openclaw_e2e_assert_log_not_contains() {
  ! grep -q "$2" "$1" || { echo "Unexpected log output: $2"; exit 1; }
}
openclaw_e2e_run_logged() {
  local label="$1" log_path="/tmp/openclaw-onboard-${1}.log"
  shift
  "$@" >"$log_path" 2>&1 || { cat "$log_path"; exit 1; }
}
openclaw_e2e_dump_logs() {
  local path
  for path in "$@"; do
    [ -f "$path" ] || continue
    echo "--- $path ---"; tail -n "${OPENCLAW_E2E_LOG_TAIL_LINES:-120}" "$path" || true
  done
}
