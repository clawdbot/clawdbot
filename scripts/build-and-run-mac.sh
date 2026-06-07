#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/macos"

BUILD_PATH=".build-local"
PRODUCT="OpenClaw"
BIN="$BUILD_PATH/debug/$PRODUCT"
BIN_ABS="$(pwd)/$BIN"
APP_CWD="$(pwd -P)"
LOG_PATH="${OPENCLAW_MAC_RUN_LOG:-$(mktemp "${TMPDIR:-/tmp}/openclaw-${PRODUCT}.XXXXXX.log")}"

process_cwd_matches() {
  local pid="$1"
  local cwd=""
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  [[ "$cwd" == "$APP_CWD" ]]
}

local_debug_app_pids() {
  {
    pgrep -f "$BIN_ABS" 2>/dev/null || true
    pgrep -f "$BIN" 2>/dev/null || true
  } | while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if process_cwd_matches "$pid"; then
      printf '%s\n' "$pid"
    fi
  done | sort -u
}

stop_existing_local_app() {
  for _ in {1..10}; do
    local pids=""
    pids="$(local_debug_app_pids)"
    if [[ -z "$pids" ]]; then
      return 0
    fi
    while IFS= read -r pid; do
      kill "$pid" 2>/dev/null || true
    done <<< "$pids"
    sleep 0.3
  done
  return 1
}

printf "\n▶️  Building $PRODUCT (debug, build path: $BUILD_PATH)\n"
swift build -c debug --product "$PRODUCT" --build-path "$BUILD_PATH"

printf "\n⏹  Stopping existing $PRODUCT...\n"
if ! stop_existing_local_app; then
  printf "ERROR: existing local %s process did not exit: %s\n" "$PRODUCT" "$BIN_ABS" >&2
  exit 1
fi

printf "\n🚀 Launching $BIN_ABS ...\n"
nohup "$BIN_ABS" >"$LOG_PATH" 2>&1 &
PID=$!
printf "Started $PRODUCT (PID $PID). Logs: $LOG_PATH\n"
