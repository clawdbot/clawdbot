#!/bin/bash
set -e

# Clear stale session locks on startup (handles both root and node ownership)
rm -f /data/agents/main/sessions/*.lock 2>/dev/null || true

# Start SSH daemon if installed and running as root
if [ "$(id -u)" = "0" ] && [ -f /usr/sbin/sshd ]; then
    echo "Starting SSH daemon..."
    /usr/sbin/sshd
fi

# If running as root and gosu is available, drop to node user for main process
if [ "$(id -u)" = "0" ] && command -v gosu > /dev/null 2>&1; then
    # Ensure node user owns the data directory
    if [ -d /data ]; then
        chown -R node:node /data 2>/dev/null || true
    fi
    exec gosu node "$@"
fi

# Otherwise run as current user
exec "$@"
