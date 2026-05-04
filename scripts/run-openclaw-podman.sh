#!/usr/bin/env bash
# Rootless OpenClaw in Podman: run after one-time setup.
#
# One-time setup (from repo root): ./scripts/podman/setup.sh
# Then:
#   ./scripts/run-openclaw-podman.sh launch        # Start gateway
#   ./scripts/run-openclaw-podman.sh launch setup  # Onboarding wizard
#
# Manage the running container from the host CLI:
#   openclaw --container openclaw dashboard --no-open
#   openclaw --container openclaw channels login
#
# Legacy: "setup-host" delegates to the Podman setup script

set -euo pipefail

PLATFORM_NAME="$(uname -s 2>/dev/null || echo unknown)"

resolve_user_home() {
  local user="$1"
  local home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [[ -z "$home" && -f /etc/passwd ]]; then
    home="$(awk -F: -v u="$user" '$1==u {print $6}' /etc/passwd 2>/dev/null || true)"
  fi
  if [[ -z "$home" ]]; then
    home="/home/$user"
  fi
  printf '%s' "$home"
}

fail() {
  echo "$*" >&2
  exit 1
}

validate_single_line_value() {
  local label="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    fail "Invalid $label: control characters are not allowed."
  fi
}

validate_absolute_path() {
  local label="$1"
  local value="$2"
  validate_single_line_value "$label" "$value"
  [[ "$value" == /* ]] || fail "Invalid $label: expected an absolute path."
  [[ "$value" != *"//"* ]] || fail "Invalid $label: repeated slashes are not allowed."
  [[ "$value" != *"/./"* && "$value" != */. && "$value" != *"/../"* && "$value" != */.. ]] ||
    fail "Invalid $label: dot path segments are not allowed."
}

validate_mount_source_path() {
  local label="$1"
  local value="$2"
  validate_absolute_path "$label" "$value"
  [[ "$value" != *:* ]] || fail "Invalid $label: ':' is not allowed in Podman bind-mount source paths."
}

ensure_safe_existing_regular_file() {
  local label="$1"
  local file="$2"
  validate_absolute_path "$label" "$file"
  [[ -e "$file" ]] || fail "Missing $label: $file"
  [[ ! -L "$file" ]] || fail "Unsafe $label: symlinks are not allowed ($file)"
  [[ -f "$file" ]] || fail "Unsafe $label: expected a regular file ($file)"
}

ensure_safe_existing_dir() {
  local label="$1"
  local dir="$2"
  validate_absolute_path "$label" "$dir"
  [[ -d "$dir" ]] || fail "Missing $label: $dir"
  [[ ! -L "$dir" ]] || fail "Unsafe $label: symlinks are not allowed ($dir)"
}

stat_uid() {
  local path="$1"
  if stat -f '%u' "$path" >/dev/null 2>&1; then
    stat -f '%u' "$path"
  else
    stat -Lc '%u' "$path"
  fi
}

stat_mode() {
  local path="$1"
  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
  else
    stat -Lc '%a' "$path"
  fi
}

ensure_private_existing_dir_owned_by_user() {
  local label="$1"
  local dir="$2"
  local uid=""
  local mode=""
  ensure_safe_existing_dir "$label" "$dir"
  uid="$(stat_uid "$dir")"
  [[ "$uid" == "$(id -u)" ]] || fail "Unsafe $label: not owned by current user ($dir)"
  mode="$(stat_mode "$dir")"
  (( (8#$mode & 0022) == 0 )) || fail "Unsafe $label: group/other writable ($dir)"
}

ensure_private_existing_regular_file_owned_by_user() {
  local label="$1"
  local file="$2"
  local uid=""
  local mode=""
  ensure_safe_existing_regular_file "$label" "$file"
  uid="$(stat_uid "$file")"
  [[ "$uid" == "$(id -u)" ]] || fail "Unsafe $label: not owned by current user ($file)"
  mode="$(stat_mode "$file")"
  (( (8#$mode & 0077) == 0 )) || fail "Unsafe $label: expected owner-only permissions ($file)"
}

ensure_safe_write_file_path() {
  local label="$1"
  local file="$2"
  local dir
  validate_absolute_path "$label" "$file"
  if [[ -e "$file" ]]; then
    [[ ! -L "$file" ]] || fail "Unsafe $label: symlinks are not allowed ($file)"
    [[ -f "$file" ]] || fail "Unsafe $label: expected a regular file ($file)"
  fi
  dir="$(dirname "$file")"
  ensure_safe_existing_dir "${label} parent directory" "$dir"
}

write_file_atomically() {
  local file="$1"
  local mode="$2"
  local dir=""
  local tmp=""
  ensure_safe_write_file_path "output file" "$file"
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.tmp.XXXXXX")"
  cat >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$file"
}

load_podman_env_file() {
  local file="$1"
  local line=""
  local key=""
  local value=""
  local trimmed=""
  local dir=""
  ensure_private_existing_regular_file_owned_by_user "Podman env file" "$file"
  dir="$(dirname "$file")"
  ensure_private_existing_dir_owned_by_user "Podman env directory" "$dir"
  exec 9<"$file" || fail "Unable to open Podman env file: $file"
  while IFS= read -r line <&9 || [[ -n "$line" ]]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    case "$key" in
      OPENCLAW_GATEWAY_TOKEN|OPENCLAW_PODMAN_CONTAINER|OPENCLAW_PODMAN_IMAGE|OPENCLAW_IMAGE|OPENCLAW_PODMAN_PULL|OPENCLAW_PODMAN_GATEWAY_HOST_PORT|OPENCLAW_GATEWAY_PORT|OPENCLAW_PODMAN_BRIDGE_HOST_PORT|OPENCLAW_BRIDGE_PORT|OPENCLAW_GATEWAY_BIND|OPENCLAW_PODMAN_USERNS|OPENCLAW_BIND_MOUNT_OPTIONS|OPENCLAW_PODMAN_PUBLISH_HOST)
        ;;
      *)
        continue
        ;;
    esac
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf -v "$key" '%s' "$value"
    export "$key"
  done
  exec 9<&-
}

validate_port() {
  local label="$1"
  local value="$2"
  local numeric=""
  [[ "$value" =~ ^[0-9]{1,5}$ ]] || fail "Invalid $label: must be numeric."
  numeric=$((10#$value))
  (( numeric >= 1 && numeric <= 65535 )) || fail "Invalid $label: out of range."
}

EFFECTIVE_USER="$(id -un)"
EFFECTIVE_HOME="${HOME:-}"
if [[ -z "$EFFECTIVE_HOME" ]]; then
  EFFECTIVE_HOME="$(resolve_user_home "$EFFECTIVE_USER")"
fi
if [[ "$(id -u)" -eq 0 ]]; then
  fail "Run run-openclaw-podman.sh as your normal user so Podman stays rootless."
fi

# Legacy: setup-host -> run the Podman setup script
if [[ "${1:-}" == "setup-host" ]]; then
  shift
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  SETUP_PODMAN="$REPO_ROOT/scripts/podman/setup.sh"
  if [[ -f "$SETUP_PODMAN" ]]; then
    exec "$SETUP_PODMAN" "$@"
  fi
  echo "Podman setup script not found. Run from repo root: ./scripts/podman/setup.sh" >&2
  exit 1
fi

if [[ "${1:-}" == "launch" ]]; then
  shift
fi

if [[ -z "${EFFECTIVE_HOME:-}" ]]; then
  EFFECTIVE_HOME="/tmp"
fi
validate_absolute_path "effective home" "$EFFECTIVE_HOME"

CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$EFFECTIVE_HOME/.openclaw}"
ENV_FILE="${OPENCLAW_PODMAN_ENV:-$CONFIG_DIR/.env}"
# Bootstrap `.env` may set runtime/container options, but it must not
# relocate the config/workspace/env paths mid-run. Those path overrides are
# only honored from the parent process environment before bootstrap.
if [[ -f "$ENV_FILE" ]]; then
  load_podman_env_file "$ENV_FILE"
fi

CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$EFFECTIVE_HOME/.openclaw}"
ENV_FILE="${OPENCLAW_PODMAN_ENV:-$CONFIG_DIR/.env}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$CONFIG_DIR/workspace}"
CONTAINER_NAME="${OPENCLAW_PODMAN_CONTAINER:-openclaw}"
OPENCLAW_IMAGE="${OPENCLAW_PODMAN_IMAGE:-${OPENCLAW_IMAGE:-openclaw:local}}"
PODMAN_PULL="${OPENCLAW_PODMAN_PULL:-never}"
HOST_GATEWAY_PORT="${OPENCLAW_PODMAN_GATEWAY_HOST_PORT:-${OPENCLAW_GATEWAY_PORT:-18789}}"
HOST_BRIDGE_PORT="${OPENCLAW_PODMAN_BRIDGE_HOST_PORT:-${OPENCLAW_BRIDGE_PORT:-18790}}"
PUBLISH_HOST="${OPENCLAW_PODMAN_PUBLISH_HOST:-127.0.0.1}"
validate_mount_source_path "config directory" "$CONFIG_DIR"
validate_mount_source_path "workspace directory" "$WORKSPACE_DIR"
validate_absolute_path "env file path" "$ENV_FILE"
validate_single_line_value "container name" "$CONTAINER_NAME"
validate_single_line_value "image name" "$OPENCLAW_IMAGE"
validate_single_line_value "publish host" "$PUBLISH_HOST"
validate_port "gateway host port" "$HOST_GATEWAY_PORT"
validate_port "bridge host port" "$HOST_BRIDGE_PORT"

cd "$EFFECTIVE_HOME" 2>/dev/null || cd /tmp 2>/dev/null || true

RUN_SETUP=false
if [[ "${1:-}" == "setup" || "${1:-}" == "onboard" ]]; then
  RUN_SETUP=true
  shift
fi

mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR"
mkdir -p "$CONFIG_DIR/canvas" "$CONFIG_DIR/cron"
chmod 700 "$CONFIG_DIR" "$WORKSPACE_DIR"
ensure_private_existing_dir_owned_by_user "config directory" "$CONFIG_DIR"
ensure_private_existing_dir_owned_by_user "workspace directory" "$WORKSPACE_DIR"

resolve_config_gateway_bind() {
  local config_dir="$1"
  if ! command -v openclaw >/dev/null 2>&1; then
    return 0
  fi
  OPENCLAW_CONTAINER="" OPENCLAW_CONFIG_DIR="$config_dir" \
    openclaw config get gateway.bind 2>/dev/null || true
}

# For published container ports, the gateway must listen on the container
# interface, so the Podman launcher defaults to lan. Respect an explicit
# OPENCLAW_GATEWAY_BIND first, then gateway.bind in local config.
CONFIG_GATEWAY_BIND="$(resolve_config_gateway_bind "$CONFIG_DIR")"
GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-${CONFIG_GATEWAY_BIND:-lan}}"

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  local dir
  ensure_safe_write_file_path "env file" "$file"
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.env.tmp.XXXXXX")"
  if [[ -f "$file" ]]; then
    awk -v k="$key" -v v="$value" '
      BEGIN { found = 0 }
      $0 ~ ("^" k "=") { print k "=" v; found = 1; next }
      { print }
      END { if (!found) print k "=" v }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

generate_token_hex_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return 0
  fi
  if command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d " \n"
    return 0
  fi
  echo "Missing dependency: need openssl or python3 (or od) to generate OPENCLAW_GATEWAY_TOKEN." >&2
  exit 1
}

create_token_env_file() {
  local file="$1"
  local token="$2"
  local dir=""
  local tmp=""
  dir="$(dirname "$file")"
  ensure_private_existing_dir_owned_by_user "token env directory" "$dir"
  tmp="$(mktemp "$dir/.token.env.XXXXXX")"
  chmod 600 "$tmp"
  printf 'OPENCLAW_GATEWAY_TOKEN=%s\n' "$token" >"$tmp"
  printf '%s' "$tmp"
}

sync_local_control_ui_origins_via_cli() {
  local file="$1"
  local port="$2"
  local config_dir=""
  local allowed_json=""
  local merged_json=""
  config_dir="$(dirname "$file")"
  if ! command -v openclaw >/dev/null 2>&1; then
    echo "Warning: openclaw not found; unable to sync gateway.controlUi.allowedOrigins in $file." >&2
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    OPENCLAW_CONTAINER="" OPENCLAW_CONFIG_DIR="$config_dir" \
      openclaw config set gateway.controlUi.allowedOrigins \
      "[\"http://127.0.0.1:${port}\",\"http://localhost:${port}\"]" \
      --strict-json >/dev/null
    return 0
  fi
  allowed_json="$(
    OPENCLAW_CONTAINER="" OPENCLAW_CONFIG_DIR="$config_dir" \
      openclaw config get gateway.controlUi.allowedOrigins --json 2>/dev/null || true
  )"
  merged_json="$(python3 - "$port" "$allowed_json" <<'PY'
import json
import sys

port = sys.argv[1]
raw = sys.argv[2] if len(sys.argv) > 2 else ""
desired = [
    f"http://127.0.0.1:{port}",
    f"http://localhost:{port}",
]
allowed = []
if raw:
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            allowed = parsed
    except json.JSONDecodeError:
        allowed = []
cleaned = []
seen = set()
for origin in allowed + desired:
    if not isinstance(origin, str):
        continue
    normalized = origin.strip()
    if not normalized or normalized in seen:
        continue
    cleaned.append(normalized)
    seen.add(normalized)
print(json.dumps(cleaned))
PY
  )"
  OPENCLAW_CONTAINER="" OPENCLAW_CONFIG_DIR="$config_dir" \
    openclaw config set gateway.controlUi.allowedOrigins "$merged_json" --strict-json >/dev/null
}

sync_local_control_ui_origins() {
  local file="$1"
  local port="$2"
  local dir=""
  local tmp=""
  ensure_safe_write_file_path "config file" "$file"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Warning: python3 not found; unable to sync gateway.controlUi.allowedOrigins in $file." >&2
    return 0
  fi
  dir="$(dirname "$file")"
  ensure_private_existing_dir_owned_by_user "config file directory" "$dir"
  tmp="$(mktemp "$dir/.config.tmp.XXXXXX")"
  if ! python3 - "$file" "$port" "$tmp" <<'PY'
import json
import sys

path = sys.argv[1]
port = sys.argv[2]
tmp = sys.argv[3]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except json.JSONDecodeError as exc:
    print(
        f"Warning: unable to sync gateway.controlUi.allowedOrigins in {path}: existing config is not strict JSON ({exc}). Leaving file unchanged.",
        file=sys.stderr,
    )
    raise SystemExit(1)
if not isinstance(data, dict):
    raise SystemExit(f"{path}: expected top-level object")
gateway = data.setdefault("gateway", {})
if not isinstance(gateway, dict):
    raise SystemExit(f"{path}: expected gateway object")
gateway.setdefault("mode", "local")
control_ui = gateway.setdefault("controlUi", {})
if not isinstance(control_ui, dict):
    raise SystemExit(f"{path}: expected gateway.controlUi object")
allowed = control_ui.get("allowedOrigins")
desired = [
    f"http://127.0.0.1:{port}",
    f"http://localhost:{port}",
]
if not isinstance(allowed, list):
    allowed = []
cleaned = []
seen = set()
for origin in allowed:
    if not isinstance(origin, str):
        continue
    normalized = origin.strip()
    if not normalized or normalized in seen:
        continue
    cleaned.append(normalized)
    seen.add(normalized)
for origin in desired:
    if origin not in seen:
        cleaned.append(origin)
        seen.add(origin)
control_ui["allowedOrigins"] = cleaned
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
PY
  then
    rm -f "$tmp"
    sync_local_control_ui_origins_via_cli "$file" "$port"
    return 0
  fi
  [[ -s "$tmp" ]] || {
    rm -f "$tmp"
    return 0
  }
  chmod 600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
}

TOKEN_ENV_FILE=""
cleanup_token_env_file() {
  if [[ -n "$TOKEN_ENV_FILE" && -f "$TOKEN_ENV_FILE" ]]; then
    rm -f "$TOKEN_ENV_FILE"
  fi
}
trap cleanup_token_env_file EXIT

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  export OPENCLAW_GATEWAY_TOKEN="$(generate_token_hex_32)"
  mkdir -p "$(dirname "$ENV_FILE")"
  ensure_safe_existing_dir "env file directory" "$(dirname "$ENV_FILE")"
  upsert_env_var "$ENV_FILE" "OPENCLAW_GATEWAY_TOKEN" "$OPENCLAW_GATEWAY_TOKEN"
  echo "Generated OPENCLAW_GATEWAY_TOKEN and wrote it to $ENV_FILE." >&2
fi

CONFIG_JSON="$CONFIG_DIR/openclaw.json"
if [[ ! -f "$CONFIG_JSON" ]]; then
  (
    umask 077
    write_file_atomically "$CONFIG_JSON" 600 <<'JSON'
{ "gateway": { "mode": "local" } }
JSON
  )
  echo "Created $CONFIG_JSON (minimal gateway.mode=local)." >&2
fi
sync_local_control_ui_origins "$CONFIG_JSON" "$HOST_GATEWAY_PORT"

PODMAN_USERNS="${OPENCLAW_PODMAN_USERNS:-keep-id}"
USERNS_ARGS=()
RUN_USER_ARGS=()
case "$PODMAN_USERNS" in
  ""|auto) ;;
  keep-id) USERNS_ARGS=(--userns=keep-id) ;;
  host) USERNS_ARGS=(--userns=host) ;;
  *)
    echo "Unsupported OPENCLAW_PODMAN_USERNS=$PODMAN_USERNS (expected: keep-id, auto, host)." >&2
    exit 2
    ;;
esac

RUN_UID="$(id -u)"
RUN_GID="$(id -g)"
if [[ "$PODMAN_USERNS" == "keep-id" ]]; then
  RUN_USER_ARGS=(--user "${RUN_UID}:${RUN_GID}")
else
  echo "Starting container without --user (OPENCLAW_PODMAN_USERNS=$PODMAN_USERNS), mounts may require ownership fixes." >&2
fi

SELINUX_MOUNT_OPTS=""
if [[ -z "${OPENCLAW_BIND_MOUNT_OPTIONS:-}" ]]; then
  if [[ "$(uname -s 2>/dev/null)" == "Linux" ]] && command -v getenforce >/dev/null 2>&1; then
    _selinux_mode="$(getenforce 2>/dev/null || true)"
    if [[ "$_selinux_mode" == "Enforcing" || "$_selinux_mode" == "Permissive" ]]; then
      SELINUX_MOUNT_OPTS=",Z"
    fi
  fi
else
  SELINUX_MOUNT_OPTS="${OPENCLAW_BIND_MOUNT_OPTIONS#:}"
  [[ -n "$SELINUX_MOUNT_OPTS" ]] && SELINUX_MOUNT_OPTS=",$SELINUX_MOUNT_OPTS"
fi

if [[ "$RUN_SETUP" == true ]]; then
  TOKEN_ENV_FILE="$(create_token_env_file "$ENV_FILE" "$OPENCLAW_GATEWAY_TOKEN")"
  podman run --pull="$PODMAN_PULL" --rm -it \
    --init \
    "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
    -e HOME=/home/node -e TERM=xterm-256color -e BROWSER=echo \
    -e NPM_CONFIG_CACHE=/home/node/.openclaw/.npm \
    -e OPENCLAW_NO_RESPAWN=1 \
    --env-file "$TOKEN_ENV_FILE" \
    -v "$CONFIG_DIR:/home/node/.openclaw:rw${SELINUX_MOUNT_OPTS}" \
    -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw${SELINUX_MOUNT_OPTS}" \
    "$OPENCLAW_IMAGE" \
    node dist/index.js onboard "$@"
  exit 0
fi

TOKEN_ENV_FILE="$(create_token_env_file "$ENV_FILE" "$OPENCLAW_GATEWAY_TOKEN")"
podman run --pull="$PODMAN_PULL" -d --replace \
  --name "$CONTAINER_NAME" \
  --init \
  "${USERNS_ARGS[@]}" "${RUN_USER_ARGS[@]}" \
  -e HOME=/home/node -e TERM=xterm-256color \
  -e NPM_CONFIG_CACHE=/home/node/.openclaw/.npm \
  -e OPENCLAW_NO_RESPAWN=1 \
  --env-file "$TOKEN_ENV_FILE" \
  -v "$CONFIG_DIR:/home/node/.openclaw:rw${SELINUX_MOUNT_OPTS}" \
  -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw${SELINUX_MOUNT_OPTS}" \
  -p "${PUBLISH_HOST}:${HOST_GATEWAY_PORT}:18789" \
  -p "${PUBLISH_HOST}:${HOST_BRIDGE_PORT}:18790" \
  "$OPENCLAW_IMAGE" \
  node dist/index.js gateway --bind "$GATEWAY_BIND" --port 18789 >/dev/null

echo "Container $CONTAINER_NAME started: http://127.0.0.1:${HOST_GATEWAY_PORT}/"
echo "podman exec -it $CONTAINER_NAME openclaw dashboard --no-open"
echo "podman exec -it $CONTAINER_NAME openclaw devices approve --latest  # if pairing required"
echo "podman logs -f $CONTAINER_NAME"
if [[ "$PLATFORM_NAME" == "Linux" ]]; then
  echo "For auto-start/restarts, use: ./scripts/podman/setup.sh --quadlet (Quadlet + systemd user service)."
fi
