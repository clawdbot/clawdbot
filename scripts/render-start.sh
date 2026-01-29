#!/bin/sh
# Render startup script - creates config and starts gateway
# Don't use set -e initially - we'll enable it after setup

echo "=== Render startup script ==="
echo "HOME=${HOME:-not set}"
echo "CLAWDBOT_STATE_DIR=${CLAWDBOT_STATE_DIR:-not set}"
echo "User: $(whoami 2>/dev/null || echo unknown)"
echo "UID: $(id -u 2>/dev/null || echo unknown)"
echo "PWD: $(pwd)"

# Set HOME if not set (node user's home is /home/node)
if [ -z "${HOME}" ]; then
  if [ -d "/home/node" ]; then
    export HOME="/home/node"
  else
    export HOME="/tmp"
  fi
  echo "Set HOME to: ${HOME}"
fi

# Use CLAWDBOT_STATE_DIR if set and writable, otherwise use HOME/.clawdbot
CONFIG_DIR="${HOME}/.clawdbot"
if [ -n "${CLAWDBOT_STATE_DIR}" ]; then
  # Test if we can write to it (disable exit on error for this test)
  set +e
  mkdir -p "${CLAWDBOT_STATE_DIR}" 2>/dev/null
  touch "${CLAWDBOT_STATE_DIR}/.test" 2>/dev/null
  if [ $? -eq 0 ]; then
    rm -f "${CLAWDBOT_STATE_DIR}/.test" 2>/dev/null
    CONFIG_DIR="${CLAWDBOT_STATE_DIR}"
    echo "Using CLAWDBOT_STATE_DIR: ${CONFIG_DIR}"
  else
    echo "Warning: ${CLAWDBOT_STATE_DIR} not writable, using ${CONFIG_DIR}"
  fi
  set -e
fi

CONFIG_FILE="${CONFIG_DIR}/clawdbot.json"

echo "Config dir: ${CONFIG_DIR}"
echo "Config file: ${CONFIG_FILE}"

# Create config directory (this should always work for HOME/.clawdbot)
if ! mkdir -p "${CONFIG_DIR}" 2>/dev/null; then
  echo "ERROR: Failed to create config directory: ${CONFIG_DIR}"
  exit 1
fi

# Write config file
if ! cat > "${CONFIG_FILE}" << 'EOF'
{
  "gateway": {
    "mode": "local",
    "trustedProxies": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "controlUi": {
      "allowInsecureAuth": true
    }
  }
}
EOF
then
  echo "ERROR: Failed to write config file: ${CONFIG_FILE}"
  exit 1
fi

echo "=== Config written to ${CONFIG_FILE} ==="
cat "${CONFIG_FILE}" || echo "Warning: Could not read config file"

# Verify config file exists and is readable
if [ ! -f "${CONFIG_FILE}" ]; then
  echo "ERROR: Config file does not exist: ${CONFIG_FILE}"
  exit 1
fi

# Set environment variables for gateway
export CLAWDBOT_STATE_DIR="${CONFIG_DIR}"
export CLAWDBOT_CONFIG_PATH="${CONFIG_FILE}"
export CLAWDBOT_CONFIG_CACHE_MS=0

echo "=== Starting gateway ==="
echo "CLAWDBOT_STATE_DIR=${CLAWDBOT_STATE_DIR}"
echo "CLAWDBOT_CONFIG_PATH=${CLAWDBOT_CONFIG_PATH}"

# Verify node is available
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node command not found"
  echo "PATH: ${PATH}"
  exit 1
fi

echo "Node version: $(node --version)"

# Verify dist/index.js exists
if [ ! -f "dist/index.js" ]; then
  echo "ERROR: dist/index.js not found"
  echo "Contents of /app:"
  ls -la /app 2>/dev/null || echo "Cannot list /app"
  echo "Contents of current directory:"
  ls -la . 2>/dev/null || echo "Cannot list current directory"
  exit 1
fi

echo "Found dist/index.js"

# Check if token is set
if [ -z "${CLAWDBOT_GATEWAY_TOKEN}" ]; then
  echo "ERROR: CLAWDBOT_GATEWAY_TOKEN is not set"
  exit 1
fi

echo "Token is set (length: ${#CLAWDBOT_GATEWAY_TOKEN})"

# Enable strict error handling for the final exec
set -e

# Start gateway
echo "Executing: node dist/index.js gateway --port 8080 --bind lan --auth token --allow-unconfigured"
exec node dist/index.js gateway \
  --port 8080 \
  --bind lan \
  --auth token \
  --token "${CLAWDBOT_GATEWAY_TOKEN}" \
  --allow-unconfigured
