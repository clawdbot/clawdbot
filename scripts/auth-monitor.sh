#!/bin/bash
# Auth Expiry Monitor
# Run via cron or systemd timer to get proactive notifications
# before Claude Code auth expires.
#
# Suggested cron: */30 * * * * /home/admin/moltbot/scripts/auth-monitor.sh
#
# Environment variables:
#   NOTIFY_PHONE - Phone number to send Moltbot notification (e.g., +1234567890)
#   NOTIFY_NTFY  - ntfy.sh topic for push notifications (e.g., moltbot-alerts)
#   WARN_HOURS   - Hours before expiry to warn (default: 2)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_CREDS="$HOME/.claude/.credentials.json"
STATE_FILE="$HOME/.clawdbot/auth-monitor-state"

# Configuration
WARN_HOURS="${WARN_HOURS:-2}"
NOTIFY_PHONE="${NOTIFY_PHONE:-}"
NOTIFY_NTFY="${NOTIFY_NTFY:-}"

# State tracking to avoid spam
mkdir -p "$(dirname "$STATE_FILE")"
LAST_NOTIFIED=$(cat "$STATE_FILE" 2>/dev/null || echo "0")
NOW=$(date +%s)

# Only notify once per hour max
MIN_INTERVAL=3600

send_notification() {
    local message="$1"
    local priority="${2:-default}"

    echo "$(date '+%Y-%m-%d %H:%M:%S') - $message"

    # Check if we notified recently
    if [ $((NOW - LAST_NOTIFIED)) -lt $MIN_INTERVAL ]; then
        echo "Skipping notification (sent recently)"
        return
    fi

    # Send via Moltbot if phone configured and auth still valid
    if [ -n "$NOTIFY_PHONE" ]; then
        # Check if we can still use moltbot
        if "$SCRIPT_DIR/claude-auth-status.sh" simple 2>/dev/null | grep -q "OK\|EXPIRING"; then
            echo "Sending via Moltbot to $NOTIFY_PHONE..."
            moltbot send --to "$NOTIFY_PHONE" --message "$message" 2>/dev/null || true
        fi
    fi

    # Send via ntfy.sh if configured
    if [ -n "$NOTIFY_NTFY" ]; then
        echo "Sending via ntfy.sh to $NOTIFY_NTFY..."
        curl -s -o /dev/null \
            -H "Title: Moltbot Auth Alert" \
            -H "Priority: $priority" \
            -H "Tags: warning,key" \
            -d "$message" \
            "https://ntfy.sh/$NOTIFY_NTFY" || true
    fi

    # Update state
    echo "$NOW" > "$STATE_FILE"
}

# Check auth status
if [ ! -f "$CLAUDE_CREDS" ]; then
    send_notification "Claude Code credentials missing! Run: claude setup-token" "high"
    exit 1
fi

EXPIRES_AT=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CLAUDE_CREDS")
NOW_MS=$((NOW * 1000))
DIFF_MS=$((EXPIRES_AT - NOW_MS))
HOURS_LEFT=$((DIFF_MS / 3600000))
MINS_LEFT=$(((DIFF_MS % 3600000) / 60000))

if [ "$DIFF_MS" -lt 0 ]; then
    send_notification "Claude Code auth EXPIRED! Moltbot is down. Run: ssh l36 '~/moltbot/scripts/mobile-reauth.sh'" "urgent"
    exit 1
elif [ "$HOURS_LEFT" -lt "$WARN_HOURS" ]; then
    send_notification "Claude Code auth expires in ${HOURS_LEFT}h ${MINS_LEFT}m. Consider re-auth soon." "high"
    exit 0
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Auth OK: ${HOURS_LEFT}h ${MINS_LEFT}m remaining"
    exit 0
fi
