#!/bin/sh
# Render startup script - creates config and starts gateway
set -e

echo "=== Render startup script ==="

# Ensure HOME is set (node user's home is /home/node in node:22-bookworm)
if [ -z "${HOME}" ]; then
  export HOME="/home/node"
  if [ ! -d "${HOME}" ]; then
    export HOME="/tmp"
  fi
fi

echo "HOME=${HOME}"
echo "CLAWDBOT_STATE_DIR=${CLAWDBOT_STATE_DIR}"
echo "User: $(whoami)"
echo "UID: $(id -u)"

# Determine config directory
# Use CLAWDBOT_STATE_DIR if set and writable, otherwise try /data/.clawdbot, fallback to HOME
CONFIG_DIR="${HOME}/.clawdbot"

# Try preferred locations (disable set -e temporarily for testing)
set +e
if [ -n "${CLAWDBOT_STATE_DIR}" ]; then
  mkdir -p "${CLAWDBOT_STATE_DIR}" 2>/dev/null && touch "${CLAWDBOT_STATE_DIR}/.test" 2>/dev/null && rm -f "${CLAWDBOT_STATE_DIR}/.test" 2>/dev/null
  if [ $? -eq 0 ]; then
    CONFIG_DIR="${CLAWDBOT_STATE_DIR}"
  fi
fi

if [ "${CONFIG_DIR}" = "${HOME}/.clawdbot" ]; then
  mkdir -p "/data/.clawdbot" 2>/dev/null && touch "/data/.clawdbot/.test" 2>/dev/null && rm -f "/data/.clawdbot/.test" 2>/dev/null
  if [ $? -eq 0 ]; then
    CONFIG_DIR="/data/.clawdbot"
  fi
fi
set -e

CONFIG_FILE="${CONFIG_DIR}/clawdbot.json"

echo "Config dir: ${CONFIG_DIR}"
echo "Config file: ${CONFIG_FILE}"

# Create config directory (should always succeed now)
mkdir -p "${CONFIG_DIR}"

# Write config file
cat > "${CONFIG_FILE}" << 'EOF'
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

echo "=== Config written ==="
echo "=== ${CONFIG_FILE}: ==="
cat "${CONFIG_FILE}"
echo "=== End config ==="

# Verify file exists
echo "=== Verifying config file ==="
if [ -f "${CONFIG_FILE}" ]; then
  echo "Config file exists: ${CONFIG_FILE}"
  ls -la "${CONFIG_FILE}" || true
else
  echo "ERROR: Config file not found: ${CONFIG_FILE}"
  exit 1
fi

# Start the gateway with token from env var
# Explicitly set CLAWDBOT_CONFIG_PATH to ensure config is loaded from the file we wrote
# Also update CLAWDBOT_STATE_DIR to match the directory we're actually using
# Disable config cache to ensure fresh reads
echo "=== Starting gateway ==="
echo "=== Using config dir: ${CONFIG_DIR} ==="
echo "=== Setting CLAWDBOT_STATE_DIR=${CONFIG_DIR} ==="
echo "=== Setting CLAWDBOT_CONFIG_PATH=${CONFIG_FILE} ==="
echo "=== Disabling config cache ==="
export CLAWDBOT_STATE_DIR="${CONFIG_DIR}"
export CLAWDBOT_CONFIG_PATH="${CONFIG_FILE}"
export CLAWDBOT_CONFIG_CACHE_MS=0

# Verify config can be read
echo "=== Verifying config can be read ==="
node -e "
const fs = require('fs');
const path = '${CONFIG_FILE}';
if (fs.existsSync(path)) {
  const content = fs.readFileSync(path, 'utf-8');
  const parsed = JSON.parse(content);
  console.log('Config loaded successfully:');
  console.log('trustedProxies:', JSON.stringify(parsed.gateway?.trustedProxies));
} else {
  console.error('Config file not found:', path);
  process.exit(1);
}
"

exec node dist/index.js gateway \
  --port 8080 \
  --bind lan \
  --auth token \
  --token "$CLAWDBOT_GATEWAY_TOKEN" \
  --allow-unconfigured
