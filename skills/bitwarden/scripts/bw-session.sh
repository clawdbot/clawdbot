#!/bin/bash
# Unlock Bitwarden vault and export session key
# Usage: source bw-session.sh <master_password>
# Or:    source bw-session.sh (prompts for password)

set -e

if [ -n "$1" ]; then
    MASTER_PW="$1"
else
    read -sp "Bitwarden master password: " MASTER_PW
    echo
fi

# Check if already logged in
if ! bw login --check &>/dev/null; then
    echo "Not logged in. Run: bw login <email>"
    return 1
fi

# Unlock and get session
export BW_SESSION=$(echo "$MASTER_PW" | bw unlock --raw 2>/dev/null)

if [ -z "$BW_SESSION" ]; then
    echo "Failed to unlock vault"
    return 1
fi

# Sync to get latest
bw sync &>/dev/null

echo "✓ Vault unlocked and synced"
echo "Session valid for this shell"
