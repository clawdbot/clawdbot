#!/bin/bash
# Mobile-friendly Claude Code re-authentication
# Designed for use via SSH from Termux
#
# This script handles the authentication flow in a way that works
# from a mobile device by:
# 1. Checking if auth is needed
# 2. Running claude setup-token for long-lived auth
# 3. Outputting URLs that can be easily opened on phone

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo "=== Claude Code Mobile Re-Auth ==="
echo ""

# Check current auth status
echo "Checking auth status..."
AUTH_STATUS=$("$SCRIPT_DIR/claude-auth-status.sh" simple 2>/dev/null || echo "ERROR")

case "$AUTH_STATUS" in
    OK)
        echo -e "${GREEN}Auth is valid!${NC}"
        "$SCRIPT_DIR/claude-auth-status.sh" full
        exit 0
        ;;
    CLAUDE_EXPIRING|CLAWDBOT_EXPIRING)
        echo -e "${YELLOW}Auth is expiring soon.${NC}"
        echo ""
        ;;
    *)
        echo -e "${RED}Auth needs refresh.${NC}"
        echo ""
        ;;
esac

echo "Starting long-lived token setup..."
echo ""
echo -e "${CYAN}Instructions:${NC}"
echo "1. Open this URL on your phone:"
echo ""
echo -e "   ${CYAN}https://console.anthropic.com/settings/api-keys${NC}"
echo ""
echo "2. Sign in if needed"
echo "3. Create a new API key or use existing 'Claude Code' key"
echo "4. Copy the key (starts with sk-ant-...)"
echo "5. When prompted below, paste the key"
echo ""
echo "Press Enter when ready to continue..."
read -r

# Run setup-token interactively
echo ""
echo "Running 'claude setup-token'..."
echo "(Follow the prompts and paste your API key when asked)"
echo ""

if claude setup-token; then
    echo ""
    echo -e "${GREEN}Authentication successful!${NC}"
    echo ""
    "$SCRIPT_DIR/claude-auth-status.sh" full

    # Restart moltbot service if running
    if systemctl --user is-active moltbot >/dev/null 2>&1; then
        echo ""
        echo "Restarting moltbot service..."
        systemctl --user restart moltbot
        echo -e "${GREEN}Service restarted.${NC}"
    fi
else
    echo ""
    echo -e "${RED}Authentication failed.${NC}"
    echo "Please try again or check the Claude Code documentation."
    exit 1
fi
