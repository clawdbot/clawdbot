#!/bin/bash
# Workspace cloud sync using rclone bisync
# Docs: https://docs.molt.bot/gateway/workspace-sync

set -e

# Configuration (override via environment)
RCLONE_CONFIG="${RCLONE_CONFIG:-$HOME/.config/rclone/rclone.conf}"
RCLONE_REMOTE="${RCLONE_REMOTE:-cloud}"
REMOTE_PATH="${REMOTE_PATH:-moltbot-share}"
LOCAL_PATH="${LOCAL_PATH:-${MOLTBOT_STATE_DIR:-${CLAWDBOT_STATE_DIR:-$HOME/.clawdbot}}/workspace/shared}"

# Flags
RESYNC="${RESYNC:-false}"
VERBOSE="${VERBOSE:-false}"
DRY_RUN="${DRY_RUN:-false}"

usage() {
    cat << 'EOF'
Usage: workspace-sync.sh [OPTIONS]

Bidirectional sync between cloud storage and workspace.

Options:
  --resync      Force resync (required on first run)
  --dry-run     Show what would be synced without doing it
  --verbose     Show detailed output
  --help        Show this help

Environment:
  RCLONE_CONFIG   Path to rclone.conf (default: ~/.config/rclone/rclone.conf)
  RCLONE_REMOTE   rclone remote name (default: cloud)
  REMOTE_PATH     Folder in cloud storage (default: moltbot-share)
  LOCAL_PATH      Local folder to sync (default: <state-dir>/workspace/shared)

Examples:
  # First sync (establishes baseline)
  ./scripts/workspace-sync.sh --resync

  # Regular sync
  ./scripts/workspace-sync.sh

  # Preview changes
  ./scripts/workspace-sync.sh --dry-run --verbose

Setup: https://docs.molt.bot/gateway/workspace-sync
EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --resync)
            RESYNC=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

# Check rclone is installed
if ! command -v rclone &> /dev/null; then
    echo "Error: rclone not installed"
    echo "Install: curl -s https://rclone.org/install.sh | bash"
    exit 1
fi

# Check config exists
if [[ ! -f "$RCLONE_CONFIG" ]]; then
    echo "Error: rclone config not found at $RCLONE_CONFIG"
    echo "Setup: https://docs.molt.bot/gateway/workspace-sync"
    exit 1
fi

# Ensure local directory exists
mkdir -p "$LOCAL_PATH"

# Build rclone command
RCLONE_ARGS=(
    bisync
    "${RCLONE_REMOTE}:${REMOTE_PATH}"
    "$LOCAL_PATH"
    --config "$RCLONE_CONFIG"
    --conflict-resolve newer
    --conflict-suffix .conflict
    --exclude ".git/**"
    --exclude "node_modules/**"
    --exclude "*.log"
    --exclude ".DS_Store"
)

if [[ "$RESYNC" == "true" ]]; then
    RCLONE_ARGS+=(--resync)
fi

if [[ "$DRY_RUN" == "true" ]]; then
    RCLONE_ARGS+=(--dry-run)
fi

if [[ "$VERBOSE" == "true" ]]; then
    RCLONE_ARGS+=(--verbose)
fi

# Run sync
echo "Syncing: ${RCLONE_REMOTE}:${REMOTE_PATH} <-> $LOCAL_PATH"
rclone "${RCLONE_ARGS[@]}"

echo "Sync complete: $(date)"
