#!/usr/bin/env bash
# Official installer E2E harness for Docker.
#
# Installs OpenClaw through the public one-liner, verifies the resolved npm
# version, then exercises onboard + local embedded agent tool turns for the
# configured model providers. Keep this script package-install based: it should
# validate the installed npm artifact, not repo sources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_HELPER_PATH="/usr/local/install-sh-common/version-parse.sh"
if [[ ! -f "$VERIFY_HELPER_PATH" ]]; then
  VERIFY_HELPER_PATH="${SCRIPT_DIR}/../install-sh-common/version-parse.sh"
fi
# shellcheck source=../install-sh-common/version-parse.sh
source "$VERIFY_HELPER_PATH"

INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
MODELS_MODE="${OPENCLAW_E2E_MODELS:-both}" # both|openai|anthropic
INSTALL_TAG="${OPENCLAW_INSTALL_TAG:-latest}"
E2E_PREVIOUS_VERSION="${OPENCLAW_INSTALL_E2E_PREVIOUS:-}"
SKIP_PREVIOUS="${OPENCLAW_INSTALL_E2E_SKIP_PREVIOUS:-0}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_API_TOKEN="${ANTHROPIC_API_TOKEN:-}"
AGENT_TURN_TIMEOUT_SECONDS="${OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS:-600}"
AGENT_TURNS_PARALLEL="${OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL:-1}"

time_phase() {
  local name="$1"
  shift
  local started_at
  local finished_at
  local status
  started_at="$(date +%s)"
  echo "==> Phase start: $name"
  set +e
  "$@"
  status="$?"
  set -e
  finished_at="$(date +%s)"
  if [[ "$status" -eq 0 ]]; then
    echo "==> Phase passed: $name ($((finished_at - started_at))s)"
  else
    echo "==> Phase failed: $name ($((finished_at - started_at))s, status=$status)" >&2
  fi
  return "$status"
}

PHASE_MARK_STARTED_AT=0

phase_mark_start() {
  PHASE_MARK_STARTED_AT="$(date +%s)"
  echo "==> Phase start: $1"
}

phase_mark_passed() {
  local name="$1"
  echo "==> Phase passed: $name ($(($(date +%s) - PHASE_MARK_STARTED_AT))s)"
}

# This image runs as a non-root user, so seed a user-local npm prefix before we
# preinstall an older global version to exercise the upgrade path.
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"
mkdir -p "$NPM_CONFIG_PREFIX"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

if [[ "$MODELS_MODE" != "both" && "$MODELS_MODE" != "openai" && "$MODELS_MODE" != "anthropic" ]]; then
  echo "ERROR: OPENCLAW_E2E_MODELS must be one of: both|openai|anthropic" >&2
  exit 2
fi

if [[ "$MODELS_MODE" == "both" ]]; then
  if [[ -z "$OPENAI_API_KEY" ]]; then
    echo "ERROR: OPENCLAW_E2E_MODELS=both requires OPENAI_API_KEY." >&2
    exit 2
  fi
  if [[ -z "$ANTHROPIC_API_TOKEN" && -z "$ANTHROPIC_API_KEY" ]]; then
    echo "ERROR: OPENCLAW_E2E_MODELS=both requires ANTHROPIC_API_TOKEN or ANTHROPIC_API_KEY." >&2
    exit 2
  fi
elif [[ "$MODELS_MODE" == "openai" && -z "$OPENAI_API_KEY" ]]; then
  echo "ERROR: OPENCLAW_E2E_MODELS=openai requires OPENAI_API_KEY." >&2
  exit 2
elif [[ "$MODELS_MODE" == "anthropic" && -z "$ANTHROPIC_API_TOKEN" && -z "$ANTHROPIC_API_KEY" ]]; then
  echo "ERROR: OPENCLAW_E2E_MODELS=anthropic requires ANTHROPIC_API_TOKEN or ANTHROPIC_API_KEY." >&2
  exit 2
fi

resolve_npm_versions() {
  EXPECTED_VERSION="$(quiet_npm view "openclaw@${INSTALL_TAG}" version)"
  if [[ -z "$EXPECTED_VERSION" || "$EXPECTED_VERSION" == "undefined" || "$EXPECTED_VERSION" == "null" ]]; then
    echo "ERROR: unable to resolve openclaw@${INSTALL_TAG} version" >&2
    return 2
  fi
  if [[ -n "$E2E_PREVIOUS_VERSION" ]]; then
    PREVIOUS_VERSION="$E2E_PREVIOUS_VERSION"
  else
    PREVIOUS_VERSION="$(VERSIONS_JSON="$(quiet_npm view openclaw versions --json)" node - <<'NODE'
const versions = JSON.parse(process.env.VERSIONS_JSON || "[]");
if (!Array.isArray(versions) || versions.length === 0) process.exit(1);
process.stdout.write(versions.length >= 2 ? versions[versions.length - 2] : versions[0]);
NODE
    )"
  fi
  echo "expected=$EXPECTED_VERSION previous=$PREVIOUS_VERSION"
}

preinstall_previous_version() {
  if [[ "$SKIP_PREVIOUS" == "1" ]]; then
    echo "Skip preinstall previous (OPENCLAW_INSTALL_E2E_SKIP_PREVIOUS=1)"
  else
    echo "Preinstall previous (forces installer upgrade path; avoids read() prompt)"
    quiet_npm install -g "openclaw@${PREVIOUS_VERSION}"
  fi
}

run_official_installer() {
  if [[ "$INSTALL_TAG" == "beta" ]]; then
    curl -fsSL "$INSTALL_URL" | OPENCLAW_BETA=1 bash
  elif [[ "$INSTALL_TAG" != "latest" ]]; then
    curl -fsSL "$INSTALL_URL" | OPENCLAW_VERSION="$INSTALL_TAG" bash
  else
    curl -fsSL "$INSTALL_URL" | bash
  fi
}

verify_installed_version() {
  INSTALLED_VERSION="$(openclaw --version 2>/dev/null | head -n 1 | tr -d '\r')"
  INSTALLED_VERSION="$(extract_openclaw_semver "$INSTALLED_VERSION")"
  echo "installed=$INSTALLED_VERSION expected=$EXPECTED_VERSION"
  if [[ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]]; then
    echo "ERROR: expected openclaw@$EXPECTED_VERSION, got openclaw@$INSTALLED_VERSION" >&2
    return 1
  fi
}

time_phase "Resolve npm versions" resolve_npm_versions
time_phase "Preinstall previous" preinstall_previous_version
time_phase "Run official installer one-liner" run_official_installer
time_phase "Verify installed version" verify_installed_version

set_image_model() {
  local profile="$1"
  shift
  local candidate
  for candidate in "$@"; do
    if openclaw --profile "$profile" models set-image "$candidate" >/dev/null 2>&1; then
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
    if openclaw --profile "$profile" models set "$candidate" >/dev/null 2>&1; then
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
  # Installer E2E validates install + onboard + embedded agent tooling. It does
  # not need a paired Gateway control-plane hop, which is flaky/non-deterministic
  # in the isolated container and already covered by gateway-specific lanes.
  set +e
  timeout --kill-after=15s "${AGENT_TURN_TIMEOUT_SECONDS}s" \
    openclaw --profile "$profile" agent \
    --local \
    --session-id "$session_id" \
    --message "$prompt" \
    --thinking off \
    --json >"$out_json" 2>&1
  local status="$?"
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "ERROR: agent turn failed ($profile, status=$status, output=$out_json)" >&2
    dump_profile_debug "$profile" "$out_json" >&2 || true
    return "$status"
  fi
  node - <<'NODE' "$out_json"
const fs = require("node:fs");

const path = process.argv[2];
const raw = fs.readFileSync(path, "utf8");

function extractTrailingJsonObject(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("agent output was empty");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some local runs emit stderr diagnostics before the final JSON payload.
    // Walk backward and keep the last parseable top-level object.
    for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
      const candidate = trimmed.slice(index);
      try {
        return JSON.parse(candidate);
      } catch {
        // keep scanning
      }
    }
    throw new Error(`could not extract JSON payload from agent output:\n${trimmed}`);
  }
}

const parsed = extractTrailingJsonObject(raw);
fs.writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
NODE
}

RUN_AGENT_TURN_BG_PID=""

run_agent_turn_logged() {
  local label="$1"
  local profile="$2"
  local session_id="$3"
  local prompt="$4"
  local out_json="$5"
  local started_at
  SESSION_JSONL="$(session_jsonl_path "$profile" "$session_id")"
  started_at="$(date +%s)"
  echo "==> Agent turn start: $label ($profile)"
  run_agent_turn "$profile" "$session_id" "$prompt" "$out_json"
  echo "==> Agent turn passed: $label ($profile, $(($(date +%s) - started_at))s)"
}

run_agent_turn_bg() {
  local label="$1"
  local profile="$2"
  local session_id="$3"
  local prompt="$4"
  local out_json="$5"
  (
    set -euo pipefail
    run_agent_turn_logged "$label" "$profile" "$session_id" "$prompt" "$out_json"
  ) &
  RUN_AGENT_TURN_BG_PID="$!"
}

wait_agent_turn_batch() {
  local failed=0
  local pid
  for pid in "$@"; do
    if ! wait "$pid"; then
      failed=1
    fi
  done
  return "$failed"
}

dump_profile_debug() {
  local profile="$1"
  local turn_output="$2"

  echo "---- agent turn output ($profile) ----"
  if [[ -f "$turn_output" ]]; then
    tail -n 200 "$turn_output"
  else
    echo "missing: $turn_output"
  fi

  echo "---- gateway log ($profile) ----"
  if [[ -n "${GATEWAY_LOG:-}" && -f "$GATEWAY_LOG" ]]; then
    tail -n 200 "$GATEWAY_LOG"
  else
    echo "missing: ${GATEWAY_LOG:-<unset>}"
  fi

  echo "---- session transcript ($profile) ----"
  if [[ -n "${SESSION_JSONL:-}" && -f "$SESSION_JSONL" ]]; then
    tail -n 80 "$SESSION_JSONL"
  else
    echo "missing: ${SESSION_JSONL:-<unset>}"
    if [[ -n "${SESSION_JSONL:-}" ]]; then
      ls -la "$(dirname "$SESSION_JSONL")" 2>/dev/null || true
    fi
  fi

  echo "---- openclaw processes ($profile) ----"
  for cmdline in /proc/[0-9]*/cmdline; do
    [[ -r "$cmdline" ]] || continue
    local pid
    pid="$(basename "$(dirname "$cmdline")")"
    local command
    command="$(tr '\0' ' ' <"$cmdline" | sed 's/[[:space:]]*$//')"
    if [[ "$command" == *openclaw* || "$command" == *node* ]]; then
      echo "$pid $command"
    fi
  done
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
const containingMatch = texts.find((text) => text.includes(expected));
process.stdout.write(match ?? (containingMatch ? expected : texts[0]) ?? "");
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

session_jsonl_path() {
  local profile="$1"
  local session_id="$2"
  echo "$HOME/.openclaw-${profile}/agents/main/sessions/${session_id}.jsonl"
}

run_profile() {
  local profile="$1"
  local port="$2"
  local workspace="$3"
  local agent_model_provider="$4" # "openai"|"anthropic"

  phase_mark_start "Onboard ($profile)"
	  if [[ "$agent_model_provider" == "openai" ]]; then
	    openclaw --profile "$profile" onboard \
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
	  elif [[ -n "$ANTHROPIC_API_KEY" ]]; then
	    openclaw --profile "$profile" onboard \
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
	  elif [[ -n "$ANTHROPIC_API_TOKEN" ]]; then
	    openclaw --profile "$profile" onboard \
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
	    openclaw --profile "$profile" onboard \
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
  phase_mark_passed "Onboard ($profile)"

  phase_mark_start "Verify workspace identity files ($profile)"
  test -f "$workspace/AGENTS.md"
  test -f "$workspace/IDENTITY.md"
  test -f "$workspace/USER.md"
  test -f "$workspace/SOUL.md"
  test -f "$workspace/TOOLS.md"
  # The remaining checks are deterministic tool smokes, not the interactive
  # first-run identity ritual. Drop BOOTSTRAP.md so provider prompts stay focused
  # on the fixture task and do not spend turns following onboarding copy.
  rm -f "$workspace/BOOTSTRAP.md"
  phase_mark_passed "Verify workspace identity files ($profile)"

  phase_mark_start "Configure models ($profile)"
  local agent_model
  local image_model
  if [[ "$agent_model_provider" == "openai" ]]; then
    agent_model="$(set_agent_model "$profile" \
      "openai/gpt-5.5" \
      "openai/gpt-4o-mini" \
      "openai/gpt-4o")"
    image_model="$(set_image_model "$profile" \
      "openai/gpt-4o-mini" \
      "openai/gpt-4o")"
  else
    agent_model="$(set_agent_model "$profile" \
      "anthropic/claude-opus-4-6" \
      "claude-opus-4-6")"
    image_model="$(set_image_model "$profile" \
      "anthropic/claude-opus-4-6" \
      "claude-opus-4-6")"
  fi
  echo "model=$agent_model"
  echo "imageModel=$image_model"
  phase_mark_passed "Configure models ($profile)"

  phase_mark_start "Prepare tool fixtures ($profile)"
  PROOF_TXT="$workspace/proof.txt"
  PROOF_COPY="$workspace/copy.txt"
  HOSTNAME_TXT="$workspace/hostname.txt"
  IMAGE_PNG="$workspace/proof.png"
  IMAGE_TXT="$workspace/image.txt"
  SESSION_ID_PREFIX="e2e-tools-${profile}"
  SESSION_JSONL=""

  PROOF_VALUE="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"
  echo -n "$PROOF_VALUE" >"$PROOF_TXT"
  write_png_lr_rg "$IMAGE_PNG"
  EXPECTED_HOSTNAME="$(hostname | tr -d '\r\n')"
  phase_mark_passed "Prepare tool fixtures ($profile)"

  phase_mark_start "Start gateway ($profile)"
  GATEWAY_LOG="$workspace/gateway.log"
  openclaw --profile "$profile" gateway --port "$port" --bind loopback >"$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID="$!"
  cleanup_profile() {
    if kill -0 "$GATEWAY_PID" 2>/dev/null; then
      kill "$GATEWAY_PID" 2>/dev/null || true
      wait "$GATEWAY_PID" 2>/dev/null || true
    fi
  }
  trap cleanup_profile EXIT
  phase_mark_passed "Start gateway ($profile)"

  TURN1_JSON="/tmp/agent-${profile}-1.json"
  TURN2_JSON="/tmp/agent-${profile}-2.json"
  TURN2B_JSON="/tmp/agent-${profile}-2b.json"
  TURN3_JSON="/tmp/agent-${profile}-3.json"
  TURN3B_JSON="/tmp/agent-${profile}-3b.json"
  TURN4_JSON="/tmp/agent-${profile}-4.json"
  HEALTH_JSON="/tmp/health-${profile}.json"

  phase_mark_start "Wait for health ($profile)"
  for _ in $(seq 1 240); do
    if openclaw --profile "$profile" health --timeout 5000 --json >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if ! openclaw --profile "$profile" health --timeout 60000 --json >"$HEALTH_JSON" 2>&1; then
    echo "ERROR: gateway health failed ($profile, output=$HEALTH_JSON)" >&2
    dump_profile_debug "$profile" "$HEALTH_JSON" >&2 || true
    return 1
  fi
  phase_mark_passed "Wait for health ($profile)"

  phase_mark_start "Agent turns ($profile)"

  TURN1_SESSION_ID="${SESSION_ID_PREFIX}-read-proof"
  local prompt1
  prompt1="Use the read tool (not exec) to read ${PROOF_TXT}. Reply with the exact contents only (no extra whitespace)."
  local prompt2
  prompt2=$'Use the write tool (not exec) to write exactly this string into '"${PROOF_COPY}"$':\n'"${PROOF_VALUE}"$'\nReply with exactly: WROTE'
  local prompt3
  prompt3="Use the exec tool to run this command: hostname. Reply with the exact stdout only (trim trailing newline)."
  local prompt3b
  prompt3b=$'Use the write tool to write exactly this string into '"${HOSTNAME_TXT}"$':\n'"${EXPECTED_HOSTNAME}"$'\nReply with exactly: WROTE'
  local prompt4
  prompt4="Use the image tool on ${IMAGE_PNG}. Determine which color is on the left half and which is on the right half. Then use the write tool to write exactly: LEFT=RED RIGHT=GREEN into ${IMAGE_TXT}. Reply with exactly: LEFT=RED RIGHT=GREEN"
  TURN2_SESSION_ID="${SESSION_ID_PREFIX}-write-copy"
  TURN3_SESSION_ID="${SESSION_ID_PREFIX}-exec-hostname"
  TURN3B_SESSION_ID="${SESSION_ID_PREFIX}-write-hostname"
  TURN4_SESSION_ID="${SESSION_ID_PREFIX}-image-write"
  if [[ "$AGENT_TURNS_PARALLEL" == "1" ]]; then
    local turn_pids=()
    run_agent_turn_bg "read proof" "$profile" "$TURN1_SESSION_ID" "$prompt1" "$TURN1_JSON"
    turn_pids+=("$RUN_AGENT_TURN_BG_PID")
    run_agent_turn_bg "write proof copy" "$profile" "$TURN2_SESSION_ID" "$prompt2" "$TURN2_JSON"
    turn_pids+=("$RUN_AGENT_TURN_BG_PID")
    run_agent_turn_bg "exec hostname" "$profile" "$TURN3_SESSION_ID" "$prompt3" "$TURN3_JSON"
    turn_pids+=("$RUN_AGENT_TURN_BG_PID")
    run_agent_turn_bg "write hostname" "$profile" "$TURN3B_SESSION_ID" "$prompt3b" "$TURN3B_JSON"
    turn_pids+=("$RUN_AGENT_TURN_BG_PID")
    run_agent_turn_bg "image write" "$profile" "$TURN4_SESSION_ID" "$prompt4" "$TURN4_JSON"
    turn_pids+=("$RUN_AGENT_TURN_BG_PID")
    wait_agent_turn_batch "${turn_pids[@]}"
  else
    run_agent_turn_logged "read proof" "$profile" "$TURN1_SESSION_ID" "$prompt1" "$TURN1_JSON"
    run_agent_turn_logged "write proof copy" "$profile" "$TURN2_SESSION_ID" "$prompt2" "$TURN2_JSON"
    run_agent_turn_logged "exec hostname" "$profile" "$TURN3_SESSION_ID" "$prompt3" "$TURN3_JSON"
    run_agent_turn_logged "write hostname" "$profile" "$TURN3B_SESSION_ID" "$prompt3b" "$TURN3B_JSON"
    run_agent_turn_logged "image write" "$profile" "$TURN4_SESSION_ID" "$prompt4" "$TURN4_JSON"
  fi

  assert_agent_json_has_text "$TURN1_JSON"
  assert_agent_json_ok "$TURN1_JSON" "$agent_model_provider"
  local reply1
  reply1="$(extract_matching_text "$TURN1_JSON" "$PROOF_VALUE" | tr -d '\r\n')"
  if [[ "$reply1" != "$PROOF_VALUE" ]]; then
    echo "ERROR: agent did not read proof.txt correctly ($profile): $reply1" >&2
    exit 1
  fi

  assert_agent_json_has_text "$TURN2_JSON"
  assert_agent_json_ok "$TURN2_JSON" "$agent_model_provider"
  local copy_value
  copy_value="$(cat "$PROOF_COPY" 2>/dev/null | tr -d '\r\n' || true)"
  if [[ "$copy_value" != "$PROOF_VALUE" ]]; then
    echo "ERROR: copy.txt did not match proof.txt ($profile)" >&2
    exit 1
  fi
  TURN2B_SESSION_ID="${SESSION_ID_PREFIX}-read-copy"
  run_agent_turn_logged "read proof copy" "$profile" "$TURN2B_SESSION_ID" \
    "Use the read tool (not exec) to read ${PROOF_COPY}. Reply with the exact contents only (no extra whitespace)." \
    "$TURN2B_JSON"
  assert_agent_json_has_text "$TURN2B_JSON"
  assert_agent_json_ok "$TURN2B_JSON" "$agent_model_provider"
  local reply2
  reply2="$(extract_matching_text "$TURN2B_JSON" "$PROOF_VALUE" | tr -d '\r\n')"
  if [[ "$reply2" != "$PROOF_VALUE" ]]; then
    echo "ERROR: agent did not read copy.txt correctly ($profile): $reply2" >&2
    exit 1
  fi

  assert_agent_json_has_text "$TURN3_JSON"
  assert_agent_json_ok "$TURN3_JSON" "$agent_model_provider"
  local reply3
  reply3="$(extract_matching_text "$TURN3_JSON" "$EXPECTED_HOSTNAME" | tr -d '\r\n')"
  if [[ "$reply3" != "$EXPECTED_HOSTNAME" ]]; then
    echo "ERROR: agent did not run hostname correctly ($profile): $reply3" >&2
    exit 1
  fi
  assert_agent_json_has_text "$TURN3B_JSON"
  assert_agent_json_ok "$TURN3B_JSON" "$agent_model_provider"
  if [[ "$(cat "$HOSTNAME_TXT" 2>/dev/null | tr -d '\r\n' || true)" != "$EXPECTED_HOSTNAME" ]]; then
    echo "ERROR: hostname.txt did not match hostname output ($profile)" >&2
    exit 1
  fi

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
  phase_mark_passed "Agent turns ($profile)"

  phase_mark_start "Verify tool usage via session transcript ($profile)"
  # Give the gateway a moment to flush transcripts.
  sleep 1
  assert_session_used_tools "$(session_jsonl_path "$profile" "$TURN1_SESSION_ID")" read
  assert_session_used_tools "$(session_jsonl_path "$profile" "$TURN2_SESSION_ID")" write
  assert_session_used_tools "$(session_jsonl_path "$profile" "$TURN2B_SESSION_ID")" read
  assert_session_used_tools "$(session_jsonl_path "$profile" "$TURN3_SESSION_ID")" exec
  assert_session_used_tools "$(session_jsonl_path "$profile" "$TURN3B_SESSION_ID")" write
  assert_session_used_tools "$(session_jsonl_path "$profile" "$TURN4_SESSION_ID")" image write
  phase_mark_passed "Verify tool usage via session transcript ($profile)"

  cleanup_profile
  trap - EXIT
}

if [[ "$MODELS_MODE" == "openai" || "$MODELS_MODE" == "both" ]]; then
  run_profile "e2e-openai" "18789" "/tmp/openclaw-e2e-openai" "openai"
fi

if [[ "$MODELS_MODE" == "anthropic" || "$MODELS_MODE" == "both" ]]; then
  run_profile "e2e-anthropic" "18799" "/tmp/openclaw-e2e-anthropic" "anthropic"
fi

echo "OK"
