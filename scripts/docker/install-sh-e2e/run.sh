#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${CLAWDBOT_INSTALL_URL:-https://molt.bot/install.sh}"
MODELS_MODE="${CLAWDBOT_E2E_MODELS:-both}" # both|openai|anthropic
INSTALL_TAG="${CLAWDBOT_INSTALL_TAG:-latest}"
E2E_PREVIOUS_VERSION="${CLAWDBOT_INSTALL_E2E_PREVIOUS:-}"
SKIP_PREVIOUS="${CLAWDBOT_INSTALL_E2E_SKIP_PREVIOUS:-0}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_API_TOKEN="${ANTHROPIC_API_TOKEN:-}"

if [[ "$MODELS_MODE" != "both" && "$MODELS_MODE" != "openai" && "$MODELS_MODE" != "anthropic" ]]; then
  echo "ERROR: CLAWDBOT_E2E_MODELS must be one of: both|openai|anthropic" >&2
  exit 2
fi

if [[ "$MODELS_MODE" == "both" ]]; then
  if [[ -z "$OPENAI_API_KEY" ]]; then
    echo "ERROR: CLAWDBOT_E2E_MODELS=both requires OPENAI_API_KEY." >&2
    exit 2
  fi
  if [[ -z "$ANTHROPIC_API_TOKEN" && -z "$ANTHROPIC_API_KEY" ]]; then
    echo "ERROR: CLAWDBOT_E2E_MODELS=both requires ANTHROPIC_API_TOKEN or ANTHROPIC_API_KEY." >&2
    exit 2
  fi
elif [[ "$MODELS_MODE" == "openai" && -z "$OPENAI_API_KEY" ]]; then
  echo "ERROR: CLAWDBOT_E2E_MODELS=openai requires OPENAI_API_KEY." >&2
  exit 2
elif [[ "$MODELS_MODE" == "anthropic" && -z "$ANTHROPIC_API_TOKEN" && -z "$ANTHROPIC_API_KEY" ]]; then
  echo "ERROR: CLAWDBOT_E2E_MODELS=anthropic requires ANTHROPIC_API_TOKEN or ANTHROPIC_API_KEY." >&2
  exit 2
fi

echo "==> Resolve npm versions"
EXPECTED_VERSION="$(npm view "moltbot@${INSTALL_TAG}" version)"
if [[ -z "$EXPECTED_VERSION" || "$EXPECTED_VERSION" == "undefined" || "$EXPECTED_VERSION" == "null" ]]; then
  echo "ERROR: unable to resolve moltbot@${INSTALL_TAG} version" >&2
  exit 2
fi
if [[ -n "$E2E_PREVIOUS_VERSION" ]]; then
  PREVIOUS_VERSION="$E2E_PREVIOUS_VERSION"
else
  PREVIOUS_VERSION="$(node - <<'NODE'
const { execSync } = require("node:child_process");
const versions = JSON.parse(execSync("npm view moltbot versions --json", { encoding: "utf8" }));
if (!Array.isArray(versions) || versions.length === 0) process.exit(1);
process.stdout.write(versions.length >= 2 ? versions[versions.length - 2] : versions[0]);
NODE
  )"
fi
echo "expected=$EXPECTED_VERSION previous=$PREVIOUS_VERSION"

if [[ "$SKIP_PREVIOUS" == "1" ]]; then
  echo "==> Skip preinstall previous (CLAWDBOT_INSTALL_E2E_SKIP_PREVIOUS=1)"
else
  echo "==> Preinstall previous (forces installer upgrade path; avoids read() prompt)"
  npm install -g "moltbot@${PREVIOUS_VERSION}"
fi

echo "==> Run official installer one-liner"
if [[ "$INSTALL_TAG" == "beta" ]]; then
  CLAWDBOT_BETA=1 curl -fsSL "$INSTALL_URL" | bash
elif [[ "$INSTALL_TAG" != "latest" ]]; then
  CLAWDBOT_VERSION="$INSTALL_TAG" curl -fsSL "$INSTALL_URL" | bash
else
  curl -fsSL "$INSTALL_URL" | bash
fi

echo "==> Verify installed version"
INSTALLED_VERSION="$(moltbot --version 2>/dev/null | head -n 1 | tr -d '\r')"
echo "installed=$INSTALLED_VERSION expected=$EXPECTED_VERSION"
if [[ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "ERROR: expected moltbot@$EXPECTED_VERSION, got moltbot@$INSTALLED_VERSION" >&2
  exit 1
fi

set_image_model() {
  local profile="$1"
  shift
  local candidate
  for candidate in "$@"; do
    if moltbot --profile "$profile" models set-image "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  echo "ERROR: could not set an image model (tried: $*)" >&2
  return 1
}

set_agent_model() {
  local profile="$1"
  local candidate
  shift
  for candidate in "$@"; do
    if moltbot --profile "$profile" models set "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  echo "ERROR: could not set agent model (tried: $*)" >&2
  return 1
}

write_png_lr_rg() {
  local out="$1"
  node - <<'NODE' "$out"
const fs = require("node:fs");
const zlib = require("node:zlib");

const out = process.argv[2];
const width = 96;
const height = 64;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const rows = [];
for (let y = 0; y < height; y++) {
  const row = Buffer.alloc(1 + width * 3);
  row[0] = 0; // filter: none
  for (let x = 0; x < width; x++) {
    const i = 1 + x * 3;
    const left = x < width / 2;
    row[i + 0] = left ? 255 : 0;
    row[i + 1] = left ? 0 : 255;
    row[i + 2] = 0;
  }
  rows.push(row);
}
const raw = Buffer.concat(rows);
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(out, png);
NODE
}

run_agent_turn() {
  local profile="$1"
  local session_id="$2"
  local prompt="$3"
  local out_json="$4"
  moltbot --profile "$profile" agent \
    --session-id "$session_id" \
    --message "$prompt" \
    --thinking off \
    --json >"$out_json"
}

assert_agent_json_has_text() {
  local path="$1"
  node - <<'NODE' "$path"
const fs = require("node:fs");
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const payloads =
  Array.isArray(p?.result?.payloads) ? p.result.payloads :
  Array.isArray(p?.payloads) ? p.payloads :
  [];
const texts = payloads.map((x) => String(x?.text ?? "").trim()).filter(Boolean);
if (texts.length === 0) process.exit(1);
NODE
}

assert_agent_json_ok() {
  local json_path="$1"
  local expect_provider="$2"
  node - <<'NODE' "$json_path" "$expect_provider"
const fs = require("node:fs");
const jsonPath = process.argv[2];
const expectProvider = process.argv[3];
const p = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

if (typeof p?.status === "string" && p.status !== "ok" && p.status !== "accepted") {
  console.error(`ERROR: gateway status=${p.status}`);
  process.exit(1);
}

const result = p?.result ?? p;
const payloads = Array.isArray(result?.payloads) ? result.payloads : [];
const anyError = payloads.some((pl) => pl && pl.isError === true);
const combinedText = payloads.map((pl) => String(pl?.text ?? "")).filter(Boolean).join("\n").trim();
if (anyError) {
  console.error(`ERROR: agent returned error payload: ${combinedText}`);
  process.exit(1);
}
if (/rate_limit_error/i.test(combinedText) || /^429\\b/.test(combinedText)) {
  console.error(`ERROR: agent rate limited: ${combinedText}`);
  process.exit(1);
}

const meta = result?.meta;
const provider =
  (typeof meta?.agentMeta?.provider === "string" && meta.agentMeta.provider.trim()) ||
  (typeof meta?.provider === "string" && meta.provider.trim()) ||
  "";
if (expectProvider && provider && provider !== expectProvider) {
  console.error(`ERROR: expected provider=${expectProvider}, got provider=${provider}`);
  process.exit(1);
}
NODE
}

extract_matching_text() {
  local path="$1"
  local expected="$2"
  node - <<'NODE' "$path" "$expected"
const fs = require("node:fs");
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = String(process.argv[3] ?? "");
const payloads =
  Array.isArray(p?.result?.payloads) ? p.result.payloads :
  Array.isArray(p?.payloads) ? p.payloads :
  [];
const texts = payloads.map((x) => String(x?.text ?? "").trim()).filter(Boolean);
const match = texts.find((text) => text === expected);
process.stdout.write(match ?? texts[0] ?? "");
NODE
}

assert_session_used_tools() {
  local jsonl="$1"
  shift
  node - <<'NODE' "$jsonl" "$@"
const fs = require("node:fs");
const jsonl = process.argv[2];
const required = new Set(process.argv.slice(3));

const raw = fs.readFileSync(jsonl, "utf8");
const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
const seen = new Set();

const toolTypes = new Set([
  "tool_use",
  "tool_result",
  "tool",
  "tool-call",
  "tool_call",
  "tooluse",
  "tool-use",
  "toolresult",
  "tool-result",
]);
function walk(node, parent) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, node);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node;
  const t = typeof obj.type === "string" ? obj.type : null;
  if (t && (toolTypes.has(t) || /tool/i.test(t))) {
    const name =
      typeof obj.name === "string" ? obj.name :
      typeof obj.toolName === "string" ? obj.toolName :
      typeof obj.tool_name === "string" ? obj.tool_name :
      (obj.tool && typeof obj.tool.name === "string") ? obj.tool.name :
      null;
    if (name) seen.add(name);
  }
  if (typeof obj.name === "string" && typeof obj.input === "object" && obj.input) {
    // Many tool-use blocks look like { type: "...", name: "exec", input: {...} }
    // but some transcripts omit/rename type.
    seen.add(obj.name);
  }
  // OpenAI-ish tool call shapes.
  if (Array.isArray(obj.tool_calls)) {
    for (const c of obj.tool_calls) {
      const fn = c?.function;
      if (fn && typeof fn.name === "string") seen.add(fn.name);
    }
  }
  if (obj.function && typeof obj.function.name === "string") seen.add(obj.function.name);
  for (const v of Object.values(obj)) walk(v, obj);
}

for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    walk(entry, null);
  } catch {
    // ignore unparsable lines
  }
}

const missing = [...required].filter((t) => !seen.has(t));
if (missing.length > 0) {
  console.error(`Missing tools in transcript: ${missing.join(", ")}`);
  console.error(`Seen tools: ${[...seen].sort().join(", ")}`);
  console.error("Transcript head:");
  console.error(lines.slice(0, 5).join("\n"));
  process.exit(1);
}
NODE
}

run_profile() {
  local profile="$1"
  local port="$2"
  local workspace="$3"
  local agent_model_provider="$4" # "openai"|"anthropic"

	  echo "==> Onboard ($profile)"
	  if [[ "$agent_model_provider" == "openai" ]]; then
	    moltbot --profile "$profile" onboard \
	      --non-interactive \
	      --accept-risk \
	      --flow quickstart \
	      --auth-choice openai-api-key \
	      --openai-api-key "$OPENAI_API_KEY" \
	      --gateway-port "$port" \
	      --gateway-bind loopback \
      --gateway-auth token \
      --workspace "$workspace" \
      --skip-health
	  elif [[ -n "$ANTHROPIC_API_TOKEN" ]]; then
	    moltbot --profile "$profile" onboard \
	      --non-interactive \
	      --accept-risk \
	      --flow quickstart \
	      --auth-choice token \
	      --token-provider anthropic \
	      --token "$ANTHROPIC_API_TOKEN" \
	      --gateway-port "$port" \
      --gateway-bind loopback \
      --gateway-auth token \
      --workspace "$workspace" \
      --skip-health
	  else
	    moltbot --profile "$profile" onboard \
	      --non-interactive \
	      --accept-risk \
	      --flow quickstart \
	      --auth-choice apiKey \
	      --anthropic-api-key "$ANTHROPIC_API_KEY" \
	      --gateway-port "$port" \
	      --gateway-bind loopback \
      --gateway-auth token \
      --workspace "$workspace" \
      --skip-health
  fi

  echo "==> Verify workspace identity files ($profile)"
  test -f "$workspace/AGENTS.md"
  test -f "$workspace/IDENTITY.md"
  test -f "$workspace/USER.md"
  test -f "$workspace/SOUL.md"
  test -f "$workspace/TOOLS.md"

  echo "==> Configure models ($profile)"
  local agent_model
  local image_model
  if [[ "$agent_model_provider" == "openai" ]]; then
    agent_model="$(set_agent_model "$profile" \
      "openai/gpt-4.1-mini" \
      "openai/gpt-4.1" \
      "openai/gpt-4o-mini" \
      "openai/gpt-4o")"
    image_model="$(set_image_model "$profile" \
      "openai/gpt-4.1" \
      "openai/gpt-4o-mini" \
      "openai/gpt-4o" \
      "openai/gpt-4.1-mini")"
  else
    agent_model="$(set_agent_model "$profile" \
      "anthropic/claude-opus-4-5" \
      "claude-opus-4-5")"
    image_model="$(set_image_model "$profile" \
      "anthropic/claude-opus-4-5" \
      "claude-opus-4-5")"
  fi
  echo "model=$agent_model"
  echo "imageModel=$image_model"

  echo "==> Prepare tool fixtures ($profile)"
  PROOF_TXT="$workspace/proof.txt"
  PROOF_COPY="$workspace/copy.txt"
  HOSTNAME_TXT="$workspace/hostname.txt"
  IMAGE_PNG="$workspace/proof.png"
  IMAGE_TXT="$workspace/image.txt"
  SESSION_ID="e2e-tools-${profile}"
  SESSION_JSONL="/root/.clawdbot-${profile}/agents/main/sessions/${SESSION_ID}.jsonl"

  PROOF_VALUE="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"
  echo -n "$PROOF_VALUE" >"$PROOF_TXT"
  write_png_lr_rg "$IMAGE_PNG"
  EXPECTED_HOSTNAME="$(cat /etc/hostname | tr -d '\r\n')"

  echo "==> Start gateway ($profile)"
  GATEWAY_LOG="$workspace/gateway.log"
  moltbot --profile "$profile" gateway --port "$port" --bind loopback >"$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID="$!"
  cleanup_profile() {
    if kill -0 "$GATEWAY_PID" 2>/dev/null; then
      kill "$GATEWAY_PID" 2>/dev/null || true
      wait "$GATEWAY_PID" 2>/dev/null || true
    fi
  }
  trap cleanup_profile EXIT

  echo "==> Wait for health ($profile)"
  for _ in $(seq 1 60); do
    if moltbot --profile "$profile" health --timeout 2000 --json >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  moltbot --profile "$profile" health --timeout 10000 --json >/dev/null

  echo "==> Agent turns ($profile)"
  TURN1_JSON="/tmp/agent-${profile}-1.json"
  TURN2_JSON="/tmp/agent-${profile}-2.json"
  TURN3_JSON="/tmp/agent-${profile}-3.json"
  TURN4_JSON="/tmp/agent-${profile}-4.json"

  run_agent_turn "$profile" "$SESSION_ID" \
    "Use the read tool (not exec) to read proof.txt. Reply with the exact contents only (no extra whitespace)." \
    "$TURN1_JSON"
  assert_agent_json_has_text "$TURN1_JSON"
  assert_agent_json_ok "$TURN1_JSON" "$agent_model_provider"
  local reply1
  reply1="$(extract_matching_text "$TURN1_JSON" "$PROOF_VALUE" | tr -d '\r\n')"
  if [[ "$reply1" != "$PROOF_VALUE" ]]; then
    echo "ERROR: agent did not read proof.txt correctly ($profile): $reply1" >&2
    exit 1
  fi

  local prompt2
  prompt2=$'Use the write tool (not exec) to write exactly this string into copy.txt:\n'"${reply1}"$'\nThen use the read tool (not exec) to read copy.txt and reply with the exact contents only (no extra whitespace).'
  run_agent_turn "$profile" "$SESSION_ID" "$prompt2" "$TURN2_JSON"
  assert_agent_json_has_text "$TURN2_JSON"
  assert_agent_json_ok "$TURN2_JSON" "$agent_model_provider"
  local copy_value
  copy_value="$(cat "$PROOF_COPY" 2>/dev/null | tr -d '\r\n' || true)"
  if [[ "$copy_value" != "$PROOF_VALUE" ]]; then
    echo "ERROR: copy.txt did not match proof.txt ($profile)" >&2
    exit 1
  fi
  local reply2
  reply2="$(extract_matching_text "$TURN2_JSON" "$PROOF_VALUE" | tr -d '\r\n')"
  if [[ "$reply2" != "$PROOF_VALUE" ]]; then
    echo "ERROR: agent did not read copy.txt correctly ($profile): $reply2" >&2
    exit 1
  fi

  local prompt3
  prompt3=$'Use the exec tool to run: cat /etc/hostname\nThen use the write tool to write the exact stdout (trim trailing newline) into hostname.txt. Reply with the hostname only.'
  run_agent_turn "$profile" "$SESSION_ID" "$prompt3" "$TURN3_JSON"
  assert_agent_json_has_text "$TURN3_JSON"
  assert_agent_json_ok "$TURN3_JSON" "$agent_model_provider"
  if [[ "$(cat "$HOSTNAME_TXT" 2>/dev/null | tr -d '\r\n' || true)" != "$EXPECTED_HOSTNAME" ]]; then
    echo "ERROR: hostname.txt did not match /etc/hostname ($profile)" >&2
    exit 1
  fi

  run_agent_turn "$profile" "$SESSION_ID" \
    "Use the image tool on proof.png. Determine which color is on the left half and which is on the right half. Then use the write tool to write exactly: LEFT=RED RIGHT=GREEN into image.txt. Reply with exactly: LEFT=RED RIGHT=GREEN" \
    "$TURN4_JSON"
  assert_agent_json_has_text "$TURN4_JSON"
  assert_agent_json_ok "$TURN4_JSON" "$agent_model_provider"
  if [[ "$(cat "$IMAGE_TXT" 2>/dev/null | tr -d '\r\n' || true)" != "LEFT=RED RIGHT=GREEN" ]]; then
    echo "ERROR: image.txt did not contain expected marker ($profile)" >&2
    exit 1
  fi
  local reply4
  reply4="$(extract_matching_text "$TURN4_JSON" "LEFT=RED RIGHT=GREEN")"
  if [[ "$reply4" != "LEFT=RED RIGHT=GREEN" ]]; then
    echo "ERROR: agent reply did not contain expected marker ($profile): $reply4" >&2
    exit 1
  fi

  echo "==> Verify tool usage via session transcript ($profile)"
  # Give the gateway a moment to flush transcripts.
  sleep 1
  if [[ ! -f "$SESSION_JSONL" ]]; then
    echo "ERROR: missing session transcript ($profile): $SESSION_JSONL" >&2
    ls -la "/root/.clawdbot-${profile}/agents/main/sessions" >&2 || true
    exit 1
  fi
  assert_session_used_tools "$SESSION_JSONL" read write exec image

  cleanup_profile
  trap - EXIT
}

if [[ "$MODELS_MODE" == "openai" || "$MODELS_MODE" == "both" ]]; then
  run_profile "e2e-openai" "18789" "/tmp/clawd-e2e-openai" "openai"
fi

if [[ "$MODELS_MODE" == "anthropic" || "$MODELS_MODE" == "both" ]]; then
  run_profile "e2e-anthropic" "18799" "/tmp/clawd-e2e-anthropic" "anthropic"
fi

echo "OK"
