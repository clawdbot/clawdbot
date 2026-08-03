#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-app-store-connect-keychain-setup.sh --key-path /path/to/AuthKey_XXXXXX.p8 --issuer-id <issuer-uuid> [options]

Required:
  --key-path <path>      Path to App Store Connect API key (.p8)
  --issuer-id <uuid>     App Store Connect issuer ID

Optional:
  --key-id <id>          API key ID (auto-detected from AuthKey_<id>.p8 if omitted)
  --service <name>       Keychain service name (default: openclaw-app-store-connect-key)
  --account <name>       Keychain account name (default: $USER or $LOGNAME)
  --write-env            Upsert non-secret env vars into apps/ios/fastlane/.env
  --env-file <path>      Override env file path used with --write-env
  -h, --help             Show this help

Example:
  scripts/ios-app-store-connect-keychain-setup.sh \
    --key-path "$HOME/keys/AuthKey_ABC1234567.p8" \
    --issuer-id "00000000-1111-2222-3333-444444444444" \
    --write-env
EOF
}

upsert_env_line() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"

  if [[ -f "$file" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { updated = 0 }
      $0 ~ ("^" key "=") { print key "=" value; updated = 1; next }
      { print }
      END { if (!updated) print key "=" value }
    ' "$file" >"$tmp"
  else
    printf "%s=%s\n" "$key" "$value" >"$tmp"
  fi

  mv "$tmp" "$file"
}

delete_env_line() {
  local file="$1"
  local key="$2"
  local tmp
  tmp="$(mktemp)"

  if [[ ! -f "$file" ]]; then
    rm -f "$tmp"
    return
  fi

  awk -v key="$key" '
    $0 ~ ("^" key "=") { next }
    { print }
  ' "$file" >"$tmp"

  mv "$tmp" "$file"
}

KEY_PATH=""
KEY_ID=""
ISSUER_ID=""
SERVICE="openclaw-app-store-connect-key"
ACCOUNT="${USER:-${LOGNAME:-}}"
WRITE_ENV=0
ENV_FILE=""

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_ENV_FILE="$REPO_ROOT/apps/ios/fastlane/.env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key-path)
      KEY_PATH="${2:-}"
      shift 2
      ;;
    --key-id)
      KEY_ID="${2:-}"
      shift 2
      ;;
    --issuer-id)
      ISSUER_ID="${2:-}"
      shift 2
      ;;
    --service)
      SERVICE="${2:-}"
      shift 2
      ;;
    --account)
      ACCOUNT="${2:-}"
      shift 2
      ;;
    --write-env)
      WRITE_ENV=1
      shift
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$KEY_PATH" || -z "$ISSUER_ID" ]]; then
  echo "Missing required arguments." >&2
  usage
  exit 1
fi

if [[ ! -f "$KEY_PATH" ]]; then
  echo "Key file not found: $KEY_PATH" >&2
  exit 1
fi

if [[ -z "$KEY_ID" ]]; then
  key_filename="$(basename "$KEY_PATH")"
  if [[ "$key_filename" =~ ^AuthKey_([A-Za-z0-9]+)\.p8$ ]]; then
    KEY_ID="${BASH_REMATCH[1]}"
  else
    echo "Could not infer --key-id from filename '$key_filename'. Pass --key-id explicitly." >&2
    exit 1
  fi
fi

if [[ -z "$ACCOUNT" ]]; then
  echo "Could not determine Keychain account. Pass --account explicitly." >&2
  exit 1
fi

KEY_CONTENT="$(cat "$KEY_PATH")"
if [[ -z "$KEY_CONTENT" ]]; then
  echo "Key file is empty: $KEY_PATH" >&2
  exit 1
fi

security add-generic-password \
  -a "$ACCOUNT" \
  -s "$SERVICE" \
  -w "$KEY_CONTENT" \
  -U >/dev/null

echo "Stored App Store Connect API private key in macOS Keychain (service='$SERVICE', account='$ACCOUNT')."
echo
echo "Export these vars for Fastlane:"
echo "APP_STORE_CONNECT_KEY_ID=$KEY_ID"
echo "APP_STORE_CONNECT_ISSUER_ID=$ISSUER_ID"
echo "APP_STORE_CONNECT_KEYCHAIN_SERVICE=$SERVICE"
echo "APP_STORE_CONNECT_KEYCHAIN_ACCOUNT=$ACCOUNT"

if [[ "$WRITE_ENV" -eq 1 ]]; then
  if [[ -z "$ENV_FILE" ]]; then
    ENV_FILE="$DEFAULT_ENV_FILE"
  fi

  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"

  upsert_env_line "$ENV_FILE" "APP_STORE_CONNECT_KEY_ID" "$KEY_ID"
  upsert_env_line "$ENV_FILE" "APP_STORE_CONNECT_ISSUER_ID" "$ISSUER_ID"
  upsert_env_line "$ENV_FILE" "APP_STORE_CONNECT_KEYCHAIN_SERVICE" "$SERVICE"
  upsert_env_line "$ENV_FILE" "APP_STORE_CONNECT_KEYCHAIN_ACCOUNT" "$ACCOUNT"
  # Remove file/path based keys so Keychain is used by default.
  delete_env_line "$ENV_FILE" "APP_STORE_CONNECT_KEY_PATH"
  delete_env_line "$ENV_FILE" "APP_STORE_CONNECT_KEY_CONTENT"
  delete_env_line "$ENV_FILE" "APP_STORE_CONNECT_API_KEY_PATH"

  echo
  echo "Updated env file: $ENV_FILE"
fi
