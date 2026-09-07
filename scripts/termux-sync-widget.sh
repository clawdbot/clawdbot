#!/data/data/com.termux/files/usr/bin/bash
# OpenClaw OAuth Sync Widget
# Syncs Claude Code tokens to OpenClaw over SSH
# Place in ~/.shortcuts/ on phone for Termux:Widget

termux-toast "Syncing OpenClaw auth..."

# Run sync on the configured OpenClaw host.
SERVER="${OPENCLAW_SERVER:-openclaw-host}"
RESULT=$(ssh "$SERVER" '$HOME/openclaw/scripts/sync-claude-code-auth.sh' 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    # Extract expiry time from output
    EXPIRY=$(echo "$RESULT" | grep "Token expires:" | cut -d: -f2-)

    termux-vibrate -d 100
    termux-toast "OpenClaw synced! Expires:${EXPIRY}"

    # Optional: restart openclaw service
    ssh "$SERVER" 'systemctl --user restart openclaw' 2>/dev/null
else
    termux-vibrate -d 300
    termux-toast "Sync failed: ${RESULT}"
fi
