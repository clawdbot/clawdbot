#!/bin/bash
# Auto Re-authentication for Claude Code
# Checks token expiry and helps maintain authentication
#
# Usage:
#   auto-reauth-claude-v2.sh          # Check and sync if needed
#   auto-reauth-claude-v2.sh --force  # Force sync even if not expired
#   auto-reauth-claude-v2.sh --check  # Just check, don't sync

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYCHAIN_SERVICE="Claude Code-credentials"
LOG_FILE="$HOME/.clawdbot/logs/auto-reauth.log"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Logging function
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}$*${NC}" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}$*${NC}" | tee -a "$LOG_FILE"; }
error() { echo -e "${RED}$*${NC}" | tee -a "$LOG_FILE"; }

# Parse arguments
MODE="auto"
if [ "${1:-}" = "--force" ]; then
  MODE="force"
elif [ "${1:-}" = "--check" ]; then
  MODE="check"
fi

log "=== Auto Re-auth Start (mode: $MODE) ==="

# Check if Claude Code token exists in keychain
if ! security find-generic-password -s "$KEYCHAIN_SERVICE" -w &>/dev/null; then
  warn "Claude Code token not found in keychain"
  warn "Please run: claude /login"
  exit 1
fi

# Read token data
TOKEN_DATA=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "dydo" -w 2>/dev/null)
EXPIRES_AT=$(echo "$TOKEN_DATA" | jq -r '.claudeAiOauth.expiresAt // 0')

# Calculate expiry time
CURRENT_TIME=$(date +%s)
EXPIRES_AT_SEC=$((EXPIRES_AT / 1000))
TIME_DIFF=$((EXPIRES_AT_SEC - CURRENT_TIME))
HOURS_LEFT=$((TIME_DIFF / 3600))
MINS_LEFT=$(((TIME_DIFF % 3600) / 60))

# Check if expired or expiring soon
NEEDS_REAUTH=false

if [ $TIME_DIFF -lt 0 ]; then
  warn "Token appears EXPIRED ($((-TIME_DIFF / 3600)) hours ago by timestamp)"
  NEEDS_REAUTH=true
elif [ $TIME_DIFF -lt 3600 ]; then
  warn "Token expiring soon: ${MINS_LEFT} minutes left"
  # Don't auto-reauth for expiring tokens, just sync
fi

# If token appears expired, verify by actually testing Claude Code
if [ "$NEEDS_REAUTH" = true ]; then
  info "Verifying token status by testing Claude Code..."
  
  # Try a simple claude command with timeout (using background job + kill)
  TEST_OUTPUT=$(mktemp)
  (echo "test" | claude --print "reply: ok" > "$TEST_OUTPUT" 2>&1) &
  TEST_PID=$!
  
  # Wait up to 10 seconds
  for i in {1..20}; do
    if ! kill -0 $TEST_PID 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  
  # Kill if still running
  kill -9 $TEST_PID 2>/dev/null || true
  wait $TEST_PID 2>/dev/null || true
  
  # Check output
  if grep -q "ok" "$TEST_OUTPUT" 2>/dev/null; then
    info "✅ Claude Code still works! Token might have auto-refreshed."
    NEEDS_REAUTH=false
    
    # Re-read token data (it might have been refreshed)
    TOKEN_DATA=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "dydo" -w 2>/dev/null)
    EXPIRES_AT=$(echo "$TOKEN_DATA" | jq -r '.claudeAiOauth.expiresAt // 0')
    EXPIRES_AT_SEC=$((EXPIRES_AT / 1000))
    TIME_DIFF=$((EXPIRES_AT_SEC - CURRENT_TIME))
    HOURS_LEFT=$((TIME_DIFF / 3600))
    MINS_LEFT=$(((TIME_DIFF % 3600) / 60))
    
    info "Updated token valid for ${HOURS_LEFT}h ${MINS_LEFT}m"
  else
    error "❌ Claude Code failed - token is truly expired"
    NEEDS_REAUTH=true
  fi
  
  rm -f "$TEST_OUTPUT"
fi

# Exit early if no reauth needed
if [ "$NEEDS_REAUTH" = false ]; then
  if [ "$MODE" = "check" ]; then
    exit 0
  fi
  # Continue to sync section below
else
  # Token is truly expired, need to re-authenticate
  if [ "$MODE" = "check" ]; then
    warn "Token expired and Claude Code not working (check mode, not re-authenticating)"
    exit 1
  fi
  
  info "Attempting automatic re-authentication..."
  
  # Use tmux to run claude /login
  SOCKET="${TMPDIR:-/tmp}/clawdbot-tmux-sockets/clawdbot.sock"
  SESSION="claude-reauth-$$"
  
  # Create tmux session
  mkdir -p "$(dirname "$SOCKET")"
  tmux -S "$SOCKET" new-session -d -s "$SESSION" 2>/dev/null || {
    error "Failed to create tmux session"
    warn "Please run manually: claude /login"
    exit 1
  }
  
  # Send login command
  tmux -S "$SOCKET" send-keys -t "$SESSION" "claude /login" Enter
  sleep 3
  
  # Wait for OAuth page to open in browser
  info "Waiting for OAuth page to open..."
  sleep 5
  
  # Try to click Authorize button if cliclick is available
  if command -v cliclick &>/dev/null; then
    info "Attempting to click Authorize button with cliclick..."
    
    # Use AppleScript to bring Chrome to front and find OAuth window
    osascript <<'APPLESCRIPT' &>/dev/null || true
tell application "Google Chrome"
    activate
    repeat with w in windows
        repeat with t in tabs of w
            if URL of t contains "claude.ai/oauth" then
                set index of w to 1
                set active tab index of w to (index of t)
                return
            end if
        end repeat
    end repeat
end tell
APPLESCRIPT
    
    sleep 2
    
    # Click where the Authorize button typically appears
    # (This assumes standard window size - may need adjustment)
    cliclick c:777,534 2>/dev/null || {
      warn "cliclick failed to click button"
    }
    
    info "Clicked Authorize button position"
  else
    warn "cliclick not installed, cannot auto-click Authorize button"
  fi
  
  # Start interactive responder in background (if available)
  if [ -f "$SCRIPT_DIR/tmux-interactive-responder.sh" ]; then
    "$SCRIPT_DIR/tmux-interactive-responder.sh" \
      -S "$SOCKET" \
      -s "$SESSION" \
      -p "Yes, proceed" \
      -k "2" \
      -k "Enter" \
      -T 120 &
    RESPONDER_PID=$!
    info "Started interactive responder (PID: $RESPONDER_PID)"
  fi
  
  # Wait for OAuth to complete (check token every 5 seconds for 2 minutes)
  info "Waiting for OAuth to complete..."
  for i in {1..24}; do
    sleep 5
    NEW_TOKEN_DATA=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "dydo" -w 2>/dev/null || echo "")
    if [ -n "$NEW_TOKEN_DATA" ]; then
      NEW_EXPIRES_AT=$(echo "$NEW_TOKEN_DATA" | jq -r '.claudeAiOauth.expiresAt // 0')
      if [ "$NEW_EXPIRES_AT" -gt "$EXPIRES_AT" ]; then
        info "OAuth successful! Token updated."
        tmux -S "$SOCKET" kill-session -t "$SESSION" 2>/dev/null || true
        # Update variables for sync
        TOKEN_DATA="$NEW_TOKEN_DATA"
        EXPIRES_AT="$NEW_EXPIRES_AT"
        break
      fi
    fi
    if [ $i -eq 24 ]; then
      error "OAuth timeout (2 minutes)"
      warn "Please check tmux session: tmux -S $SOCKET attach -t $SESSION"
      exit 1
    fi
  done
  
  # Cleanup
  [ -n "${RESPONDER_PID:-}" ] && kill "$RESPONDER_PID" 2>/dev/null || true
fi

# At this point, either token is valid or has been refreshed
# Check final status for logging
if [ $TIME_DIFF -lt 0 ]; then
  # This shouldn't happen after reauth, but just in case
  error "Token still expired after reauth attempt"
  exit 1
elif [ $TIME_DIFF -lt 3600 ]; then
  warn "Token valid but expiring soon: ${MINS_LEFT} minutes left"
elif [ "$MODE" = "force" ] || [ "$MODE" = "check" ]; then
  info "Token valid for ${HOURS_LEFT}h ${MINS_LEFT}m"
else
  log "Token valid for ${HOURS_LEFT}h ${MINS_LEFT}m (OK)"
fi

# Exit if check-only mode
if [ "$MODE" = "check" ]; then
  exit 0
fi

# Sync to Clawdbot
if [ -f "$SCRIPT_DIR/sync-anthropic-keychain.sh" ]; then
  info "Syncing token to Clawdbot..."
  if "$SCRIPT_DIR/sync-anthropic-keychain.sh"; then
    info "Sync successful"
  else
    error "Sync failed"
    exit 1
  fi
else
  warn "sync-anthropic-keychain.sh not found, skipping sync"
fi

log "=== Auto Re-auth Complete ==="
