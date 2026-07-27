#!/usr/bin/env bash
# Run the PropertyManager API under the approved WSGI server.
set -euo pipefail

ROOT="${OPENCLAW_BASE:-/home/gravesab/ai/projects/openclaw}"
API_DIR="$ROOT/tools/property_manager/api"
ENV_FILE="${PROPERTYMANAGER_DB_ENV_FILE:-$HOME/.config/openclaw/db.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export PROPERTYMANAGER_DB_HOST="${PROPERTYMANAGER_DB_HOST:-127.0.0.1}"
export PROPERTYMANAGER_DB_PORT="${PROPERTYMANAGER_DB_PORT:-5432}"
export PROPERTYMANAGER_DB_NAME="${PROPERTYMANAGER_DB_NAME:-openclaw_dev}"
export PROPERTYMANAGER_DB_USER="${PROPERTYMANAGER_DB_USER:-openclaw}"
export PROPERTYMANAGER_API_PORT="${PROPERTYMANAGER_API_PORT:-5062}"
export PROPERTYMANAGER_ATTACHMENTS_ROOT="${PROPERTYMANAGER_ATTACHMENTS_ROOT:-$HOME/.local/share/openclaw-dev/propertymanager/attachments}"
export PROPERTYMANAGER_DB_VIA_DOCKER="${PROPERTYMANAGER_DB_VIA_DOCKER:-}"

if [[ "${OPENCLAW_ENVIRONMENT:-development}" == "development" ]] &&
  [[ "$PROPERTYMANAGER_DB_NAME" != *_dev ]]; then
  echo "Refusing to start development PropertyManager against non-development database: $PROPERTYMANAGER_DB_NAME" >&2
  exit 78
fi

mkdir -p "$PROPERTYMANAGER_ATTACHMENTS_ROOT"
cd "$API_DIR"
exec "$API_DIR/.venv/bin/gunicorn" \
  --config "$API_DIR/gunicorn.conf.py" \
  wsgi:application
