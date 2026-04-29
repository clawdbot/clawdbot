#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_SKIP_GMAIL_WATCHER=1
export OPENCLAW_SKIP_CRON=1
export OPENCLAW_SKIP_CANVAS_HOST=1
export OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1
export OPENCLAW_SKIP_ACPX_RUNTIME=1
export OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1

PORT="${PORT:?missing PORT}"
MOCK_PORT="${MOCK_PORT:?missing MOCK_PORT}"
TOKEN="${OPENCLAW_GATEWAY_TOKEN:?missing OPENCLAW_GATEWAY_TOKEN}"
SUCCESS_MARKER="OPENCLAW_SCHEMA_E2E_OK"
RAW_SCHEMA_ERROR="400 The following tools cannot be used with reasoning.effort 'minimal': web_search."
MOCK_REQUEST_LOG="/tmp/openclaw-openai-web-search-minimal-requests.jsonl"
GATEWAY_LOG="/tmp/openclaw-openai-web-search-minimal-gateway.log"
mock_pid=""
gateway_pid=""

cleanup() {
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  if [ -n "${mock_pid:-}" ] && kill -0 "$mock_pid" 2>/dev/null; then
    kill "$mock_pid" 2>/dev/null || true
    wait "$mock_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "OpenAI web_search minimal Docker E2E failed with exit code $status" >&2
  for file in \
    "$GATEWAY_LOG" \
    /tmp/openclaw-openai-web-search-minimal-mock.log \
    /tmp/openclaw-openai-web-search-minimal-client-success.log \
    /tmp/openclaw-openai-web-search-minimal-client-reject.log \
    "$MOCK_REQUEST_LOG" \
    "$OPENCLAW_STATE_DIR/openclaw.json"; do
    if [ -f "$file" ]; then
      echo "--- $file ---" >&2
      sed -n '1,260p' "$file" >&2 || true
    fi
  done
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

entry="$(openclaw_e2e_resolve_entrypoint)"
mkdir -p "$OPENCLAW_STATE_DIR"

node --input-type=module <<'NODE'
import { patchOpenAINativeWebSearchPayload } from "./dist/extensions/openai/native-web-search.js";

const injectedPayload = {
  reasoning: { effort: "minimal", summary: "auto" },
};
const injectedResult = patchOpenAINativeWebSearchPayload(injectedPayload);
if (injectedResult !== "injected") {
  throw new Error(`expected native web_search injection, got ${injectedResult}`);
}
if (injectedPayload.reasoning.effort !== "low") {
  throw new Error(
    `expected injected native web_search to raise minimal reasoning to low, got ${JSON.stringify(injectedPayload.reasoning)}`,
  );
}
if (!injectedPayload.tools?.some((tool) => tool?.type === "web_search")) {
  throw new Error(`native web_search was not injected: ${JSON.stringify(injectedPayload)}`);
}

const existingNativePayload = {
  tools: [{ type: "web_search" }],
  reasoning: { effort: "minimal" },
};
const existingResult = patchOpenAINativeWebSearchPayload(existingNativePayload);
if (existingResult !== "native_tool_already_present") {
  throw new Error(`expected existing native web_search, got ${existingResult}`);
}
if (existingNativePayload.reasoning.effort !== "low") {
  throw new Error(
    `expected existing native web_search to raise minimal reasoning to low, got ${JSON.stringify(existingNativePayload.reasoning)}`,
  );
}
NODE

cat >"$OPENCLAW_STATE_DIR/openclaw.json" <<JSON
{
  "agents": {
    "defaults": {
      "model": { "primary": "openai/gpt-5" },
      "models": {
        "openai/gpt-5": {
          "params": {
            "transport": "sse",
            "openaiWsWarmup": false
          }
        }
      }
    }
  },
  "models": {
    "providers": {
      "openai": {
        "api": "openai-responses",
        "baseUrl": "http://api.openai.com/v1",
        "apiKey": { "source": "env", "provider": "default", "id": "OPENAI_API_KEY" },
        "request": { "allowPrivateNetwork": true },
        "models": [
          {
            "id": "gpt-5",
            "name": "gpt-5",
            "api": "openai-responses",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "contextTokens": 96000,
            "maxTokens": 4096
          }
        ]
      }
    }
  },
  "tools": {
    "web": {
      "search": {
        "enabled": true,
        "maxResults": 3
      }
    }
  },
  "plugins": {
    "enabled": true,
    "allow": ["openai"],
    "entries": {
      "openai": { "enabled": true }
    }
  },
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "${TOKEN}"
    }
  }
}
JSON

MOCK_PORT="$MOCK_PORT" \
  MOCK_REQUEST_LOG="$MOCK_REQUEST_LOG" \
  SUCCESS_MARKER="$SUCCESS_MARKER" \
  RAW_SCHEMA_ERROR="$RAW_SCHEMA_ERROR" \
  node scripts/e2e/lib/openai-web-search-minimal/mock-server.mjs >/tmp/openclaw-openai-web-search-minimal-mock.log 2>&1 &
mock_pid="$!"

for _ in $(seq 1 80); do
  if node -e "fetch('http://127.0.0.1:${MOCK_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
node -e "fetch('http://127.0.0.1:${MOCK_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null

node "$entry" gateway --port "$PORT" --bind loopback --allow-unconfigured >"$GATEWAY_LOG" 2>&1 &
gateway_pid="$!"
for _ in $(seq 1 360); do
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    echo "gateway exited before listening" >&2
    exit 1
  fi
  if node "$entry" gateway health \
    --url "ws://127.0.0.1:$PORT" \
    --token "$TOKEN" \
    --timeout 120000 \
    --json >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
node "$entry" gateway health \
  --url "ws://127.0.0.1:$PORT" \
  --token "$TOKEN" \
  --timeout 120000 \
  --json >/dev/null

PORT="$PORT" OPENCLAW_GATEWAY_TOKEN="$TOKEN" node scripts/e2e/lib/openai-web-search-minimal/client.mjs success >/tmp/openclaw-openai-web-search-minimal-client-success.log 2>&1

node - "$MOCK_REQUEST_LOG" <<'NODE'
const fs = require("node:fs");
const logPath = process.argv[2];
const entries = fs.readFileSync(logPath, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
const responseEntries = entries.filter((entry) => entry.path === "/v1/responses");
if (responseEntries.length < 1) {
  throw new Error(`mock OpenAI /v1/responses was not used. Requests: ${JSON.stringify(entries)}`);
}
const success = responseEntries.find((entry) => JSON.stringify(entry.body).includes("OPENCLAW_SCHEMA_E2E_OK"));
if (!success) {
  throw new Error(`missing success request. Requests: ${JSON.stringify(responseEntries)}`);
}
const tools = Array.isArray(success.body.tools) ? success.body.tools : [];
const hasWebSearch = tools.some((tool) => tool?.type === "web_search" || (tool?.type === "function" && (tool?.name === "web_search" || tool?.function?.name === "web_search")));
if (!hasWebSearch) {
  throw new Error(`success request did not include web_search. Body: ${JSON.stringify(success.body)}`);
}
if (success.body.reasoning?.effort === "minimal") {
  throw new Error(`expected web_search request to avoid minimal reasoning, got ${JSON.stringify(success.body.reasoning)}`);
}
NODE

PORT="$PORT" OPENCLAW_GATEWAY_TOKEN="$TOKEN" node scripts/e2e/lib/openai-web-search-minimal/client.mjs reject >/tmp/openclaw-openai-web-search-minimal-client-reject.log 2>&1

for _ in $(seq 1 80); do
  if grep -Fq "$RAW_SCHEMA_ERROR" "$GATEWAY_LOG"; then
    break
  fi
  sleep 0.25
done
grep -F "$RAW_SCHEMA_ERROR" "$GATEWAY_LOG" >/dev/null

echo "OpenAI web_search minimal reasoning Docker E2E passed"
