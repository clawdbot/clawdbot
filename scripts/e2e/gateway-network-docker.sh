#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="moltbot-gateway-network-e2e"

PORT="18789"
TOKEN="e2e-$(date +%s)-$$"
NET_NAME="moltbot-net-e2e-$$"
GW_NAME="moltbot-gateway-e2e-$$"

cleanup() {
  docker rm -f "$GW_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

echo "Creating Docker network..."
docker network create "$NET_NAME" >/dev/null

echo "Starting gateway container..."
	docker run --rm -d \
	  --name "$GW_NAME" \
	  --network "$NET_NAME" \
	  -e "CLAWDBOT_GATEWAY_TOKEN=$TOKEN" \
	  -e "CLAWDBOT_SKIP_CHANNELS=1" \
	  -e "CLAWDBOT_SKIP_GMAIL_WATCHER=1" \
	  -e "CLAWDBOT_SKIP_CRON=1" \
	  -e "CLAWDBOT_SKIP_CANVAS_HOST=1" \
	  "$IMAGE_NAME" \
  bash -lc "node dist/index.js gateway --port $PORT --bind lan --allow-unconfigured > /tmp/gateway-net-e2e.log 2>&1"

echo "Waiting for gateway to come up..."
for _ in $(seq 1 20); do
  if docker exec "$GW_NAME" bash -lc "grep -q \"listening on ws://\" /tmp/gateway-net-e2e.log"; then
    break
  fi
  sleep 0.5
done

docker exec "$GW_NAME" bash -lc "tail -n 50 /tmp/gateway-net-e2e.log"

echo "Running client container (connect + health)..."
docker run --rm \
  --network "$NET_NAME" \
  -e "GW_URL=ws://$GW_NAME:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  "$IMAGE_NAME" \
  bash -lc "node - <<'NODE'
import { WebSocket } from \"ws\";
import { PROTOCOL_VERSION } from \"./dist/gateway/protocol/index.js\";

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

	ws.send(JSON.stringify({ type: \"req\", id: \"h1\", method: \"health\" }));
	const healthRes = await onceFrame((o) => o?.type === \"res\" && o?.id === \"h1\", 10000);
	if (!healthRes.ok) throw new Error(\"health failed: \" + (healthRes.error?.message ?? \"unknown\"));
	if (healthRes.payload?.ok !== true) throw new Error(\"unexpected health payload\");

	ws.close();
	console.log(\"ok\");
NODE"

echo "OK"
