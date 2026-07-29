#!/usr/bin/env bash
# Run PropertyManager API via Gunicorn (Flask app framework, WSGI process).
# DB: TCP when PROPERTYMANAGER_DB_PASSWORD / OPENCLAW_DB_PASSWORD / ~/.config/openclaw/db.env
# is set; otherwise docker exec postgres (IntelMini / dev default).
#
# Gunicorn target: wsgi:application  (WorkingDirectory = this directory)
# Config: gunicorn.conf.py
set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$API_DIR/../../.." && pwd)"
cd "$API_DIR"

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
# Production default: auth enabled. Dev/tests must set PROPERTYMANAGER_AUTH_DISABLED=1 explicitly.
# Secrets: PROPERTYMANAGER_API_KEY + PROPERTYMANAGER_OPERATOR_PIN via db.env (never commit).
export PROPERTYMANAGER_AUTH_DISABLED="${PROPERTYMANAGER_AUTH_DISABLED:-0}"
export PROPERTYMANAGER_OPERATOR_PIN="${PROPERTYMANAGER_OPERATOR_PIN:-}"
export PROPERTYMANAGER_PID_DIR="${PROPERTYMANAGER_PID_DIR:-/tmp/pm-dev}"
export OPENCLAW_BASE="${OPENCLAW_BASE:-$ROOT}"

mkdir -p "$PROPERTYMANAGER_ATTACHMENTS_ROOT"
mkdir -p "$PROPERTYMANAGER_PID_DIR"

GUNICORN_BIN="$API_DIR/.venv/bin/gunicorn"
if [[ ! -x "$GUNICORN_BIN" ]]; then
  echo "Missing $GUNICORN_BIN" >&2
  echo "Create venv: python3 -m venv $API_DIR/.venv && $API_DIR/.venv/bin/pip install -r $API_DIR/requirements.txt" >&2
  exit 1
fi

exec "$GUNICORN_BIN" \
  --config "$API_DIR/gunicorn.conf.py" \
  wsgi:application
