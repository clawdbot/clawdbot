#!/data/data/com.termux/files/usr/bin/bash
# Moltbot Auth Widget for Termux
# Place in ~/.shortcuts/ for Termux:Widget
#
# This widget checks auth status and helps with re-auth if needed.
# It's designed for quick one-tap checking from phone home screen.

# Server hostname (via Tailscale or SSH config)
SERVER="${CLAWDBOT_SERVER:-l36}"

# Check auth status
termux-toast "Checking Moltbot auth..."

STATUS=$(ssh "$SERVER" '$HOME/moltbot/scripts/claude-auth-status.sh simple' 2>&1)
EXIT_CODE=$?

case "$STATUS" in
    OK)
        # Get remaining time
        DETAILS=$(ssh "$SERVER" '$HOME/moltbot/scripts/claude-auth-status.sh json' 2>&1)
        HOURS=$(echo "$DETAILS" | jq -r '.claude_code.status' | grep -oP '\d+(?=h)' || echo "?")

        termux-vibrate -d 50
        termux-toast "Auth OK (${HOURS}h left)"
        ;;

    CLAUDE_EXPIRING|CLAWDBOT_EXPIRING)
        termux-vibrate -d 100

        # Ask if user wants to re-auth now
        CHOICE=$(termux-dialog radio -t "Auth Expiring Soon" -v "Re-auth now,Check later,Dismiss")
        SELECTED=$(echo "$CHOICE" | jq -r '.text // "Dismiss"')

        case "$SELECTED" in
            "Re-auth now")
                termux-toast "Opening auth page..."
                termux-open-url "https://console.anthropic.com/settings/api-keys"

                # Show instructions
                termux-dialog confirm -t "Re-auth Instructions" -i "1. Create/copy API key from browser
2. Return here and tap OK
3. SSH to server and paste key"

                # Open terminal to server
                am start -n com.termux/com.termux.app.TermuxActivity -a android.intent.action.MAIN
                termux-toast "Run: ssh $SERVER '$HOME/moltbot/scripts/mobile-reauth.sh'"
                ;;
            *)
                termux-toast "Reminder: Auth expires soon"
                ;;
        esac
        ;;

    CLAUDE_EXPIRED|CLAWDBOT_EXPIRED)
        termux-vibrate -d 300

        CHOICE=$(termux-dialog radio -t "Auth Expired!" -v "Re-auth now,Dismiss")
        SELECTED=$(echo "$CHOICE" | jq -r '.text // "Dismiss"')

        case "$SELECTED" in
            "Re-auth now")
                termux-toast "Opening auth page..."
                termux-open-url "https://console.anthropic.com/settings/api-keys"

                termux-dialog confirm -t "Re-auth Steps" -i "1. Create/copy API key from browser
2. Return here and tap OK to SSH"

                am start -n com.termux/com.termux.app.TermuxActivity -a android.intent.action.MAIN
                termux-toast "Run: ssh $SERVER '$HOME/moltbot/scripts/mobile-reauth.sh'"
                ;;
            *)
                termux-toast "Warning: Moltbot won't work until re-auth"
                ;;
        esac
        ;;

    *)
        termux-vibrate -d 200
        termux-toast "Error: $STATUS"
        ;;
esac
