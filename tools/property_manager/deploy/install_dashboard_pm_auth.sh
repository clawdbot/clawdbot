#!/usr/bin/env bash
# Wire OpenClaw dashboard to PropertyManager production auth env (Intel Mini).
# Requires sudo. Does not print or commit secrets.
set -euo pipefail

ENV_FILE="${PROPERTYMANAGER_DB_ENV_FILE:-$HOME/.config/openclaw/db.env}"
DROPIN_DIR="/etc/systemd/system/openclaw-dashboard.service.d"
DROPIN="$DROPIN_DIR/propertymanager-auth.conf"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Create it with PROPERTYMANAGER_API_KEY, PROPERTYMANAGER_OPERATOR_PIN, PROPERTYMANAGER_AUTH_DISABLED=0" >&2
  exit 1
fi

if ! grep -q '^PROPERTYMANAGER_API_KEY=' "$ENV_FILE"; then
  echo "PROPERTYMANAGER_API_KEY missing from $ENV_FILE" >&2
  exit 1
fi
if ! grep -q '^PROPERTYMANAGER_OPERATOR_PIN=' "$ENV_FILE"; then
  echo "PROPERTYMANAGER_OPERATOR_PIN missing from $ENV_FILE" >&2
  exit 1
fi

sudo mkdir -p "$DROPIN_DIR"
sudo tee "$DROPIN" >/dev/null <<EOF
[Service]
EnvironmentFile=-${ENV_FILE}
EOF
sudo systemctl daemon-reload
sudo systemctl restart openclaw-dashboard.service
systemctl is-active openclaw-dashboard.service
echo "Dashboard restarted with PropertyManager auth EnvironmentFile (values not shown)."
