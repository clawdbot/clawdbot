#!/bin/bash
# Auth Expiry Monitor
# Run via cron or systemd timer to get proactive notifications
# before Claude Code auth expires.
#
# Suggested cron: */30 * * * * /path/to/openclaw/scripts/auth-monitor.sh
#
# Environment variables:
#   NOTIFY_PHONE - Phone number to send OpenClaw notification (e.g., +1234567890)
#   NOTIFY_NTFY  - ntfy.sh topic for push notifications (e.g., openclaw-alerts)
#   WARN_HOURS   - Hours before expiry to warn (default: 2)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_CREDS="$HOME/.claude/.credentials.json"
STATE_FILE="$HOME/.openclaw/auth-monitor-state"

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
    local notification_sent=0

    echo "$(date '+%Y-%m-%d %H:%M:%S') - $message"

    # Check if we notified recently
    if [ $((NOW - LAST_NOTIFIED)) -lt $MIN_INTERVAL ]; then
        echo "Skipping notification (sent recently)"
        return
    fi

    # Send via OpenClaw if phone configured and auth still valid
    if [ -n "$NOTIFY_PHONE" ]; then
        # Check if we can still use openclaw
        if "$SCRIPT_DIR/claude-auth-status.sh" simple 2>/dev/null | grep -q "OK\|EXPIRING"; then
            echo "Sending via OpenClaw to $NOTIFY_PHONE..."
            if openclaw send --to "$NOTIFY_PHONE" --message "$message" 2>/dev/null; then
                notification_sent=1
            fi
        fi
    fi

    # Send via ntfy.sh if configured
    if [ -n "$NOTIFY_NTFY" ]; then
        echo "Sending via ntfy.sh to $NOTIFY_NTFY..."
        if curl -fsS --connect-timeout 5 --max-time 15 -o /dev/null \
            -H "Title: OpenClaw Auth Alert" \
            -H "Priority: $priority" \
            -H "Tags: warning,key" \
            -d "$message" \
            "https://ntfy.sh/$NOTIFY_NTFY"; then
            notification_sent=1
        fi
    fi

    if [ "$notification_sent" -eq 1 ]; then
        echo "$NOW" > "$STATE_FILE"
    else
        echo "No notification delivered; cooldown not updated" >&2
    fi
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
    send_notification "Claude Code auth EXPIRED! OpenClaw is down. Run on the OpenClaw host: ${SCRIPT_DIR}/mobile-reauth.sh" "urgent"
    exit 1
elif [ "$HOURS_LEFT" -lt "$WARN_HOURS" ]; then
    send_notification "Claude Code auth expires in ${HOURS_LEFT}h ${MINS_LEFT}m. Consider re-auth soon." "high"
    exit 0
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Auth OK: ${HOURS_LEFT}h ${MINS_LEFT}m remaining"
    exit 0
fi
