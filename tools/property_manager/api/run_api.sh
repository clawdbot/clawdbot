#!/usr/bin/env bash
# Run PropertyManager API.
# DB: TCP when PROPERTYMANAGER_DB_PASSWORD / OPENCLAW_DB_PASSWORD / ~/.config/openclaw/db.env
# is set; otherwise docker exec postgres (IntelMini default).
set -euo pipefail
ROOT="${OPENCLAW_BASE:-/home/gravesab/ai/projects/openclaw}"
cd "$ROOT/tools/property_manager/api"

ENV_FILE="${PROPERTYMANAGER_DB_ENV_FILE:-$HOME/.config/openclaw/db.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export PROPERTYMANAGER_DB_HOST="${PROPERTYMANAGER_DB_HOST:-127.0.0.1}"
export PROPERTYMANAGER_DB_PORT="${PROPERTYMANAGER_DB_PORT:-5432}"
export PROPERTYMANAGER_DB_NAME="${PROPERTYMANAGER_DB_NAME:-openclaw}"
export PROPERTYMANAGER_DB_USER="${PROPERTYMANAGER_DB_USER:-openclaw}"
export PROPERTYMANAGER_API_PORT="${PROPERTYMANAGER_API_PORT:-5062}"
export PROPERTYMANAGER_ATTACHMENTS_ROOT="${PROPERTYMANAGER_ATTACHMENTS_ROOT:-/mnt/ai-storage/openclaw-documents/Property/attachments}"
export PROPERTYMANAGER_DB_VIA_DOCKER="${PROPERTYMANAGER_DB_VIA_DOCKER:-1}"
# Dev VM: disable API auth for local integration tests; set PROPERTYMANAGER_API_KEY in prod.
export PROPERTYMANAGER_AUTH_DISABLED="${PROPERTYMANAGER_AUTH_DISABLED:-1}"
export PROPERTYMANAGER_OPERATOR_PIN="${PROPERTYMANAGER_OPERATOR_PIN:-dev-pin}"
mkdir -p "$PROPERTYMANAGER_ATTACHMENTS_ROOT"
exec "$ROOT/tools/property_manager/api/.venv/bin/python" \
  "$ROOT/tools/property_manager/api/propertymanager_api.py"
