#!/usr/bin/env bash
# Runs Open WebUI against a Dockerized OpenClaw Gateway and verifies the proxied
# chat path with a real OpenAI-compatible request.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-openwebui-e2e" OPENCLAW_OPENWEBUI_E2E_IMAGE)"
OPENWEBUI_IMAGE="${OPENWEBUI_IMAGE:-ghcr.io/open-webui/open-webui:v0.8.10}"
# Keep the default on a broadly available non-reasoning OpenAI model for
# Open WebUI compatibility smoke. Callers can still override this explicitly.
MODEL="${OPENCLAW_OPENWEBUI_MODEL:-openai/gpt-4.1-mini}"
PROMPT_NONCE="OPENWEBUI_DOCKER_E2E_$(date +%s)_$$"
PROMPT="${OPENCLAW_OPENWEBUI_PROMPT:-Reply with exactly this token and nothing else: ${PROMPT_NONCE}}"
PORT="${OPENCLAW_OPENWEBUI_GATEWAY_PORT:-18789}"
WEBUI_PORT="${OPENCLAW_OPENWEBUI_PORT:-8080}"
TOKEN="openwebui-e2e-$(date +%s)-$$"
ADMIN_EMAIL="${OPENCLAW_OPENWEBUI_ADMIN_EMAIL:-openwebui-e2e@example.com}"
ADMIN_PASSWORD="${OPENCLAW_OPENWEBUI_ADMIN_PASSWORD:-OpenWebUI-E2E-Password-$(date +%s)-$$}"
NET_NAME="openclaw-openwebui-e2e-$$"
GW_NAME="openclaw-openwebui-gateway-$$"
OW_NAME="openclaw-openwebui-$$"
DOCKER_COMMAND_TIMEOUT="${OPENCLAW_OPENWEBUI_DOCKER_COMMAND_TIMEOUT:-600s}"
DOCKER_PULL_TIMEOUT="${OPENCLAW_OPENWEBUI_DOCKER_PULL_TIMEOUT:-600s}"

docker_cmd() {
  timeout "$DOCKER_COMMAND_TIMEOUT" "$@"
}

OPENAI_API_KEY_VALUE="${OPENAI_API_KEY:-}"
if [[ "$OPENAI_API_KEY_VALUE" == "undefined" || "$OPENAI_API_KEY_VALUE" == "null" ]]; then
  OPENAI_API_KEY_VALUE=""
fi
OPENAI_BASE_URL_VALUE="${OPENAI_BASE_URL:-}"
if [[ "$OPENAI_BASE_URL_VALUE" == "undefined" || "$OPENAI_BASE_URL_VALUE" == "null" ]]; then
  OPENAI_BASE_URL_VALUE=""
fi
if [[ -z "$OPENAI_API_KEY_VALUE" ]]; then
  echo "OPENAI_API_KEY is required for the Open WebUI Docker smoke." >&2
  exit 2
fi

cleanup() {
  docker_cmd docker rm -f "$OW_NAME" >/dev/null 2>&1 || true
  docker_cmd docker rm -f "$GW_NAME" >/dev/null 2>&1 || true
  docker_cmd docker network rm "$NET_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" openwebui
docker_e2e_harness_mount_args

echo "Pulling Open WebUI image: $OPENWEBUI_IMAGE"
timeout "$DOCKER_PULL_TIMEOUT" docker pull "$OPENWEBUI_IMAGE" >/dev/null

echo "Creating Docker network..."
docker_cmd docker network create "$NET_NAME" >/dev/null

echo "Starting gateway container..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
docker_cmd docker run -d \
  --name "$GW_NAME" \
  --network "$NET_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_OPENWEBUI_MODEL=$MODEL" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  -e OPENAI_API_KEY \
  ${OPENAI_BASE_URL_VALUE:+-e OPENAI_BASE_URL} \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    entry=dist/index.mjs
    [ -f "$entry" ] || entry=dist/index.js

    openai_api_key="${OPENAI_API_KEY:?OPENAI_API_KEY required}"
    batch_file="$(mktemp /tmp/openclaw-openwebui-config.XXXXXX.json)"
    OPENCLAW_CONFIG_BATCH_PATH="$batch_file" node - <<'"'"'NODE'"'"' "$openai_api_key"
const fs = require("node:fs");

const openaiApiKey = process.argv[2];
const batchPath = process.env.OPENCLAW_CONFIG_BATCH_PATH;
const entries = [
  { path: "models.providers.openai.apiKey", value: openaiApiKey },
  {
    path: "models.providers.openai.baseUrl",
    value: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
  },
  { path: "models.providers.openai.models", value: [] },
  { path: "gateway.controlUi.enabled", value: false },
  { path: "gateway.mode", value: "local" },
  { path: "gateway.bind", value: "lan" },
  { path: "gateway.auth.mode", value: "token" },
  { path: "gateway.auth.token", value: process.env.OPENCLAW_GATEWAY_TOKEN },
  { path: "gateway.http.endpoints.chatCompletions.enabled", value: true },
  { path: "agents.defaults.model.primary", value: process.env.OPENCLAW_OPENWEBUI_MODEL },
];
fs.writeFileSync(batchPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
NODE
    node "$entry" config set --batch-file "$batch_file" >/dev/null
    rm -f "$batch_file"

    workspace="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
    mkdir -p "$workspace/.openclaw"
    cat > "$workspace/IDENTITY.md" <<'"'"'EOF'"'"'
# Identity

- Name: OpenClaw
- Purpose: Open WebUI Docker compatibility smoke test assistant.
EOF
    cat > "$workspace/.openclaw/workspace-state.json" <<'"'"'EOF'"'"'
{
  "version": 1,
  "setupCompletedAt": "2026-01-01T00:00:00.000Z"
}
EOF
    rm -f "$workspace/BOOTSTRAP.md"

    exec node "$entry" gateway --port '"$PORT"' --bind lan --allow-unconfigured > /tmp/openwebui-gateway.log 2>&1
  ' >/dev/null

echo "Waiting for gateway HTTP surface..."
gateway_ready=0
for _ in $(seq 1 240); do
  if [ "$(docker_cmd docker inspect -f '{{.State.Running}}' "$GW_NAME" 2>/dev/null || echo false)" != "true" ]; then
    break
  fi
  if docker_cmd docker exec "$GW_NAME" bash -lc "node --input-type=module -e '
    const res = await fetch(\"http://127.0.0.1:$PORT/v1/models\", {
      headers: { authorization: \"Bearer $TOKEN\" },
    }).catch(() => null);
    process.exit(res?.status === 200 ? 0 : 1);
  ' >/dev/null 2>&1"; then
    gateway_ready=1
    break
  fi
  sleep 1
done

if [ "$gateway_ready" -ne 1 ]; then
  echo "Gateway failed to start"
  docker_cmd docker inspect "$GW_NAME" --format '{{json .State}}' 2>/dev/null || true
  if [ "$(docker_cmd docker inspect -f '{{.State.Running}}' "$GW_NAME" 2>/dev/null || echo false)" = "true" ]; then
    docker_cmd docker exec "$GW_NAME" bash -lc 'tail -n 200 /tmp/openwebui-gateway.log' || true
  fi
  docker_cmd docker logs "$GW_NAME" 2>&1 | tail -n 200 || true
  exit 1
fi

echo "Starting Open WebUI container..."
docker_cmd docker run -d \
  --name "$OW_NAME" \
  --network "$NET_NAME" \
  -e ENV=prod \
  -e WEBUI_NAME="OpenClaw E2E" \
  -e WEBUI_SECRET_KEY="openclaw-openwebui-e2e-secret-key-v1" \
  -e OFFLINE_MODE=True \
  -e ENABLE_VERSION_UPDATE_CHECK=False \
  -e ENABLE_PERSISTENT_CONFIG=False \
  -e ENABLE_OLLAMA_API=False \
  -e ENABLE_OPENAI_API=True \
  -e OPENAI_API_BASE_URLS="http://$GW_NAME:$PORT/v1" \
  -e OPENAI_API_KEY="$TOKEN" \
  -e OPENAI_API_KEYS="$TOKEN" \
  -e RAG_EMBEDDING_MODEL_AUTO_UPDATE=False \
  -e RAG_RERANKING_MODEL_AUTO_UPDATE=False \
  -e WEBUI_ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e WEBUI_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e WEBUI_ADMIN_NAME="OpenClaw E2E" \
  -e ENABLE_SIGNUP=False \
  -e DEFAULT_MODELS="openclaw/default" \
  "$OPENWEBUI_IMAGE" >/dev/null

echo "Waiting for Open WebUI..."
ow_ready=0
for _ in $(seq 1 240); do
  if [ "$(docker_cmd docker inspect -f '{{.State.Running}}' "$OW_NAME" 2>/dev/null || echo false)" != "true" ]; then
    break
  fi
  if docker_cmd docker exec "$GW_NAME" bash -lc "node --input-type=module -e '
    const res = await fetch(\"http://$OW_NAME:$WEBUI_PORT/\").catch(() => null);
    process.exit(res && res.status < 500 ? 0 : 1);
  ' >/dev/null 2>&1"; then
    ow_ready=1
    break
  fi
  sleep 1
done

if [ "$ow_ready" -ne 1 ]; then
  echo "Open WebUI failed to start"
  docker_cmd docker logs "$OW_NAME" 2>&1 | tail -n 200 || true
  exit 1
fi

echo "Waiting for gateway model endpoint after Open WebUI startup..."
gateway_model_ready=0
for _ in $(seq 1 90); do
  if [ "$(docker_cmd docker inspect -f '{{.State.Running}}' "$GW_NAME" 2>/dev/null || echo false)" != "true" ]; then
    break
  fi
  if docker_cmd docker exec "$GW_NAME" bash -lc "node --input-type=module -e '
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(\"http://$GW_NAME:$PORT/v1/models\", {
        headers: { authorization: \"Bearer $TOKEN\" },
        signal: controller.signal,
      });
      process.exit(res.status === 200 ? 0 : 1);
    } catch {
      process.exit(1);
    } finally {
      clearTimeout(timeout);
    }
  ' >/dev/null 2>&1"; then
    gateway_model_ready=1
    break
  fi
  sleep 5
done

if [ "$gateway_model_ready" -ne 1 ]; then
  echo "Gateway model endpoint did not stay reachable after Open WebUI startup"
  docker_cmd docker inspect "$GW_NAME" --format '{{json .State}}' 2>/dev/null || true
  if [ "$(docker_cmd docker inspect -f '{{.State.Running}}' "$GW_NAME" 2>/dev/null || echo false)" = "true" ]; then
    docker_cmd docker exec "$GW_NAME" bash -lc 'tail -n 200 /tmp/openwebui-gateway.log' || true
  fi
  docker_cmd docker logs "$GW_NAME" 2>&1 | tail -n 200 || true
  docker_cmd docker logs "$OW_NAME" 2>&1 | tail -n 200 || true
  exit 1
fi

echo "Running Open WebUI -> OpenClaw smoke..."
if ! docker_cmd docker exec \
  -e "OPENWEBUI_BASE_URL=http://$OW_NAME:$WEBUI_PORT" \
  -e "OPENWEBUI_ADMIN_EMAIL=$ADMIN_EMAIL" \
  -e "OPENWEBUI_ADMIN_PASSWORD=$ADMIN_PASSWORD" \
  -e "OPENWEBUI_EXPECTED_NONCE=$PROMPT_NONCE" \
  -e "OPENWEBUI_PROMPT=$PROMPT" \
  -e "OPENWEBUI_MODEL_ATTEMPTS=72" \
  -e "OPENWEBUI_MODEL_RETRY_MS=5000" \
  "$GW_NAME" \
  node /app/scripts/e2e/openwebui-probe.mjs >/tmp/openwebui-probe.log 2>&1; then
  cat /tmp/openwebui-probe.log 2>/dev/null || true
  echo "Open WebUI probe failed; gateway log tail:"
  docker_cmd docker inspect "$GW_NAME" --format '{{json .State}}' 2>/dev/null || true
  if [ "$(docker_cmd docker inspect -f '{{.State.Running}}' "$GW_NAME" 2>/dev/null || echo false)" = "true" ]; then
    docker_cmd docker exec "$GW_NAME" bash -lc 'tail -n 200 /tmp/openwebui-gateway.log' || true
  fi
  docker_cmd docker logs "$GW_NAME" 2>&1 | tail -n 200 || true
  echo "Open WebUI container logs:"
  docker_cmd docker logs "$OW_NAME" 2>&1 | tail -n 200 || true
  exit 1
fi

echo "OK"
