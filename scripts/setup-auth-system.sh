#!/bin/bash
# Setup OpenClaw Auth Management System
# Run this once to set up:
# 1. Long-lived Claude Code token
# 2. Auth monitoring with notifications
# 3. Instructions for Termux widgets

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== OpenClaw Auth System Setup ==="
echo ""

# Step 1: Check current auth status
echo "Step 1: Checking current auth status..."
"$SCRIPT_DIR/claude-auth-status.sh" full || true
echo ""

# Step 2: Set up long-lived token
echo "Step 2: Long-lived token setup"
echo ""
echo "Option A: Use 'claude setup-token' (recommended)"
echo "  - Creates a long-lived API token"
echo "  - No daily re-auth needed"
echo "  - Run: claude setup-token"
echo ""
echo "Would you like to set up a long-lived token now? [y/N]"
read -r SETUP_TOKEN

if [[ "$SETUP_TOKEN" =~ ^[Yy] ]]; then
    echo ""
    echo "Opening https://console.anthropic.com/settings/api-keys"
    echo "Create a new key or copy existing one, then paste below."
    echo ""
    claude setup-token
fi

echo ""

# Step 3: Set up auth monitoring
echo "Step 3: Auth monitoring setup"
echo ""
echo "The auth monitor checks expiry every 30 minutes and notifies you."
echo ""
echo "Configure notification channels:"
echo ""

# Check for ntfy
echo "  ntfy.sh: Free push notifications to your phone"
echo "  1. Install ntfy app on your phone"
echo "  2. Subscribe to a topic (e.g., 'openclaw-alerts')"
echo ""
echo "Enter ntfy.sh topic (or leave blank to skip):"
read -r NTFY_TOPIC

# Phone notification
echo ""
echo "  OpenClaw message: Send warning via OpenClaw itself"
echo "Enter your phone number for alerts (or leave blank to skip):"
read -r PHONE_NUMBER

# Install systemd units
SERVICE_TEMPLATE="$SCRIPT_DIR/systemd/openclaw-auth-monitor.service"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICE_TARGET="$SYSTEMD_USER_DIR/openclaw-auth-monitor.service"
TIMER_TARGET="$SYSTEMD_USER_DIR/openclaw-auth-monitor.timer"
AUTH_MONITOR_PATH="$SCRIPT_DIR/auth-monitor.sh"

echo ""
echo "Installing systemd timer..."
mkdir -p "$SYSTEMD_USER_DIR"

SERVICE_TEMP="$(mktemp "$SYSTEMD_USER_DIR/openclaw-auth-monitor.service.XXXXXX")"
SERVICE_RENDERED=""
cleanup_service_temp() {
    rm -f "$SERVICE_TEMP" "$SERVICE_RENDERED"
}
trap cleanup_service_temp EXIT
SERVICE_RENDERED="$(mktemp "$SYSTEMD_USER_DIR/openclaw-auth-monitor.service.rendered.XXXXXX")"

cp "$SERVICE_TEMPLATE" "$SERVICE_TEMP"

systemd_quote_arg() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//%/%%}"
    value="${value//\$/\$\$}"
    value="${value//\"/\\\"}"
    printf '"%s"' "$value"
}

render_environment_line() {
    local key="$1"
    local placeholder="$2"
    local value="$3"

    if [ -n "$value" ]; then
        printf 'Environment=%s=%s' "$key" "$value"
    else
        printf '# Environment=%s=%s' "$key" "$placeholder"
    fi
}

RENDERED_EXEC_START="ExecStart=$(systemd_quote_arg "$AUTH_MONITOR_PATH")"
RENDERED_NTFY_LINE="$(render_environment_line "NOTIFY_NTFY" "openclaw-alerts" "$NTFY_TOPIC")"
RENDERED_PHONE_LINE="$(render_environment_line "NOTIFY_PHONE" "+1234567890" "$PHONE_NUMBER")"
FOUND_EXEC_START=0
FOUND_NTFY=0
FOUND_PHONE=0

while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^[[:space:]]*ExecStart=.*$ ]]; then
        printf '%s\n' "$RENDERED_EXEC_START"
        FOUND_EXEC_START=1
    elif [[ "$line" =~ ^[[:space:]]*#?[[:space:]]*Environment=NOTIFY_NTFY=.*$ ]]; then
        printf '%s\n' "$RENDERED_NTFY_LINE"
        FOUND_NTFY=1
    elif [[ "$line" =~ ^[[:space:]]*#?[[:space:]]*Environment=NOTIFY_PHONE=.*$ ]]; then
        printf '%s\n' "$RENDERED_PHONE_LINE"
        FOUND_PHONE=1
    else
        printf '%s\n' "$line"
    fi
done < "$SERVICE_TEMP" > "$SERVICE_RENDERED"

if [ "$FOUND_EXEC_START" -ne 1 ]; then
    echo "ERROR: ExecStart line not found in $SERVICE_TEMPLATE" >&2
    exit 1
fi
if [ "$FOUND_NTFY" -ne 1 ]; then
    echo "ERROR: NOTIFY_NTFY placeholder not found in $SERVICE_TEMPLATE" >&2
    exit 1
fi
if [ "$FOUND_PHONE" -ne 1 ]; then
    echo "ERROR: NOTIFY_PHONE placeholder not found in $SERVICE_TEMPLATE" >&2
    exit 1
fi

mv "$SERVICE_RENDERED" "$SERVICE_TEMP"

mv "$SERVICE_TEMP" "$SERVICE_TARGET"
trap - EXIT
cp "$SCRIPT_DIR/systemd/openclaw-auth-monitor.timer" "$TIMER_TARGET"
systemctl --user daemon-reload
systemctl --user enable --now openclaw-auth-monitor.timer

echo "Auth monitor installed and running."
echo ""

# Step 4: Termux widget setup
echo "Step 4: Termux widget setup (for phone)"
echo ""
echo "To set up quick auth from your phone:"
echo ""
echo "1. Install Termux and Termux:Widget from F-Droid"
echo "2. Create ~/.shortcuts/ directory in Termux:"
echo "   mkdir -p ~/.shortcuts"
echo ""
echo "3. Copy the widget scripts:"
echo "   scp $SCRIPT_DIR/termux-quick-auth.sh phone:~/.shortcuts/ClawdAuth"
echo "   scp $SCRIPT_DIR/termux-auth-widget.sh phone:~/.shortcuts/ClawdAuth-Full"
echo ""
echo "4. Make them executable on phone:"
echo "   ssh phone 'chmod +x ~/.shortcuts/Clawd*'"
echo ""
echo "5. Add Termux:Widget to your home screen"
echo "6. Tap the widget to see your auth scripts"
echo ""
echo "The quick widget (ClawdAuth) shows status and opens auth URL if needed."
echo "The full widget (ClawdAuth-Full) provides guided re-auth flow."
echo ""

# Summary
echo "=== Setup Complete ==="
echo ""
echo "What's configured:"
echo "  - Auth status: $SCRIPT_DIR/claude-auth-status.sh"
echo "  - Mobile re-auth: $SCRIPT_DIR/mobile-reauth.sh"
echo "  - Auth monitor: systemctl --user status openclaw-auth-monitor.timer"
echo ""
echo "Quick commands:"
echo "  Check auth:  $SCRIPT_DIR/claude-auth-status.sh"
echo "  Re-auth:     $SCRIPT_DIR/mobile-reauth.sh"
echo "  Test monitor: $SCRIPT_DIR/auth-monitor.sh"
echo ""
