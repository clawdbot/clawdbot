#!/usr/bin/env bash
set -Eeuo pipefail

export DBUS_SESSION_BUS_ADDRESS=/dev/null

export DISPLAY=:1
export HOME=/tmp/openclaw-home
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

CDP_PORT="${OPENCLAW_BROWSER_CDP_PORT:-9222}"
CDP_SOURCE_RANGE="${OPENCLAW_BROWSER_CDP_SOURCE_RANGE:-}"
CDP_AUTH_TOKEN="${OPENCLAW_BROWSER_CDP_AUTH_TOKEN:-}"
VNC_PORT="${OPENCLAW_BROWSER_VNC_PORT:-5900}"
NOVNC_PORT="${OPENCLAW_BROWSER_NOVNC_PORT:-6080}"
ENABLE_NOVNC="${OPENCLAW_BROWSER_ENABLE_NOVNC:-1}"
HEADLESS="${OPENCLAW_BROWSER_HEADLESS:-0}"
ALLOW_NO_SANDBOX="${OPENCLAW_BROWSER_NO_SANDBOX:-0}"
NOVNC_PASSWORD="${OPENCLAW_BROWSER_NOVNC_PASSWORD:-}"

DISABLE_GRAPHICS_FLAGS="${OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS:-1}"
DISABLE_EXTENSIONS="${OPENCLAW_BROWSER_DISABLE_EXTENSIONS:-1}"
RENDERER_PROCESS_LIMIT="${OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT:-2}"
AUTO_START_TIMEOUT_MS="${OPENCLAW_BROWSER_AUTO_START_TIMEOUT_MS:-12000}"

validate_uint() {
  local name="$1"
  local value="$2"
  local min="${3:-0}"
  local max="${4:-4294967295}"

  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "[sandbox] ERROR: $name must be an integer, got: ${value}" >&2
    exit 1
  fi
  if (( value < min || value > max )); then
    echo "[sandbox] ERROR: $name out of range (${min}..${max}), got: ${value}" >&2
    exit 1
  fi
}

validate_uint "CDP_PORT" "$CDP_PORT" 1 65535
validate_uint "VNC_PORT" "$VNC_PORT" 1 65535
validate_uint "NOVNC_PORT" "$NOVNC_PORT" 1 65535
validate_uint "AUTO_START_TIMEOUT_MS" "$AUTO_START_TIMEOUT_MS" 1 2147483647
if [[ -n "$RENDERER_PROCESS_LIMIT" ]]; then
  validate_uint "RENDERER_PROCESS_LIMIT" "$RENDERER_PROCESS_LIMIT" 0 2147483647
fi

cleanup() {
  local code="${1:-1}"
  trap - EXIT INT TERM

  local pids=()
  local pid

  for pid in "${WEBSOCKIFY_PID:-}" "${X11VNC_PID:-}" "${CDP_RELAY_PID:-}" "${CHROME_PID:-}" "${XVFB_PID:-}"; do
    if [[ -n "${pid:-}" ]]; then
      pids+=("$pid")
    fi
  done

  if ((${#pids[@]} > 0)); then
    kill -TERM "${pids[@]}" 2>/dev/null || true

    for _ in {1..10}; do
      local alive=0
      for pid in "${pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
          alive=1
          break
        fi
      done
      if [[ "$alive" == "0" ]]; then
        break
      fi
      sleep 0.2
    done

    kill -KILL "${pids[@]}" 2>/dev/null || true
    wait 2>/dev/null || true
  fi

  exit "$code"
}

trap 'cleanup "$?"' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

mkdir -p "${HOME}" "${HOME}/.chrome" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"

Xvfb :1 -screen 0 1280x800x24 -ac -nolisten tcp &
XVFB_PID=$!
echo "[sandbox] Xvfb started (PID: ${XVFB_PID})"

if [[ "${CDP_PORT}" -ge 65535 ]]; then
  CHROME_CDP_PORT="$((CDP_PORT - 1))"
else
  CHROME_CDP_PORT="$((CDP_PORT + 1))"
fi

CHROME_ARGS=(
  "--remote-debugging-address=127.0.0.1"
  "--remote-debugging-port=${CHROME_CDP_PORT}"
  "--user-data-dir=${HOME}/.chrome"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-dev-shm-usage"
  "--disable-background-networking"
  "--disable-breakpad"
  "--disable-crash-reporter"
  "--no-zygote"
  "--metrics-recording-only"
  "--password-store=basic"
  "--use-mock-keychain"
)

if [[ "${HEADLESS}" == "1" ]]; then
  CHROME_ARGS+=("--headless=new")
fi

if [[ "${ALLOW_NO_SANDBOX}" == "1" ]]; then
  CHROME_ARGS+=("--no-sandbox" "--disable-setuid-sandbox")
fi

DISABLE_GRAPHICS_FLAGS_LOWER="${DISABLE_GRAPHICS_FLAGS,,}"
if [[ "${DISABLE_GRAPHICS_FLAGS_LOWER}" =~ ^(1|true|yes|on)$ ]]; then
  CHROME_ARGS+=(
    "--disable-3d-apis"
    "--disable-gpu"
    "--disable-software-rasterizer"
  )
fi

DISABLE_EXTENSIONS_LOWER="${DISABLE_EXTENSIONS,,}"
if [[ "${DISABLE_EXTENSIONS_LOWER}" =~ ^(1|true|yes|on)$ ]]; then
  CHROME_ARGS+=("--disable-extensions")
fi

if [[ "${RENDERER_PROCESS_LIMIT}" =~ ^[0-9]+$ && "${RENDERER_PROCESS_LIMIT}" -gt 0 ]]; then
  CHROME_ARGS+=("--renderer-process-limit=${RENDERER_PROCESS_LIMIT}")
fi

echo "[sandbox] Starting Chromium..."
chromium "${CHROME_ARGS[@]}" about:blank &
CHROME_PID=$!
echo "[sandbox] Chromium started (PID: ${CHROME_PID})"

start_ms=$(date +%s%3N)
deadline_ms=$(( start_ms + AUTO_START_TIMEOUT_MS ))
CDP_READY=0
probe_url="http://127.0.0.1:${CHROME_CDP_PORT}/json/version"

echo "[sandbox] Waiting up to ${AUTO_START_TIMEOUT_MS}ms for CDP on port ${CHROME_CDP_PORT}..."

while (( $(date +%s%3N) < deadline_ms )); do
  if ! kill -0 "${CHROME_PID}" 2>/dev/null; then
    echo "[sandbox] ERROR: Chromium exited before CDP became ready."
    exit 1
  fi

  if curl -fsS --max-time 0.5 "${probe_url}" >/dev/null; then
    CDP_READY=1
    break
  fi

  sleep 0.2
done

if [[ "${CDP_READY}" == "0" ]]; then
  echo "[sandbox] ERROR: CDP failed to start within ${AUTO_START_TIMEOUT_MS}ms."
  exit 1
fi

echo "[sandbox] CDP ready. Starting relay..."

if [[ -z "${CDP_AUTH_TOKEN}" ]]; then
  echo "[sandbox-browser] WARNING: CDP auth token unset; CDP relay will not start." >&2
else
  OPENCLAW_BROWSER_CHROME_CDP_PORT="${CHROME_CDP_PORT}" python3 - <<'PY' &
import base64
import hmac
import ipaddress
import os
import select
import socket
import socketserver
import sys
import time

LISTEN_PORT = int(os.environ["OPENCLAW_BROWSER_CDP_PORT"])
UPSTREAM_PORT = int(os.environ["OPENCLAW_BROWSER_CHROME_CDP_PORT"])
AUTH_TOKEN = os.environ["OPENCLAW_BROWSER_CDP_AUTH_TOKEN"]
SOURCE_RANGE = os.environ.get("OPENCLAW_BROWSER_CDP_SOURCE_RANGE", "").strip()
MAX_HEADER_BYTES = 65536
HEADER_READ_TIMEOUT_SECONDS = 5.0

try:
    SOURCE_NETWORK = ipaddress.ip_network(SOURCE_RANGE, strict=False) if SOURCE_RANGE else None
except ValueError:
    print(f"[sandbox-browser] ERROR: invalid CDP source range: {SOURCE_RANGE}", file=sys.stderr)
    raise SystemExit(1)

EXPECTED_BASIC = "Basic " + base64.b64encode(f"openclaw:{AUTH_TOKEN}".encode()).decode()
EXPECTED_BEARER = "Bearer " + AUTH_TOKEN


def source_allowed(host):
    if SOURCE_NETWORK is None:
        return True
    try:
        return ipaddress.ip_address(host) in SOURCE_NETWORK
    except ValueError:
        return False


def has_auth(header_bytes):
    try:
        text = header_bytes.decode("iso-8859-1")
    except UnicodeDecodeError:
        return False
    for line in text.split("\r\n")[1:]:
        name, sep, value = line.partition(":")
        if sep and name.strip().lower() == "authorization":
            auth = value.strip()
            basic_ok = hmac.compare_digest(auth, EXPECTED_BASIC)
            bearer_ok = hmac.compare_digest(auth, EXPECTED_BEARER)
            return basic_ok or bearer_ok
    return False


def read_headers(conn, deadline):
    data = b""
    while b"\r\n\r\n" not in data:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return b""
        conn.settimeout(remaining)
        try:
            chunk = conn.recv(4096)
        except socket.timeout:
            return b""
        if not chunk:
            return b""
        data += chunk
        if len(data) > MAX_HEADER_BYTES:
            return b""
    return data


def relay(left, right):
    sockets = [left, right]
    try:
        while sockets:
            readable, _, _ = select.select(sockets, [], [])
            for src in readable:
                dst = right if src is left else left
                data = src.recv(65536)
                if not data:
                    return
                dst.sendall(data)
    finally:
        for sock in (left, right):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        client_host = self.client_address[0]
        if not source_allowed(client_host):
            return
        header_deadline = time.monotonic() + HEADER_READ_TIMEOUT_SECONDS
        header_bytes = read_headers(self.request, header_deadline)
        if not header_bytes:
            return
        if not has_auth(header_bytes):
            self.request.sendall(
                b"HTTP/1.1 401 Unauthorized\r\n"
                b'WWW-Authenticate: Basic realm="OpenClaw CDP"\r\n'
                b"Connection: close\r\n"
                b"Content-Length: 0\r\n\r\n"
            )
            return
        upstream = socket.create_connection(("127.0.0.1", UPSTREAM_PORT), timeout=5)
        upstream.settimeout(None)
        self.request.settimeout(None)
        upstream.sendall(header_bytes)
        relay(self.request, upstream)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(("0.0.0.0", LISTEN_PORT), Handler) as server:
    print("[sandbox] CDP relay started", flush=True)
    server.serve_forever()
PY
  CDP_RELAY_PID=$!
  echo "[sandbox] CDP relay started (PID: ${CDP_RELAY_PID})"
fi

if [[ "${ENABLE_NOVNC}" == "1" && "${HEADLESS}" != "1" ]]; then
  if [[ -z "${NOVNC_PASSWORD}" ]]; then
    NOVNC_PASSWORD="$(< /proc/sys/kernel/random/uuid)"
    NOVNC_PASSWORD="${NOVNC_PASSWORD//-/}"
    NOVNC_PASSWORD="${NOVNC_PASSWORD:0:8}"
  fi

  mkdir -p "${HOME}/.vnc"
  x11vnc -storepasswd "${NOVNC_PASSWORD}" "${HOME}/.vnc/passwd" >/dev/null
  chmod 600 "${HOME}/.vnc/passwd"

  x11vnc -display :1 -rfbport "${VNC_PORT}" -shared -forever -rfbauth "${HOME}/.vnc/passwd" -localhost &
  X11VNC_PID=$!
  echo "[sandbox] x11vnc started (PID: ${X11VNC_PID})"

  websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
  WEBSOCKIFY_PID=$!
  echo "[sandbox] websockify started (PID: ${WEBSOCKIFY_PID})"
fi

echo "[sandbox] Container running. Monitoring all sub-processes..."
wait -n
