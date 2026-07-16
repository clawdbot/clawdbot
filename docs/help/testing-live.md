---
summary: "Live (network-touching) tests: model matrix, CLI backends, ACP, media providers, credentials"
read_when:
  - Running live model matrix / CLI backend / ACP / media-provider smokes
  - Debugging live-test credential resolution
  - Adding a new provider-specific live test
title: "Testing: live suites"
sidebarTitle: "Live tests"
---

For quick start, QA runners, unit/integration suites, and Docker flows, see
[Testing](/help/testing). This page covers **live** (network-touching) tests:
model matrix, CLI backends, ACP, media providers, and credential handling.

## Live: local smoke commands

Export the needed provider key in the process environment before ad hoc live
checks.

Safe media smoke:

```bash
pnpm openclaw infer tts convert --local --json \
  --text "OpenClaw live smoke." \
  --output /tmp/openclaw-live-smoke.mp3
```

Safe voice-call readiness smoke:

```bash
pnpm openclaw voicecall setup --json
pnpm openclaw voicecall smoke --to "+15555550123"
```

`voicecall smoke` is a dry run unless `--yes` is also present; use `--yes` only
when you intend to place a real call. For Twilio, Telnyx, and Plivo, a
successful readiness check requires a public webhook URL - local/private
loopback URLs are rejected because those providers cannot reach them.

## Live: Android node capability sweep

- Test: `src/gateway/android-node.capabilities.live.test.ts`
- Script: `pnpm android:test:integration`
- Goal: invoke **every command currently advertised** by a connected Android node and assert command contract behavior.
- Scope:
  - Preconditioned/manual setup (the suite does not install/run/pair the app).
  - Command-by-command gateway `node.invoke` validation for the selected Android node.
- Required pre-setup:
  - Android app already connected + paired to the gateway.
  - App kept in foreground.
  - Permissions/capture consent granted for capabilities you expect to pass.
- Optional target overrides:
  - `OPENCLAW_ANDROID_NODE_ID` or `OPENCLAW_ANDROID_NODE_NAME`.
  - `OPENCLAW_ANDROID_GATEWAY_URL` / `OPENCLAW_ANDROID_GATEWAY_TOKEN` / `OPENCLAW_ANDROID_GATEWAY_PASSWORD`.
- Full Android setup details: [Android App](/platforms/android)

## Live: model smoke (profile keys)

Live model tests are split into two layers so failures are isolated:

- "Direct model" tells you whether the provider/model can answer at all with the given key.
- "Gateway smoke" tells you whether the full gateway+agent pipeline works for that model (sessions, history, tools, sandbox policy, etc.).

The curated model lists below live in `src/agents/live-model-filter.ts` and
change over time; treat the arrays there as the source of truth, not this
page.

MiniMax M3 uses `minimax/MiniMax-M3` as its default provider/model reference.

### Layer 1: Direct model completion (no gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Goal:
  - Enumerate discovered models
  - Use `getApiKeyForModel` to select models you have creds for
  - Run a small completion per model (and targeted regressions where needed)
- How to enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
  - Set `OPENCLAW_LIVE_MODELS=modern`, `small`, or `all` (alias for `modern`) to actually run this suite; otherwise it skips, so `pnpm test:live` on its own stays focused on gateway smoke.
- How to select models:
  - `OPENCLAW_LIVE_MODELS=modern` runs the curated high-signal priority list (see [Live: model matrix](#live-model-matrix-what-we-cover))
  - `OPENCLAW_LIVE_MODELS=small` runs the curated small-model priority list
  - `OPENCLAW_LIVE_MODELS=all` is an alias for `modern`
  - or `OPENCLAW_LIVE_MODELS="openai/gpt-5.6-luna,anthropic/claude-opus-4-6,..."` (comma allowlist)
  - Local Ollama small-model runs default to `http://127.0.0.1:11434`; set `OPENCLAW_LIVE_OLLAMA_BASE_URL` only for LAN, custom, or Ollama Cloud endpoints.
  - Modern/all and small sweeps default to their curated-list length as a cap; set `OPENCLAW_LIVE_MAX_MODELS=0` for an exhaustive selected-profile sweep or a positive number for a smaller cap.
  - Exhaustive sweeps use `OPENCLAW_LIVE_TEST_TIMEOUT_MS` for the whole direct-model test timeout. Default: 60 minutes.
  - Direct-model probes run with 20-way parallelism by default; set `OPENCLAW_LIVE_MODEL_CONCURRENCY` to override.
- How to select providers:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (comma allowlist)
- Where keys come from:
  - By default: profile store and env fallbacks
  - Set `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to enforce **profile store** only
- Why this exists:
  - Separates "provider API is broken / key is invalid" from "gateway agent pipeline is broken"
  - Contains small, isolated regressions (example: OpenAI Responses/Codex Responses reasoning replay + tool-call flows)

### Layer 2: Gateway + dev agent smoke (what "@openclaw" actually does)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Goal:
  - Spin up an in-process gateway
  - Create/patch an `agent:dev:*` session (model override per run)
  - Iterate models-with-keys and assert:
    - "meaningful" response (no tools)
    - a real tool invocation works (read probe)
    - optional extra tool probes (exec+read probe)
    - OpenAI regression paths (tool-call-only -> follow-up) keep working
- Probe details (so you can explain failures quickly):
  - `read` probe: the test writes a nonce file in the workspace and asks the agent to `read` it and echo the nonce back.
  - `exec+read` probe: the test asks the agent to `exec`-write a nonce into a temp file, then `read` it back.
  - image probe: the test attaches a generated PNG (cat + randomized code) and expects the model to return `cat <CODE>`.
  - Implementation reference: `src/gateway/gateway-models.profiles.live.test.ts` and `test/helpers/live-image-probe.ts`.
- How to enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
- How to select models:
  - Default: the curated high-signal (`modern`) priority list
  - `OPENCLAW_LIVE_GATEWAY_MODELS=small` runs the curated small-model list through the full gateway+agent pipeline
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` is an alias for `modern`
  - Or set `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (or comma list) to narrow
  - Modern/all and small gateway sweeps default to their curated-list length as a cap; set `OPENCLAW_LIVE_GATEWAY_MAX_MODELS=0` for an exhaustive selected sweep or a positive number for a smaller cap.
- How to select providers (avoid "OpenRouter everything"):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (comma allowlist)
- Tool + image probes are always on in this live test:
  - `read` probe + `exec+read` probe (tool stress)
  - image probe runs when the model advertises image input support
  - Flow (high level):
    - Test generates a tiny PNG with "CAT" + random code (`test/helpers/live-image-probe.ts`)
    - Sends it via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway parses attachments into `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Embedded agent forwards a multimodal user message to the model
    - Assertion: reply contains `cat` + the code (OCR tolerance: minor mistakes allowed)

<Tip>
To see what you can test on your machine (and the exact `provider/model` ids), run:

```bash
openclaw models list
openclaw models list --json
```

</Tip>

## Live: CLI backend smoke (Claude, Gemini, or other local CLIs)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Goal: validate the Gateway + agent pipeline using a local CLI backend, without touching your default config.
- Backend-specific smoke defaults live with the owning plugin's `cli-backend.ts` definition.
- Enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Defaults:
  - Default provider/model: `claude-cli/claude-sonnet-4-6`
  - Command/args/image behavior come from the owning CLI backend plugin metadata.
- Overrides (optional):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` to send a real image attachment (paths are injected into the prompt). Off by default in Docker recipes.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` to pass image file paths as CLI args instead of prompt injection.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (or `"list"`) to control how image args are passed when `IMAGE_ARG` is set.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` to send a second turn and validate resume flow.
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE=1` to opt into the Claude Sonnet -> Opus same-session continuity probe when the selected model supports a switch target. Off by default, including in Docker recipes.
  - `OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE=1` to opt into the MCP/tool loopback probe. Off by default in Docker recipes.

Example:

```bash
  OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-6" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

Cheap Gemini MCP config smoke:

```bash
OPENCLAW_LIVE_TEST=1 \
  pnpm test:live src/agents/cli-runner/bundle-mcp.gemini.live.test.ts
```

This does not ask Gemini to generate a response. It writes the same system
settings OpenClaw gives Gemini, then runs `gemini --debug mcp list` to prove a
saved `transport: "streamable-http"` server is normalized to Gemini's HTTP MCP
shape and can connect to a local streamable-HTTP MCP server.

Docker recipe:

```bash
pnpm test:docker:live-cli-backend
```

Single-provider Docker recipes:

```bash
pnpm test:docker:live-cli-backend:claude
pnpm test:docker:live-cli-backend:claude-subscription
pnpm test:docker:live-cli-backend:gemini
```

Notes:

- The Docker runner lives at `scripts/test-live-cli-backend-docker.sh`.
- It runs the live CLI-backend smoke inside the repo Docker image as the non-root `node` user.
- It resolves CLI smoke metadata from the owning plugin, then installs the matching Linux CLI package (`@anthropic-ai/claude-code` or `@google/gemini-cli`) into a cached writable prefix at `OPENCLAW_DOCKER_CLI_TOOLS_DIR` (default: `~/.cache/openclaw/docker-cli-tools`).
- `codex-cli` is no longer a bundled CLI backend; use `openai/*` with the Codex app-server runtime instead (see [Live: Codex app-server harness smoke](#live-codex-app-server-harness-smoke)).
- `pnpm test:docker:live-cli-backend:claude-subscription` requires portable Claude Code subscription OAuth through either `~/.claude/.credentials.json` with `claudeAiOauth.subscriptionType` or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. It first proves direct `claude -p` in Docker, then runs two Gateway CLI-backend turns without preserving Anthropic API-key env vars. This subscription lane disables the Claude MCP/tool and image probes by default because it consumes the signed-in subscription's usage limits and Anthropic can change Claude Agent SDK / `claude -p` billing and rate-limit behavior without an OpenClaw release.
- Claude and Gemini support the same probe set (text turn, image classification, MCP `cron` tool call, model-switch continuity) through the flags above, but none of those probes run by default - opt in per flag as needed.

## Live: APNs HTTP/2 proxy reachability

- Test: `src/infra/push-apns-http2.live.test.ts`
- Goal: tunnel through a local HTTP CONNECT proxy to Apple's sandbox APNs endpoint, send the APNs HTTP/2 validation request, and assert Apple's real `403 InvalidProviderToken` response comes back through the proxy path.
- Enable:
  - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_APNS_REACHABILITY=1 pnpm test:live src/infra/push-apns-http2.live.test.ts`
- Optional timeout:
  - `OPENCLAW_LIVE_APNS_TIMEOUT_MS=30000`

## Live: ACP bind smoke (`/acp spawn ... --bind here`)

- Test: `src/gateway/gateway-acp-bind.live.test.ts`
- Goal: validate the real ACP conversation-bind flow with a live ACP agent:
  - send `/acp spawn <agent> --bind here`
  - bind a synthetic message-channel conversation in place
  - send a normal follow-up on that same conversation
  - verify the follow-up lands in the bound ACP session transcript
- Enable:
  - `pnpm test:live src/gateway/gateway-acp-bind.live.test.ts`
  - `OPENCLAW_LIVE_ACP_BIND=1`
- Defaults:
  - ACP agents in Docker: `claude,codex,gemini`
  - ACP agent for direct `pnpm test:live ...`: `claude`
  - Synthetic channel: Slack DM-style conversation context
  - ACP backend: `acpx`
- Overrides:
  - `OPENCLAW_LIVE_ACP_BIND_AGENT=claude`
  - `OPENCLAW_LIVE_ACP_BIND_AGENT=codex`
  - `OPENCLAW_LIVE_ACP_BIND_AGENT=droid`
  - `OPENCLAW_LIVE_ACP_BIND_AGENT=gemini`
  - `OPENCLAW_LIVE_ACP_BIND_AGENT=opencode`
  - `OPENCLAW_LIVE_ACP_BIND_AGENTS=claude,codex,gemini`
  - `OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND='npx -y @agentclientprotocol/claude-agent-acp@<version>'`
  - `OPENCLAW_LIVE_ACP_BIND_CODEX_MODEL=gpt-5.6-luna`
  - `OPENCLAW_LIVE_ACP_BIND_OPENCODE_MODEL=opencode/kimi-k2.6`
  - `OPENCLAW_LIVE_ACP_BIND_IMAGE_PROBE=1` (or `on`/`true`/`yes`) to force the image probe on; any other value forces it off. Runs by default for every agent except `opencode`.
  - `OPENCLAW_LIVE_ACP_BIND_REQUIRE_CRON=1`
  - `OPENCLAW_LIVE_ACP_BIND_PARENT_MODEL=openai/gpt-5.6-luna`
- Notes:
  - This lane uses the gateway `chat.send` surface with admin-only synthetic originating-route fields so tests can attach message-channel context without pretending to deliver externally.
  - When `OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND` is unset, the test uses the embedded `acpx` plugin's built-in agent registry for the selected ACP harness agent.
  - Bound-session cron MCP creation is best-effort by default because external ACP harnesses can cancel MCP calls after the bind/image proof has passed; set `OPENCLAW_LIVE_ACP_BIND_REQUIRE_CRON=1` to make that post-bind cron probe strict.

Example:

```bash
OPENCLAW_LIVE_ACP_BIND=1 \
  OPENCLAW_LIVE_ACP_BIND_AGENT=claude \
  pnpm test:live src/gateway/gateway-acp-bind.live.test.ts
```

Docker recipe:

```bash
pnpm test:docker:live-acp-bind
```

Single-agent Docker recipes:

```bash
pnpm test:docker:live-acp-bind:claude
pnpm test:docker:live-acp-bind:codex
pnpm test:docker:live-acp-bind:droid
pnpm test:docker:live-acp-bind:gemini
pnpm test:docker:live-acp-bind:opencode
```

Docker notes:

- The Docker runner lives at `scripts/test-live-acp-bind-docker.sh`.
- By default, it runs the ACP bind smoke against the aggregate live CLI agents in sequence: `claude`, `codex`, then `gemini`.
- Use `OPENCLAW_LIVE_ACP_BIND_AGENTS=claude`, `OPENCLAW_LIVE_ACP_BIND_AGENTS=codex`, `OPENCLAW_LIVE_ACP_BIND_AGENTS=droid`, `OPENCLAW_LIVE_ACP_BIND_AGENTS=gemini`, or `OPENCLAW_LIVE_ACP_BIND_AGENTS=opencode` to narrow the matrix.
- It stages the matching CLI auth material into the container, then installs the requested live CLI (`@anthropic-ai/claude-code`, `@openai/codex`, Factory Droid via `https://app.factory.ai/cli`, `@google/gemini-cli`, or `opencode-ai`) if missing. The ACP backend itself is the embedded `acpx/runtime` package from the official `acpx` plugin.
- The Droid Docker variant stages `~/.factory` for settings, forwards `FACTORY_API_KEY`, and requires that API key because local Factory OAuth/keyring auth is not portable into the container. It uses ACPX's built-in `droid exec --output-format acp` registry entry.
- The OpenCode Docker variant is a strict single-agent regression lane. It writes a temporary `OPENCODE_CONFIG_CONTENT` default model from `OPENCLAW_LIVE_ACP_BIND_OPENCODE_MODEL` (default `opencode/kimi-k2.6`).
- Direct `acpx` CLI calls are only a manual/workaround path for comparing behavior outside the Gateway. The Docker ACP bind smoke exercises OpenClaw's embedded `acpx` runtime backend.

## Live: Codex app-server harness smoke

- Goal: validate the plugin-owned Codex harness through the normal gateway
  `agent` method:
  - load the bundled `codex` plugin
  - select an OpenAI model through `/model <ref> --runtime codex`
  - send a first gateway agent turn with the requested thinking level
  - send a second turn to the same OpenClaw session and verify the app-server
    thread can resume
  - run `/codex status` and `/codex models` through the same gateway command
    path
  - optionally run two Guardian-reviewed escalated shell probes: one benign
    command that should be approved and one fake-secret upload that should be
    denied so the agent asks back
- Test: `src/gateway/gateway-codex-harness.live.test.ts`
- Enable: `OPENCLAW_LIVE_CODEX_HARNESS=1`
- Harness baseline model: `openai/gpt-5.6-luna`
- Fresh OpenAI API-key selection default: `openai/gpt-5.6`
- Default thinking: `low`
- Model override: `OPENCLAW_LIVE_CODEX_HARNESS_MODEL=openai/<model>`
- Thinking override: `OPENCLAW_LIVE_CODEX_HARNESS_THINKING=<level>`
- Matrix override: `OPENCLAW_LIVE_CODEX_HARNESS_TARGETS=<model>=<thinking>,...`
- Auth mode: `OPENCLAW_LIVE_CODEX_HARNESS_AUTH=codex-auth` (default) uses the
  copied Codex login; `api-key` uses `OPENAI_API_KEY` through Codex app-server.
- Optional image probe: `OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=1`
- Optional MCP/tool probe: `OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=1`
- Optional Guardian probe: `OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=1`
- Optional loop-relay opt-out probe:
  `OPENCLAW_LIVE_CODEX_HARNESS_DISABLE_LOOP_RELAY=1`
- The smoke forces provider/model `agentRuntime.id: "codex"` so a broken Codex
  harness cannot pass by silently falling back to OpenClaw.
- Auth: Codex app-server auth from the local Codex subscription login, or
  `OPENAI_API_KEY` when `OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key`. Docker can
  copy `~/.codex/auth.json` and `~/.codex/config.toml` for subscription runs.

Local recipe:

```bash
OPENCLAW_LIVE_CODEX_HARNESS=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_MODEL=openai/gpt-5.6-luna \
  pnpm test:live -- src/gateway/gateway-codex-harness.live.test.ts
```

Docker recipe:

```bash
pnpm test:docker:live-codex-harness
```

GPT-5.6 native Codex matrix:

```bash
OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key \
  OPENCLAW_LIVE_CODEX_HARNESS_TARGETS='openai/gpt-5.6-sol=ultra,openai/gpt-5.6-terra=ultra,openai/gpt-5.6-luna=max' \
  pnpm test:docker:live-codex-harness
```

Fresh OpenAI API-key default:

```bash
OPENCLAW_LIVE_GATEWAY_OPENAI_API_DEFAULT=1 \
  OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai \
  OPENCLAW_LIVE_GATEWAY_THINKING=off \
  pnpm test:live -- src/gateway/gateway-models.profiles.live.test.ts
```

This proof leaves `OPENCLAW_LIVE_GATEWAY_MODELS` unset, resolves the model through
the fresh onboarding inference-selection seam, asserts `openai/gpt-5.6`, and then
runs a real gateway turn with that resolved model.

GPT-5.6 embedded OpenClaw matrix:

```bash
OPENCLAW_LIVE_GATEWAY_THINKING=ultra \
  OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai \
  OPENCLAW_LIVE_GATEWAY_MODELS='openai/gpt-5.6-sol,openai/gpt-5.6-terra,openai/gpt-5.6-luna' \
  pnpm test:live -- src/gateway/gateway-models.profiles.live.test.ts
```

Docker notes:

- The Docker runner lives at `scripts/test-live-codex-harness-docker.sh`.
- It passes `OPENAI_API_KEY`, copies Codex CLI auth files when present, installs
  `@openai/codex` into a writable mounted npm
  prefix, stages the source tree, then runs only the Codex-harness live test.
- Docker enables the image, MCP/tool, and Guardian probes by default. Set
  `OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=0` or
  `OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=0` or
  `OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=0` when you need a narrower debug
  run.
- Docker uses the same explicit Codex runtime config, so legacy aliases or OpenClaw
  fallback cannot hide a Codex harness regression.
- Matrix targets run sequentially in one container. The Docker script scales its
  default 35-minute timeout by target count; any outer shell or CI timeout must
  allow the same total. Canonical CI keeps each GPT-5.6 target in a separate shard.

### Recommended live recipes

Narrow, explicit allowlists are fastest and least flaky:

- Single model, direct (no gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.6-luna" pnpm test:live src/agents/models.profiles.live.test.ts`

- Small-model direct profile:
  - `OPENCLAW_LIVE_MODELS=small pnpm test:live src/agents/models.profiles.live.test.ts`

- Small-model gateway profile:
  - `OPENCLAW_LIVE_GATEWAY_MODELS=small pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Ollama Cloud API smoke:
  - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_OLLAMA=1 OPENCLAW_LIVE_OLLAMA_BASE_URL=https://ollama.com OPENCLAW_LIVE_OLLAMA_MODEL=glm-5.1:cloud OPENCLAW_LIVE_OLLAMA_WEB_SEARCH=0 pnpm test:live -- extensions/ollama/ollama.live.test.ts`

- Single model, gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.6-luna" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool calling across several providers:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.6-luna,anthropic/claude-opus-4-6,google/gemini-3.5-flash,deepseek/deepseek-v4-flash,zai/glm-5.1,minimax/MiniMax-M3" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Z.AI Coding Plan GLM-5.2 direct smoke:
  - `ZAI_CODING_LIVE_TEST=1 pnpm test:live src/agents/zai.live.test.ts`

- Google focus (Gemini API key + Antigravity):
  - Gemini (API key): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3.5-flash" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google adaptive thinking smoke (`qa manual` from the private QA CLI - requires `OPENCLAW_ENABLE_PRIVATE_QA_CLI=1` and a source checkout; see [QA overview](/concepts/qa-e2e-automation)):
  - Gemini 3 dynamic default: `OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 pnpm openclaw qa manual --provider-mode live-frontier --model google/gemini-3.1-pro-preview --alt-model google/gemini-3.1-pro-preview --message '/think adaptive Reply exactly: GEMINI_ADAPTIVE_OK' --timeout-ms 180000`
  - Gemini 2.5 dynamic budget: `OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 pnpm openclaw qa manual --provider-mode live-frontier --model google/gemini-2.5-flash --alt-model google/gemini-2.5-flash --message '/think adaptive Reply exactly: GEMINI25_ADAPTIVE_OK' --timeout-ms 180000`

Notes:

- `google/...` uses the Gemini API (API key).
- `google-antigravity/...` uses the Antigravity OAuth bridge (Cloud Code Assist-style agent endpoint).
- `google-gemini-cli/...` uses the local Gemini CLI on your machine (separate auth + tooling quirks).
- Gemini API vs Gemini CLI:
  - API: OpenClaw calls Google's hosted Gemini API over HTTP (API key / profile auth); this is what most users mean by "Gemini".
  - CLI: OpenClaw shells out to a local `gemini` binary; it has its own auth and can behave differently (streaming/tool support/version skew).

## Live: model matrix (what we cover)

Live is opt-in, so there is no fixed "CI model list." `OPENCLAW_LIVE_MODELS=modern` / `OPENCLAW_LIVE_GATEWAY_MODELS=modern` (and their `all` alias) run the curated priority list from `HIGH_SIGNAL_LIVE_MODEL_PRIORITY` in `src/agents/live-model-filter.ts`, in this priority order:

| Provider/model                                | Notes      |
| --------------------------------------------- | ---------- |
| `anthropic/claude-opus-4-8`                   |            |
| `anthropic/claude-sonnet-5`                   |            |
| `anthropic/claude-sonnet-4-6`                 |            |
| `anthropic/claude-opus-4-7`                   |            |
| `google/gemini-3.1-pro-preview`               | Gemini API |
| `google/gemini-3.5-flash`                     | Gemini API |
| `cohere/command-a-plus-05-2026`               |            |
| `moonshot/kimi-k2.7-code`                     |            |
| `anthropic/claude-opus-4-6`                   |            |
| `deepseek/deepseek-v4-flash`                  |            |
| `deepseek/deepseek-v4-pro`                    |            |
| `minimax/MiniMax-M3`                          |            |
| `openai/gpt-5.5`                              |            |
| `openrouter/openai/gpt-5.2-chat`              |            |
| `openrouter/minimax/minimax-m2.7`             |            |
| `opencode-go/glm-5`                           |            |
| `openrouter/ai21/jamba-large-1.7`             |            |
| `xai/grok-4.5`                                |            |
| `xai/grok-4.20-0309-reasoning`                |            |
| `zai/glm-5.1`                                 |            |
| `fireworks/accounts/fireworks/models/glm-5p1` |            |
| `minimax-portal/minimax-m3`                   |            |

The curated **small-model** list (`OPENCLAW_LIVE_MODELS=small` / `OPENCLAW_LIVE_GATEWAY_MODELS=small`), from `SMALL_LIVE_MODEL_PRIORITY`:

| Provider/model               |
| ---------------------------- |
| `lmstudio/qwen/qwen3.5-9b`   |
| `vllm/qwen/qwen3-8b`         |
| `sglang/qwen/qwen3-8b`       |
| `ollama/gemma3:4b`           |
| `openrouter/qwen/qwen3.5-9b` |
| `openrouter/z-ai/glm-5.1`    |
| `openrouter/z-ai/glm-5`      |
| `zai/glm-5.1`                |

Notes on the modern list:

- `codex` and `codex-cli` providers are excluded from the default modern sweep (they cover CLI-backend/ACP behavior, tested separately above). `openai/gpt-5.5` itself routes through the Codex app-server harness by default; see [Live: Codex app-server harness smoke](#live-codex-app-server-harness-smoke).
- `fireworks`, `google`, `openrouter`, and `xai` only run their explicitly curated model ids in the modern sweep (no automatic "every model from this provider" expansion).
- Include at least one image-capable model (Claude/Gemini/OpenAI-family vision variants, etc.) in `OPENCLAW_LIVE_GATEWAY_MODELS` to exercise the image probe.

Run gateway smoke with tools + image across a hand-picked cross-provider set:

```bash
OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.6-luna,anthropic/claude-opus-4-6,google/gemini-3.1-pro-preview,google/gemini-3.5-flash,google-antigravity/claude-opus-4-6-thinking,deepseek/deepseek-v4-flash,zai/glm-5.1,minimax/MiniMax-M3" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts
```

Optional additional coverage outside the curated lists (nice to have, pick a "tools"-capable model you have enabled):

- Mistral: `mistral/...`
- Cerebras: `cerebras/...` (if you have access)
- LM Studio: `lmstudio/...` (local; tool calling depends on API mode)

### Aggregators / alternate gateways

If you have keys enabled, you can also test via:

- OpenRouter: `openrouter/...` (hundreds of models; use `openclaw models scan` to find tool+image capable candidates)
- OpenCode: `opencode/...` for Zen and `opencode-go/...` for Go (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

More providers you can include in the live matrix (if you have creds/config):

- Built-in: `anthropic`, `cerebras`, `github-copilot`, `google`, `google-antigravity`, `google-gemini-cli`, `google-vertex`, `groq`, `mistral`, `openai`, `openrouter`, `opencode`, `opencode-go`, `xai`, `zai`
- Via `models.providers` (custom endpoints): `minimax` (cloud/API), plus any OpenAI/Anthropic-compatible proxy (LM Studio, vLLM, LiteLLM, etc.)

<Tip>
Do not hardcode "all models" in docs. The authoritative list is whatever `discoverModels(...)` returns on your machine plus whatever keys are available.
</Tip>

## Credentials (never commit)

Live tests discover credentials the same way the CLI does. Practical implications:

- If the CLI works, live tests should find the same keys.
- If a live test says "no creds", debug the same way you'd debug `openclaw models list` / model selection.

- Per-agent auth profiles: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (this is what "profile keys" means in the live tests)
- Config: `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`)
- Legacy OAuth dir: `~/.openclaw/credentials/` (copied into the staged live home when present, but not the main profile-key store)
- Local live runs copy the active config (with `agents.*.workspace` / `agentDir` overrides stripped) and each agent's `auth-profiles.json` - not the rest of that agent's directory, so `workspace/` and `sandboxes/` data never reaches the staged home - plus the legacy `credentials/` dir and supported external CLI auth files/dirs (`.claude.json`, `.claude/.credentials.json`, `.claude/settings*.json`, `.claude/backups`, `.codex/auth.json`, `.codex/config.toml`, `.gemini`, `.minimax`) into a temp test home.

If you want to rely on env keys, export them before local tests or use the
Docker runners below with an explicit `OPENCLAW_PROFILE_FILE`.

## Deepgram live (audio transcription)

- Test: `extensions/deepgram/audio.live.test.ts`
- Enable: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live extensions/deepgram/audio.live.test.ts`

## BytePlus coding plan live

- Test: `extensions/byteplus/live.test.ts`
- Enable: `BYTEPLUS_API_KEY=... BYTEPLUS_LIVE_TEST=1 pnpm test:live extensions/byteplus/live.test.ts`
- Optional model override: `BYTEPLUS_CODING_MODEL=ark-code-latest`

## ComfyUI workflow media live

- Test: `extensions/comfy/comfy.live.test.ts`
- Enable: `OPENCLAW_LIVE_TEST=1 COMFY_LIVE_TEST=1 pnpm test:live -- extensions/comfy/comfy.live.test.ts`
- Scope:
  - Exercises the bundled comfy image, video, and `music_generate` paths
  - Skips each capability unless `plugins.entries.comfy.config.<capability>` is configured
  - Useful after changing comfy workflow submission, polling, downloads, or plugin registration

## Image generation live

- Test: `test/image-generation.runtime.live.test.ts`
- Command: `pnpm test:live test/image-generation.runtime.live.test.ts`
- Harness: `pnpm test:live:media image`
- Scope:
  - Enumerates every registered image-generation provider plugin
  - Uses already-exported provider env vars before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in `auth-profiles.json` do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs each configured provider through the shared image-generation runtime:
    - `<provider>:generate`
    - `<provider>:edit` when the provider declares edit support
- Current bundled providers covered:
  - `deepinfra`
  - `fal`
  - `google`
  - `minimax`
  - `openai`
  - `openrouter`
  - `vydra`
  - `xai`
- Optional narrowing:
  - `OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS="openai,google,openrouter,xai"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS="deepinfra"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_MODELS="openai/gpt-image-2,google/gemini-3.1-flash-image-preview,openrouter/google/gemini-3.1-flash-image-preview,xai/grok-imagine-image"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_CASES="google:flash-generate,google:pro-edit,openrouter:generate,xai:default-generate,xai:default-edit"`
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

For the shipped CLI path, add an `infer` smoke after the provider/runtime live
test passes:

```bash
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_INFER_CLI_TEST=1 pnpm test:live -- test/image-generation.infer-cli.live.test.ts
openclaw infer image providers --json
openclaw infer image generate \
  --model google/gemini-3.1-flash-image-preview \
  --prompt "Minimal flat test image: one blue square on a white background, no text." \
  --output ./openclaw-infer-image-smoke.png \
  --json
```

This covers CLI argument parsing, config/default-agent resolution, bundled
plugin activation, the shared image-generation runtime, and the live provider
request. Plugin dependencies are expected to be present before runtime load.

## Music generation live

- Test: `extensions/music-generation-providers.live.test.ts`
- Enable: `OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/music-generation-providers.live.test.ts`
- Harness: `pnpm test:live:media music`
- Scope:
  - Exercises the shared bundled music-generation provider path
  - Currently covers `fal`, `google`, `minimax`, and `openrouter`
  - Uses already-exported provider env vars before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in `auth-profiles.json` do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs both declared runtime modes when available:
    - `generate` with prompt-only input
    - `edit` when the provider declares `capabilities.edit.enabled`
  - `comfy` has its own separate live file, not this shared sweep
- Optional narrowing:
  - `OPENCLAW_LIVE_MUSIC_GENERATION_PROVIDERS="google,minimax"`
  - `OPENCLAW_LIVE_MUSIC_GENERATION_MODELS="google/lyria-3-clip-preview,minimax/music-2.6"`
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

## Video generation live

- Test: `extensions/video-generation-providers.live.test.ts`
- Enable: `OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/video-generation-providers.live.test.ts`
- Harness: `pnpm test:live:media video`
- Scope:
  - Exercises the shared bundled video-generation provider path across `alibaba`, `byteplus`, `deepinfra`, `fal`, `google`, `minimax`, `openai`, `openrouter`, `pixverse`, `qwen`, `runway`, `together`, `vydra`, `xai`
  - Defaults to the release-safe smoke path: one text-to-video request per provider, one-second lobster prompt, and a per-provider operation cap from `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS` (`180000` by default)
  - Skips FAL by default because provider-side queue latency can dominate release time; pass `OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS="fal"` (or clear the skip list) to run it explicitly
  - Uses already-exported provider env vars before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in `auth-profiles.json` do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs only `generate` by default
  - Set `OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1` to also run declared transform modes when available:
    - `imageToVideo` when the provider declares `capabilities.imageToVideo.enabled` and the selected provider/model accepts buffer-backed local image input in the shared sweep
    - `videoToVideo` when the provider declares `capabilities.videoToVideo.enabled` and the selected provider/model accepts buffer-backed local video input in the shared sweep
  - Current declared-but-skipped `imageToVideo` provider in the shared sweep:
    - `vydra` (buffer-backed local image input is not supported in this lane)
  - Provider-specific Vydra coverage:
    - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_VYDRA_VIDEO=1 pnpm test:live -- extensions/vydra/vydra.live.test.ts`
    - That file runs `veo3` text-to-video plus a `kling` image-to-video lane that uses a remote image URL fixture by default (`OPENCLAW_LIVE_VYDRA_KLING_IMAGE_URL` to override).
  - Provider-specific xAI coverage:
    - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_XAI_VIDEO=1 pnpm test:live -- extensions/xai/xai.live.test.ts -t "classic Grok Imagine"`
    - The classic case generates a square local PNG first frame, omits geometry, requests a one-second image-to-video clip, polls to completion, and verifies the downloaded buffer.
    - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_XAI_VIDEO=1 pnpm test:live -- extensions/xai/xai.live.test.ts -t "Grok Imagine Video 1.5"`
    - The 1.5 case generates a local PNG first frame, requests a one-second 1080P image-to-video clip, polls to completion, and verifies the downloaded buffer.
  - Current `videoToVideo` live coverage:
    - `runway` only when the selected model resolves to `gen4_aleph`
  - Current declared-but-skipped `videoToVideo` providers in the shared sweep:
    - `alibaba`, `google`, `openai`, `qwen`, `xai` because those paths currently require remote `http(s)` reference URLs rather than buffer-backed local input
- Optional narrowing:
  - `OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS="deepinfra,google,openai,runway"`
  - `OPENCLAW_LIVE_VIDEO_GENERATION_MODELS="google/veo-3.1-fast-generate-preview,openai/sora-2,runway/gen4_aleph"`
  - `OPENCLAW_LIVE_VIDEO_GENERATION_SKIP_PROVIDERS=""` to include every provider in the default sweep, including FAL
  - `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS=60000` to reduce each provider operation cap for an aggressive smoke run
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

## Media live harness

- Command: `pnpm test:live:media`
- Entrypoint: `test/e2e/qa-lab/media/hosted-media-provider-live.ts`, which runs `pnpm test:live -- <suite-test-file>` per selected suite, so heartbeat and quiet-mode behavior stay consistent with other `pnpm test:live` runs.
- Purpose:
  - Runs the shared image, music, and video live suites through one repo-native entrypoint
  - Auto-loads missing provider env vars from `~/.profile`
  - Auto-narrows each suite to providers that currently have usable auth by default
- Flags:
  - `--providers <csv>` global provider filter; `--image-providers` / `--music-providers` / `--video-providers` scope a filter to one suite
  - `--all-providers` skips the auth-based auto-filter
  - `--allow-empty` exits `0` when filtering leaves no runnable providers
  - `--quiet` / `--no-quiet` passed through to `test:live`
- Examples:
  - `pnpm test:live:media`
  - `pnpm test:live:media image video --providers openai,google,minimax`
  - `pnpm test:live:media video --video-providers openai,runway --all-providers`
  - `pnpm test:live:media music --quiet`

## Related

- [Testing](/help/testing) - unit, integration, QA, and Docker suites
