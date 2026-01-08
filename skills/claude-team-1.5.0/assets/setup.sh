#!/bin/bash
# Claude Team HTTP Server Setup
# Run this to configure launchd auto-start

set -e

# Detect paths
UVX_PATH=$(which uvx 2>/dev/null || echo "/opt/homebrew/bin/uvx")
HOME_DIR="$HOME"

# Check prerequisites
if ! command -v uvx &> /dev/null; then
    echo "Error: uvx not found. Install uv with: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

# Create log directory
mkdir -p "$HOME/.claude-team/logs"

# Get script directory (where this setup.sh lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/com.claude-team.plist.template"

if [ ! -f "$TEMPLATE" ]; then
    echo "Error: plist template not found at $TEMPLATE"
    exit 1
fi

# Generate plist from template
PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-team.plist"
sed -e "s|{{UVX_PATH}}|$UVX_PATH|g" \
    -e "s|{{HOME}}|$HOME_DIR|g" \
    "$TEMPLATE" > "$PLIST_DEST"

echo "Created: $PLIST_DEST"

# Unload if already loaded
launchctl unload "$PLIST_DEST" 2>/dev/null || true

# Load the service
launchctl load "$PLIST_DEST"
echo "Loaded launchd service"

# Verify
sleep 2
if launchctl list | grep -q com.claude-team; then
    echo "✅ claude-team HTTP server is running"
    echo "   Logs: ~/.claude-team/logs/"
    echo "   Port: 8766"
else
    echo "⚠️  Service loaded but may not be running. Check logs."
fi

# mcporter config hint
echo ""
echo "Add to ~/.mcporter/mcporter.json:"
echo '{'
echo '  "mcpServers": {'
echo '    "claude-team-http": {'
echo '      "transport": "streamable-http",'
echo '      "url": "http://127.0.0.1:8766/mcp",'
echo '      "lifecycle": "keep-alive"'
echo '    }'
echo '  }'
echo '}'
