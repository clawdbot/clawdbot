#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

BASE_IMAGE="$(docker_e2e_resolve_image "openclaw-browser-cdp-base-e2e" OPENCLAW_BROWSER_CDP_BASE_E2E_IMAGE)"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-browser-cdp-snapshot-e2e" OPENCLAW_BROWSER_CDP_SNAPSHOT_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_BROWSER_CDP_SNAPSHOT_E2E_SKIP_BUILD:-0}"
PORT="18789"
CDP_PORT="19222"
FIXTURE_PORT="18080"
TOKEN="browser-cdp-e2e-token"
CONTAINER_NAME="openclaw-browser-cdp-e2e-$$"
DOCKER_COMMAND_TIMEOUT="${OPENCLAW_BROWSER_CDP_SNAPSHOT_DOCKER_COMMAND_TIMEOUT:-900s}"

docker_cmd() {
  timeout "$DOCKER_COMMAND_TIMEOUT" "$@"
}

cleanup() {
  docker_cmd docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "${OPENCLAW_SKIP_DOCKER_BUILD:-0}" = "1" ] || [ "$SKIP_BUILD" = "1" ]; then
  echo "Reusing Docker image: $IMAGE_NAME"
  docker_cmd docker image inspect "$IMAGE_NAME" >/dev/null
else
  docker_e2e_build_or_reuse "$BASE_IMAGE" browser-cdp-base "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "0"
  build_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-browser-cdp-build.XXXXXX")"
  trap 'cleanup; rm -rf "$build_dir"' EXIT
  cat >"$build_dir/Dockerfile" <<EOF
FROM $BASE_IMAGE
USER root
RUN apt-get update \\
 && apt-get install -y --no-install-recommends chromium fonts-liberation procps \\
 && rm -rf /var/lib/apt/lists/*
USER appuser
EOF
  echo "Building Docker image: $IMAGE_NAME"
  run_logged browser-cdp-snapshot-build docker build -t "$IMAGE_NAME" -f "$build_dir/Dockerfile" "$build_dir"
fi

echo "Starting browser CDP snapshot container..."
docker_cmd docker run -d \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  -e OPENCLAW_DISABLE_BONJOUR=1 \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  -e OPENCLAW_SKIP_GMAIL_WATCHER=1 \
  -e OPENCLAW_SKIP_CRON=1 \
  -e OPENCLAW_SKIP_CANVAS_HOST=1 \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
entry=dist/index.mjs
[ -f \"\$entry\" ] || entry=dist/index.js
mkdir -p \"\$HOME/.openclaw\" /tmp/openclaw-browser-cdp/chrome
find dist -maxdepth 1 -type f -name 'pw-ai-*.js' ! -name 'pw-ai-state-*' -exec mv {} /tmp/openclaw-browser-cdp/ \;
cat > \"\$HOME/.openclaw/openclaw.json\" <<'JSON'
{
  \"gateway\": {
    \"port\": $PORT,
    \"auth\": {
      \"mode\": \"token\",
      \"token\": \"$TOKEN\"
    },
    \"controlUi\": { \"enabled\": false }
  },
  \"browser\": {
    \"enabled\": true,
    \"defaultProfile\": \"docker-cdp\",
    \"ssrfPolicy\": {
      \"allowedHostnames\": [\"127.0.0.1\"]
    },
    \"profiles\": {
      \"docker-cdp\": {
        \"cdpUrl\": \"http://127.0.0.1:$CDP_PORT\",
        \"color\": \"#FF4500\"
      }
    }
  }
}
JSON
chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \\
  --remote-debugging-address=127.0.0.1 \\
  --remote-debugging-port=$CDP_PORT \\
  --user-data-dir=/tmp/openclaw-browser-cdp/chrome \\
  about:blank >/tmp/browser-cdp-chromium.log 2>&1 &
node --input-type=module - <<'NODE' >/tmp/browser-cdp-fixture.log 2>&1 &
import http from 'node:http';
const html = \`<!doctype html>
<html>
  <body>
    <main>
      <button>Save</button>
      <a href=\"https://docs.openclaw.ai/browser-cdp-live\">Docs</a>
      <div id=\"card\" onclick=\"window.__clicked = true\" style=\"cursor: pointer\">Clickable Card</div>
      <iframe title=\"Child\" srcdoc='<button>Inside</button>'></iframe>
    </main>
  </body>
</html>\`;
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  })
  .listen($FIXTURE_PORT, '127.0.0.1');
NODE
node \"\$entry\" gateway --port $PORT --bind loopback --allow-unconfigured >/tmp/browser-cdp-gateway.log 2>&1" >/dev/null

echo "Waiting for Chromium and Gateway..."
ready=0
for _ in $(seq 1 180); do
  if [ "$(docker_cmd docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" != "true" ]; then
    break
  fi
  if docker_cmd docker exec "$CONTAINER_NAME" bash -lc "
    node --input-type=module -e 'const res = await fetch(\"http://127.0.0.1:$CDP_PORT/json/version\"); if (!res.ok) process.exit(1);' >/dev/null &&
    node --input-type=module -e '
      import net from \"node:net\";
      const socket = net.createConnection({ host: \"127.0.0.1\", port: $PORT });
      const timeout = setTimeout(() => { socket.destroy(); process.exit(1); }, 400);
      socket.on(\"connect\", () => { clearTimeout(timeout); socket.end(); process.exit(0); });
      socket.on(\"error\", () => { clearTimeout(timeout); process.exit(1); });
    ' >/dev/null
  " >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "Browser CDP snapshot container failed to become ready"
  docker_cmd docker logs "$CONTAINER_NAME" 2>&1 | tail -n 120 || true
  docker_cmd docker exec "$CONTAINER_NAME" bash -lc "tail -n 120 /tmp/browser-cdp-chromium.log /tmp/browser-cdp-gateway.log /tmp/browser-cdp-fixture.log" || true
  exit 1
fi

echo "Running browser CDP snapshot smoke..."
docker_cmd docker exec "$CONTAINER_NAME" bash -lc "
set -euo pipefail
entry=dist/index.mjs
[ -f \"\$entry\" ] || entry=dist/index.js
base_args=(--url ws://127.0.0.1:$PORT --token '$TOKEN')
node \"\$entry\" browser \"\${base_args[@]}\" --browser-profile docker-cdp doctor --deep >/tmp/browser-cdp-doctor.txt
grep -q 'OK live-snapshot' /tmp/browser-cdp-doctor.txt
node \"\$entry\" browser \"\${base_args[@]}\" --browser-profile docker-cdp open http://127.0.0.1:$FIXTURE_PORT/ >/tmp/browser-cdp-open.txt
node \"\$entry\" browser \"\${base_args[@]}\" --browser-profile docker-cdp snapshot --interactive --urls --out /tmp/browser-cdp-snapshot.txt >/tmp/browser-cdp-snapshot.out
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const snapshot = fs.readFileSync('/tmp/browser-cdp-snapshot.txt', 'utf8');
for (const needle of [
  'button \"Save\"',
  'link \"Docs\"',
  'https://docs.openclaw.ai/browser-cdp-live',
  'generic \"Clickable Card\"',
  'cursor:pointer',
  'Iframe \"Child\"',
  'button \"Inside\"',
]) {
  if (!snapshot.includes(needle)) {
    console.error(snapshot);
    throw new Error('missing snapshot needle: ' + needle);
  }
}
console.log('ok');
NODE
"

echo "Browser CDP snapshot Docker E2E passed."
