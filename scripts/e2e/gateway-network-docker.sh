#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-gateway-network-e2e" OPENCLAW_GATEWAY_NETWORK_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_GATEWAY_NETWORK_E2E_SKIP_BUILD:-0}"

PORT="18789"
TOKEN="e2e-$(date +%s)-$$"
NET_NAME="openclaw-net-e2e-$$"
GW_NAME="openclaw-gateway-e2e-$$"

cleanup() {
  docker rm -f "$GW_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" gateway-network "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"

echo "Creating Docker network..."
docker network create "$NET_NAME" >/dev/null

echo "Starting gateway container..."
docker run -d \
  --name "$GW_NAME" \
  --network "$NET_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail; entry=dist/index.mjs; [ -f \"\$entry\" ] || entry=dist/index.js; node \"\$entry\" config set gateway.controlUi.enabled false >/dev/null; node \"\$entry\" gateway --port $PORT --bind lan --allow-unconfigured > /tmp/gateway-net-e2e.log 2>&1" >/dev/null

echo "Waiting for gateway to come up..."
ready=0
for _ in $(seq 1 40); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$GW_NAME" 2>/dev/null || echo false)" != "true" ]; then
    break
  fi
  if docker exec "$GW_NAME" bash -lc "node --input-type=module -e '
    import net from \"node:net\";
    const socket = net.createConnection({ host: \"127.0.0.1\", port: $PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      process.exit(1);
    }, 400);
    socket.on(\"connect\", () => {
      clearTimeout(timeout);
      socket.end();
      process.exit(0);
    });
    socket.on(\"error\", () => {
      clearTimeout(timeout);
      process.exit(1);
    });
  ' >/dev/null 2>&1"; then
    ready=1
    break
  fi
  if docker exec "$GW_NAME" bash -lc "grep -q \"listening on ws://\" /tmp/gateway-net-e2e.log 2>/dev/null"; then
    ready=1
    break
  fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "Gateway failed to start"
  if [ "$(docker inspect -f '{{.State.Running}}' "$GW_NAME" 2>/dev/null || echo false)" = "true" ]; then
    docker exec "$GW_NAME" bash -lc "tail -n 80 /tmp/gateway-net-e2e.log" || true
  else
    docker logs "$GW_NAME" 2>&1 | tail -n 120 || true
  fi
  exit 1
fi

echo "Running client container (connect + health)..."
run_logged gateway-network-client docker run --rm \
  --network "$NET_NAME" \
  -e "GW_URL=ws://$GW_NAME:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  "$IMAGE_NAME" \
  bash -lc "node --input-type=module - <<'NODE'
import { WebSocket } from \"ws\";

const PROTOCOL_VERSION = 3;

const url = process.env.GW_URL;
const token = process.env.GW_TOKEN;
if (!url || !token) throw new Error(\"missing GW_URL/GW_TOKEN\");

const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(\"ws open timeout\")), 5000);
  ws.once(\"open\", () => {
    clearTimeout(t);
    resolve();
  });
});

function onceFrame(filter, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(\"timeout\")), timeoutMs);
    const handler = (data) => {
      const obj = JSON.parse(String(data));
      if (!filter(obj)) return;
      clearTimeout(t);
      ws.off(\"message\", handler);
      resolve(obj);
    };
    ws.on(\"message\", handler);
  });
}

ws.send(
  JSON.stringify({
    type: \"req\",
    id: \"c1\",
    method: \"connect\",
    params: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: \"test\",
        displayName: \"docker-net-e2e\",
        version: \"dev\",
        platform: process.platform,
        mode: \"test\",
	      },
	      caps: [],
	      auth: { token },
	    },
	  }),
			);
		const connectRes = await onceFrame((o) => o?.type === \"res\" && o?.id === \"c1\");
		if (!connectRes.ok) throw new Error(\"connect failed: \" + (connectRes.error?.message ?? \"unknown\"));

		ws.close();
		console.log(\"ok\");
NODE"

echo "OK"
