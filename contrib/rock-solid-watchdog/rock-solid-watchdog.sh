#!/bin/bash
# ============================================================
# OpenClaw Rock-Solid Watchdog
# ============================================================
# Features:
#   - llama.cpp server health monitoring & auto-restart
#   - Pi assistant port alignment with llama.cpp
#   - Gateway health checks
#   - Telegram & VPN connectivity
#   - macOS & Telegram notifications
# ============================================================

set -uo pipefail

# ─── Config ──────────────────────────────────────────────────

# llama.cpp / Qwen watch
ENABLE_LLAMA_WATCH="${ENABLE_LLAMA_WATCH:-1}"
LLAMA_SERVER="${LLAMA_SERVER:-$HOME/llama.cpp/build/bin/llama-server}"
LLAMA_PORT="${LLAMA_PORT:-8084}"
LLAMA_HOST="${LLAMA_HOST:-127.0.0.1}"
LLAMA_MODEL="${LLAMA_MODEL:-}"
LLAMA_START_SCRIPT="${LLAMA_START_SCRIPT:-$HOME/tools/start-qwen-coder-14b.sh}"

# Pi assistant configuration
PI_PORT="${PI_PORT:-8084}"
PI_HOST="${PI_HOST:-127.0.0.1}"
PI_CONFIG_DIR="${PI_CONFIG_DIR:-$HOME/.pi}"
PI_CONFIG_FILE="${PI_CONFIG_FILE:-$PI_CONFIG_DIR/config.json}"

# Backward compat: Qwen vars map to llama
ENABLE_QWEN_WATCH="${ENABLE_QWEN_WATCH:-$ENABLE_LLAMA_WATCH}"
QWEN_PORT="${QWEN_PORT:-$LLAMA_PORT}"
QWEN_PROXY_PORT="${QWEN_PROXY_PORT:-8083}"
QWEN_START_SCRIPT="${QWEN_START_SCRIPT:-$LLAMA_START_SCRIPT}"

# Gateway
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_LOG="${GATEWAY_LOG:-$HOME/.openclaw/logs/gateway.log}"

# Heal & cooldown
MAX_CONSECUTIVE_FAILS="${MAX_CONSECUTIVE_FAILS:-5}"
COOLDOWN_SEC="${COOLDOWN_SEC:-180}"
DISPATCH_FAIL_WINDOW_SEC="${DISPATCH_FAIL_WINDOW_SEC:-180}"
DISPATCH_FAIL_MIN_HITS="${DISPATCH_FAIL_MIN_HITS:-8}"
MAX_HEALS_PER_HOUR="${MAX_HEALS_PER_HOUR:-1000}"
GATEWAY_LOG_STALE_SEC="${GATEWAY_LOG_STALE_SEC:-600}"

# Features
ENABLE_KEEPAWAKE="${ENABLE_KEEPAWAKE:-0}"
ENABLE_ZEROTIER_HEAL="${ENABLE_ZEROTIER_HEAL:-1}"
NOTIFY_MACOS="${NOTIFY_MACOS:-1}"
NOTIFY_TELEGRAM="${NOTIFY_TELEGRAM:-1}"
VERBOSE="${VERBOSE:-0}"
DRY_RUN="${DRY_RUN:-0}"

# Globals
CONSECUTIVE_FAILS=0
HEAL_COUNT=0
HEAL_HOUR_START=$(date +%s)
LOG_FILE="${LOG_FILE:-$HOME/.openclaw/logs/watchdog.log}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/.openclaw/bin}"

# Ensure log dir
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$PI_CONFIG_DIR"

# ─── Helpers ─────────────────────────────────────────────────

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }
info() { log "INFO: $*"; [[ "${VERBOSE:-0}" == "1" ]] && echo "INFO: $*"; }
warn() { log "WARN: $*"; echo "WARN: $*" >&2; }
err()  { log "ERROR: $*"; echo "ERROR: $*" >&2; }

notify_macos() {
  [[ "$NOTIFY_MACOS" != "1" ]] && return 0
  local title="$1" msg="$2"
  osascript -e "display notification \"$msg\" with title \"Watchdog: $title\"" 2>/dev/null || true
}

notify_telegram() {
  [[ "$NOTIFY_TELEGRAM" != "1" ]] && return 0
  local title="$1" msg="$2"
  local bot_token="${TELEGRAM_BOT_TOKEN:-}"
  local chat_id="${TELEGRAM_CHAT_ID:-}"
  [[ -z "$bot_token" || -z "$chat_id" ]] && return 0
  curl -s -X POST "https://api.telegram.org/bot${bot_token}/sendMessage" \
    -d "chat_id=${chat_id}" \
    -d "text=🔔 Watchdog: ${title} — ${msg}" \
    -d "disable_notification=true" >/dev/null 2>&1 || true
}

bark() {
  local title="$1" detail="$2"
  log "bark: $title — $detail"
  notify_macos "$title" "$detail"
  notify_telegram "$title" "$detail"
}

bark_smart() {
  local _title="$1" _body="$2"
  # Suppress Gemma-related barks (retired)
  if [[ "$_title" == *[Gg]emma* || "$_body" == *[Gg]emma* ||
        "$_title" == *start-gemma* || "$_body" == *start-gemma* ||
        "$_title" == *8095* ]]; then
    log "bark_smart suppressed (gemma retired): $_title — $_body"
    return 0
  fi
  bark "$_title" "$_body"
}

# Rate-limited heals per hour
check_heal_rate() {
  local now
  now=$(date +%s)
  if (( now - HEAL_HOUR_START >= 3600 )); then
    HEAL_COUNT=0
    HEAL_HOUR_START="$now"
  fi
  if (( HEAL_COUNT >= MAX_HEALS_PER_HOUR )); then
    warn "Heal rate limit reached ($MAX_HEALS_PER_HOUR/hr). Skipping."
    return 1
  fi
  return 0
}

# ─── llama.cpp Health & Restart ──────────────────────────────

check_llama_health() {
  local port="${1:-$LLAMA_PORT}"
  local host="${2:-$LLAMA_HOST}"

  # Check if process is running
  local pid
  pid=$(pgrep -f "llama-server" 2>/dev/null | head -1)
  if [[ -z "$pid" ]]; then
    echo "down:no_process"
    return 1
  fi

  # Check if port is listening
  if command -v lsof >/dev/null 2>&1; then
    if ! lsof -iTCP:"$port" -sTCP:LISTEN -P -n 2>/dev/null | grep -q .; then
      echo "down:port_not_listening"
      return 1
    fi
  fi

  # Health check via HTTP
  local health_url="${host}:${port}/health"
  if curl -sf --connect-timeout 3 --max-time 5 "http://${health_url}" >/dev/null 2>&1; then
    echo "up:pid=${pid}"
    return 0
  fi

  # Try completion endpoint
  local complete_url="${host}:${port}/v1/completions"
  if curl -sf --connect-timeout 3 --max-time 5 "http://${complete_url}" >/dev/null 2>&1; then
    echo "up:pid=${pid}"
    return 0
  fi

  echo "down:health_checks_failed"
  return 1
}

restart_llama() {
  local reason="$1"
  info "Restarting llama.cpp server (reason: $reason)..."

  # Kill existing llama-server processes
  local pids
  pids=$(pgrep -f "llama-server" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    info "Killing existing llama-server PIDs: $pids"
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 2
    # Force kill if still running
    pids=$(pgrep -f "llama-server" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill -KILL 2>/dev/null || true
      sleep 1
    fi
  fi

  # Use the start script if available
  if [[ -x "$LLAMA_START_SCRIPT" ]]; then
    info "Starting via $LLAMA_START_SCRIPT"
    if [[ "$DRY_RUN" == "1" ]]; then
      log "DRY_RUN: would run $LLAMA_START_SCRIPT"
      return 0
    fi
    nohup bash "$LLAMA_START_SCRIPT" >> "$LOG_FILE" 2>&1 &
    local start_pid=$!
    info "Start script launched (pid=$start_pid)"
  elif [[ -x "$LLAMA_SERVER" ]]; then
    info "Starting llama-server directly: $LLAMA_SERVER"
    if [[ "$DRY_RUN" == "1" ]]; then
      log "DRY_RUN: would run $LLAMA_SERVER"
      return 0
    fi
    local cmd=("$LLAMA_SERVER" --host "$LLAMA_HOST" --port "$LLAMA_PORT")
    if [[ -n "$LLAMA_MODEL" ]]; then
      cmd+=(-m "$LLAMA_MODEL")
    fi
    nohup "${cmd[@]}" >> "$LOG_FILE" 2>&1 &
    local direct_pid=$!
    info "llama-server launched directly (pid=$direct_pid)"
  else
    err "No llama-server binary found at $LLAMA_SERVER and no start script at $LLAMA_START_SCRIPT"
    bark "LLAMA START FAILED" "no binary or script found"
    return 1
  fi

  # Wait for server to come up
  local waited=0
  while (( waited < 30 )); do
    sleep 2
    if check_llama_health >/dev/null 2>&1; then
      info "llama.cpp server is UP after restart"
      bark_smart "llama.cpp restarted" "on port $LLAMA_PORT"
      return 0
    fi
    waited=$((waited + 2))
  done

  err "llama.cpp server failed to start within 30s"
  bark "LLAMA START FAILED" "port $LLAMA_PORT not healthy after 30s"
  CONSECUTIVE_FAILS=$((CONSECUTIVE_FAILS + 1))
  return 1
}

watch_llama() {
  [[ "$ENABLE_LLAMA_WATCH" != "1" ]] && return 0

  local health
  health=$(check_llama_health 2>/dev/null) || health="down:unknown"

  if [[ "$health" == up:* ]]; then
    CONSECUTIVE_FAILS=0
    return 0
  fi

  info "llama.cpp is DOWN: $health"
  CONSECUTIVE_FAILS=$((CONSECUTIVE_FAILS + 1))

  if (( CONSECUTIVE_FAILS % MAX_CONSECUTIVE_FAILS != 0 )); then
    info "llama.cpp: ${CONSECUTIVE_FAILS}/${MAX_CONSECUTIVE_FAILS} consecutive fails — waiting"
    return 0
  fi

  restart_llama "$health"
}

# ─── Pi Port Alignment ────────────────────────────────────────

ensure_pi_port_alignment() {
  local llama_port="${LLAMA_PORT:-8084}"

  # Create/ensure Pi config
  if [[ ! -f "$PI_CONFIG_FILE" ]]; then
    info "Creating Pi config at $PI_CONFIG_FILE"
    mkdir -p "$(dirname "$PI_CONFIG_FILE")"
    cat > "$PI_CONFIG_FILE" <<-EOF
{
  "llm": {
    "host": "$LLAMA_HOST",
    "port": $llama_port,
    "provider": "llama.cpp"
  },
  "sync_from_watchdog": true,
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    bark "Pi config created" "llama.cpp endpoint set to ${LLAMA_HOST}:${llama_port}"
    return 0
  fi

  # Check current port in Pi config and update if misaligned
  local current_pi_port
  current_pi_port=$(grep -o '"port": *[0-9]*' "$PI_CONFIG_FILE" 2>/dev/null | grep -o '[0-9]*' | head -1)
  local current_pi_host
  current_pi_host=$(grep -o '"host": *"[^"]*"' "$PI_CONFIG_FILE" 2>/dev/null | cut -d'"' -f4 | head -1)

  if [[ "$current_pi_port" != "$llama_port" || "${current_pi_host:-}" != "$LLAMA_HOST" ]]; then
    info "Updating Pi config: host ${current_pi_host:-?}:${current_pi_port:-?} → ${LLAMA_HOST}:${llama_port}"
    # Read current config, update port/host, write back
    local tmpfile
    tmpfile=$(mktemp)
    python3 -c "
import json
try:
    with open('$PI_CONFIG_FILE') as f:
        cfg = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    cfg = {}
if 'llm' not in cfg:
    cfg['llm'] = {}
cfg['llm']['host'] = '$LLAMA_HOST'
cfg['llm']['port'] = $llama_port
cfg['llm']['provider'] = 'llama.cpp'
cfg['sync_from_watchdog'] = True
cfg['updated_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('$tmpfile', 'w') as f:
    json.dump(cfg, f, indent=2)
" 2>/dev/null || {
      warn "Failed to update Pi config via Python; fallback to sed"
      sed -i '' "s/\"port\": [0-9]*/\"port\": $llama_port/" "$PI_CONFIG_FILE" 2>/dev/null || true
      sed -i '' "s/\"host\": \"[^\"]*\"/\"host\": \"$LLAMA_HOST\"/" "$PI_CONFIG_FILE" 2>/dev/null || true
      rm -f "$tmpfile"
      return 0
    }
    mv "$tmpfile" "$PI_CONFIG_FILE"
    info "Pi config updated successfully"
    bark "Pi port aligned" "→ ${LLAMA_HOST}:${llama_port}"
  else
    [[ "${VERBOSE:-0}" == "1" ]] && info "Pi config already aligned: ${LLAMA_HOST}:${llama_port}"
  fi
}

# ─── Gateway Health ──────────────────────────────────────────

check_gateway_health() {
  local url="http://127.0.0.1:${GATEWAY_PORT}/health"
  if curl -sf --connect-timeout 3 --max-time 5 "$url" >/dev/null 2>&1; then
    echo "up"
    return 0
  fi
  # Check if process is running
  local pid
  pid=$(pgrep -f 'openclaw.*gateway' 2>/dev/null | head -1)
  if [[ -n "$pid" ]]; then
    echo "process_running_but_unhealthy"
    return 1
  fi
  echo "down"
  return 2
}

# ─── Network Checks ──────────────────────────────────────────

tailnet_up() {
  curl -4 -fsS --connect-timeout 5 --max-time 10 -o /dev/null "https://tailscale.com" 2>/dev/null
}

zerotier_up() {
  command -v zerotier-cli >/dev/null 2>&1 && zerotier-cli info 2>/dev/null | grep -q ONLINE
}

tailnet_ip() {
  if command -v tailscale >/dev/null 2>&1; then
    tailscale status 2>/dev/null | grep -E '^\d+\.\d+\.\d+\.\d+' | head -1 | awk '{print $1}'
  fi
}

zerotier_ip() {
  if command -v zerotier-cli >/dev/null 2>&1; then
    zerotier-cli listnetworks 2>/dev/null | grep -E '^\d+' | awk '{print $NF}' | head -1
  fi
}

# ─── Keepalive ───────────────────────────────────────────────

keepawake() {
  [[ "$ENABLE_KEEPAWAKE" != "1" ]] && return 0
  caffeinate -u -t 5 2>/dev/null || true
}

# ─── Main Watchdog Loop ──────────────────────────────────────

# Fallback: read config from openclaw.json
maybe_read_openclaw_config() {
  local cfg="$HOME/.openclaw/openclaw.json"
  if [[ -f "$cfg" ]]; then
    python3 -c "
import json, os
with open(os.path.expanduser('$cfg')) as f:
    try:
        d = json.load(f)
    except:
        d = {}
# Extract llama-related settings
llm_cfg = d.get('llm', {}) or {}
print(f'LLAMA_PORT={llm_cfg.get(\"port\", \"$LLAMA_PORT\")}')
print(f'LLAMA_HOST={llm_cfg.get(\"host\", \"$LLAMA_HOST\")}')
" 2>/dev/null | while IFS='=' read -r key val; do
      case "$key" in
        LLAMA_PORT) LLAMA_PORT="$val" ;;
        LLAMA_HOST) LLAMA_HOST="$val" ;;
      esac
    done
  fi
}

main() {
  info "───────────────────────────────────────"
  info "Watchdog started"
  info "llama.cpp: $LLAMA_SERVER on $LLAMA_HOST:$LLAMA_PORT"
  info "Pi config: $PI_CONFIG_FILE"
  info "Gateway: port $GATEWAY_PORT"
  info "Log: $LOG_FILE"
  info "───────────────────────────────────────"

  # Read config overlay
  maybe_read_openclaw_config

  # Ensure Pi port alignment on startup
  ensure_pi_port_alignment

  # Notify startup
  bark "Watchdog started" "llama.cpp on $LLAMA_PORT | log: $LOG_FILE"

  while true; do
    check_heal_rate || continue
    keepawake

    # 1. llama.cpp health check
    watch_llama

    # 2. Pi port alignment (ensure pi always points to llama.cpp port)
    ensure_pi_port_alignment

    # 3. Gateway health check
    local gw
    gw=$(check_gateway_health 2>/dev/null) || true
    case "$gw" in
      up)
        CONSECUTIVE_FAILS=0
        ;;
      process_running_but_unhealthy)
        warn "Gateway process running but not responding"
        ;;
      down)
        err "Gateway is down"
        CONSECUTIVE_FAILS=$((CONSECUTIVE_FAILS + 1))
        if (( CONSECUTIVE_FAILS % MAX_CONSECUTIVE_FAILS == 0 )); then
          bark "Gateway DOWN" "attempting launchctl kickstart"
          launchctl kickstart "gui/$(id -u)/homebrew.mxcl.openclaw" 2>/dev/null || \
            launchctl kickstart "homebrew.mxcl.openclaw" 2>/dev/null || \
            warn "launchctl kickstart failed"
        fi
        ;;
    esac

    sleep 60
  done
}

main "$@"
