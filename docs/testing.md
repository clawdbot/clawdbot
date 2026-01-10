---
summary: "Testing kit: unit/e2e/live suites, Docker runners, and what each test covers"
read_when:
  - Running tests locally or in CI
  - Adding regressions for model/provider bugs
  - Debugging gateway + agent behavior
---

# Testing

Clawdbot has three Vitest suites (unit/integration, e2e, live) and a small set of Docker runners.

This doc is a “how we test” guide:
- What each suite covers (and what it deliberately does *not* cover)
- Which commands to run for common workflows (local, pre-push, debugging)
- How live tests discover credentials and select models/providers
- How to add regressions for real-world model/provider issues

## Quick start

Most days:
- Full gate (expected before push): `pnpm lint && pnpm build && pnpm test`

When you touch tests or want extra confidence:
- Coverage gate: `pnpm test:coverage`
- E2E suite: `pnpm test:e2e`

When debugging real providers/models (requires real creds; skipped by default):
- Live suite (models only): `CLAWDBOT_LIVE_TEST=1 pnpm test:live`
- Live suite (models + providers): `LIVE=1 pnpm test:live`

Tip: when you only need one failing case, prefer narrowing live tests via the allowlist env vars described below.

## Test suites (what runs where)

Think of the suites as “increasing realism” (and increasing flakiness/cost):

### Unit / integration (default)

- Command: `pnpm test`
- Config: `vitest.config.ts`
- Files: `src/**/*.test.ts`
- Scope:
  - Pure unit tests
  - In-process integration tests (gateway auth, routing, tooling, parsing, config)
  - Deterministic regressions for known bugs
- Expectations:
  - Runs in CI
  - No real keys required
  - Should be fast and stable

### E2E (gateway smoke)

- Command: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- Files: `src/**/*.e2e.test.ts`
- Scope:
  - Multi-instance gateway end-to-end behavior
  - WebSocket/HTTP surfaces, node pairing, and heavier networking
- Expectations:
  - Runs in CI (when enabled in the pipeline)
  - No real keys required
  - More moving parts than unit tests (can be slower)

### Live (real providers + real models)

- Command: `pnpm test:live`
- Config: `vitest.live.config.ts`
- Files: `src/**/*.live.test.ts`
- Default: **skipped** unless `CLAWDBOT_LIVE_TEST=1` or `LIVE=1`
- Scope:
  - “Does this provider/model actually work *today* with real creds?”
  - Catch provider format changes, tool-calling quirks, auth issues, and rate limit behavior
- Expectations:
  - Not CI-stable by design (real networks, real provider policies, quotas, outages)
  - Costs money / uses rate limits
  - Prefer running narrowed subsets instead of “everything”

## Which suite should I run?

Use this decision table:
- Editing logic/tests: run `pnpm test` (and `pnpm test:coverage` if you changed a lot)
- Touching gateway networking / WS protocol / pairing: add `pnpm test:e2e`
- Debugging “my bot is down” / provider-specific failures / tool calling: run a narrowed `pnpm test:live`

## Live: model smoke (profile keys)

Live tests are split into two layers so we can isolate failures:
- “Direct model” tells us the provider/model can answer at all with the given key.
- “Gateway smoke” tells us the full gateway+agent pipeline works for that model (sessions, history, tools, sandbox policy, etc.).

### Layer 1: Direct model completion (no gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Goal:
  - Enumerate discovered models
  - Use `getApiKeyForModel` to select models you have creds for
  - Run a small completion per model (and targeted regressions where needed)
- How to enable:
  - `CLAWDBOT_LIVE_TEST=1` or `LIVE=1`
  - `CLAWDBOT_LIVE_ALL_MODELS=1` (required for this test to run)
- How to select models:
  - `CLAWDBOT_LIVE_MODELS=all` to run everything with keys
  - or `CLAWDBOT_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-5,..."` (comma allowlist)
- How to select providers:
  - `CLAWDBOT_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (comma allowlist)
- Where keys come from:
  - By default: profile store and env fallbacks
  - Set `CLAWDBOT_LIVE_REQUIRE_PROFILE_KEYS=1` to enforce **profile store** only
- Why this exists:
  - Separates “provider API is broken / key is invalid” from “gateway agent pipeline is broken”
  - Contains small, isolated regressions (example: OpenAI Responses/Codex Responses reasoning replay + tool-call flows)

### Layer 2: Gateway + dev agent smoke (what “@clawdbot” actually does)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Goal:
  - Spin up an in-process gateway
  - Create/patch a `agent:dev:*` session (model override per run)
  - Iterate models-with-keys and assert:
    - “meaningful” response (no tools)
    - a real tool invocation works (read probe)
    - optional extra tool probes (bash+read probe)
    - OpenAI regression paths (tool-call-only → follow-up) keep working
- How to enable:
  - `CLAWDBOT_LIVE_TEST=1` or `LIVE=1`
  - `CLAWDBOT_LIVE_GATEWAY=1` (required for this test to run)
- How to select models:
  - `CLAWDBOT_LIVE_GATEWAY_ALL_MODELS=1` to scan all discovered models with keys
  - or set `CLAWDBOT_LIVE_GATEWAY_MODELS="provider/model,provider/model,..."` to narrow quickly
- How to select providers (avoid “OpenRouter everything”):
  - `CLAWDBOT_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (comma allowlist)
- Optional tool-calling stress:
  - `CLAWDBOT_LIVE_GATEWAY_TOOL_PROBE=1` enables an extra “bash writes file → read reads it back → echo nonce” check.
  - This is specifically meant to catch tool-calling compatibility issues across providers (formatting, history replay, tool_result pairing, etc.).
  - Optional image send smoke:
  - `CLAWDBOT_LIVE_GATEWAY_IMAGE_PROBE=1` sends a real image attachment through the gateway agent pipeline (multimodal message) and asserts the model can read back a per-run code from the image.
  - Flow (high level):
    - Test generates a tiny PNG with “CAT” + random code (`src/gateway/live-image-probe.ts`)
    - Sends it via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway parses attachments into `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Embedded agent forwards a multimodal user message to the model
    - Assertion: reply contains `cat` + the code (OCR tolerance: minor mistakes allowed)

## Live: Anthropic setup-token smoke

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Goal: verify Claude CLI setup-token (or a pasted setup-token profile) can complete an Anthropic prompt.
- Enable:
  - `CLAWDBOT_LIVE_TEST=1` or `LIVE=1`
  - `CLAWDBOT_LIVE_SETUP_TOKEN=1`
- Token sources (pick one):
  - Profile: `CLAWDBOT_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Raw token: `CLAWDBOT_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Model override (optional):
  - `CLAWDBOT_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-5`

Setup example:

```bash
clawdbot models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
CLAWDBOT_LIVE_TEST=1 CLAWDBOT_LIVE_SETUP_TOKEN=1 CLAWDBOT_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

### Recommended live recipes

Narrow, explicit allowlists are fastest and least flaky:

- Single model, direct (no gateway):
  - `CLAWDBOT_LIVE_TEST=1 CLAWDBOT_LIVE_ALL_MODELS=1 CLAWDBOT_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Single model, gateway smoke:
  - `LIVE=1 CLAWDBOT_LIVE_GATEWAY=1 CLAWDBOT_LIVE_GATEWAY_ALL_MODELS=1 CLAWDBOT_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool calling across several providers (bash + read probe):
  - `LIVE=1 CLAWDBOT_LIVE_GATEWAY=1 CLAWDBOT_LIVE_GATEWAY_ALL_MODELS=1 CLAWDBOT_LIVE_GATEWAY_TOOL_PROBE=1 CLAWDBOT_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-5,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google focus (Gemini API key + Antigravity):
  - Gemini (API key): `LIVE=1 CLAWDBOT_LIVE_GATEWAY=1 CLAWDBOT_LIVE_GATEWAY_ALL_MODELS=1 CLAWDBOT_LIVE_GATEWAY_TOOL_PROBE=1 CLAWDBOT_LIVE_GATEWAY_IMAGE_PROBE=1 CLAWDBOT_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `LIVE=1 CLAWDBOT_LIVE_GATEWAY=1 CLAWDBOT_LIVE_GATEWAY_ALL_MODELS=1 CLAWDBOT_LIVE_GATEWAY_TOOL_PROBE=1 CLAWDBOT_LIVE_GATEWAY_IMAGE_PROBE=1 CLAWDBOT_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-5-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Notes:
- `google/...` uses the Gemini API (API key).
- `google-antigravity/...` uses the Antigravity OAuth bridge (Cloud Code Assist-style agent endpoint).
- `google-gemini-cli/...` uses the local Gemini CLI on your machine (separate auth + tooling quirks).

## Live: model matrix (what we cover)

There is no fixed “CI model list” (live is opt-in), but these are the **recommended** models to cover regularly on a dev machine with keys.

### Modern smoke set (tool calling + image)

This is the “common models” run we expect to keep working:
- OpenAI (non-Codex): `openai/gpt-5.2` (optional: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.2` (optional: `openai-codex/gpt-5.2-codex`)
- Anthropic: `anthropic/claude-opus-4-5` (or `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` and `google/gemini-3-flash-preview`
- Google (Antigravity): `google-antigravity/claude-opus-4-5-thinking` and `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Run gateway smoke with tools + image:
`LIVE=1 CLAWDBOT_LIVE_GATEWAY=1 CLAWDBOT_LIVE_GATEWAY_TOOL_PROBE=1 CLAWDBOT_LIVE_GATEWAY_IMAGE_PROBE=1 CLAWDBOT_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.2,anthropic/claude-opus-4-5,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-5-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Baseline: tool calling (Read + optional Bash)

Pick at least one per provider family:
- OpenAI: `openai/gpt-5.2` (or `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-5` (or `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (or `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Optional additional coverage (nice to have):
- xAI: `xai/grok-4` (or latest available)
- Mistral: `mistral/`… (pick one “tools” capable model you have enabled)
- Cerebras: `cerebras/`… (if you have access)
- LM Studio: `lmstudio/`… (local; tool calling depends on API mode)

### Vision: image send (attachment → multimodal message)

Run with `CLAWDBOT_LIVE_GATEWAY_IMAGE_PROBE=1` and include at least one image-capable model in `CLAWDBOT_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI vision-capable variants, etc.).

### Aggregators / alternate gateways

If you have keys enabled, we also support testing via:
- OpenRouter: `openrouter/...` (hundreds of models; use `clawdbot models scan` to find tool+image capable candidates)
- OpenCode Zen: `opencode-zen/...` (requires `OPENCODE_ZEN_API_KEY`)

Tip: don’t try to hardcode “all models” in docs. The authoritative list is whatever `discoverModels(...)` returns on your machine + whatever keys are available.

## Credentials (never commit)

Live tests discover credentials the same way the CLI does. Practical implications:
- If the CLI works, live tests should find the same keys.
- If a live test says “no creds”, debug the same way you’d debug `clawdbot models list` / model selection.

- Profile store: `~/.clawdbot/credentials/` (preferred; what “profile keys” means in the tests)
- Config: `~/.clawdbot/clawdbot.json` (or `CLAWDBOT_CONFIG_PATH`)

If you want to rely on env keys (e.g. exported in your `~/.profile`), run local tests after `source ~/.profile`, or use the Docker runners below (they can mount `~/.profile` into the container).

## Docker runners (optional “works in Linux” checks)

These run `pnpm test:live` inside the repo Docker image, mounting your local config dir and workspace (and sourcing `~/.profile` if mounted):

- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Onboarding wizard (TTY, full scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Gateway networking (two containers, WS auth + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)

Useful env vars:

- `CLAWDBOT_CONFIG_DIR=...` (default: `~/.clawdbot`) mounted to `/home/node/.clawdbot`
- `CLAWDBOT_WORKSPACE_DIR=...` (default: `~/clawd`) mounted to `/home/node/clawd`
- `CLAWDBOT_PROFILE_FILE=...` (default: `~/.profile`) mounted to `/home/node/.profile` and sourced before running tests
- `CLAWDBOT_LIVE_GATEWAY_MODELS=...` / `CLAWDBOT_LIVE_MODELS=...` to narrow the run
- `CLAWDBOT_LIVE_REQUIRE_PROFILE_KEYS=1` to ensure creds come from the profile store (not env)

## Docs sanity

Run docs checks after doc edits: `pnpm docs:list`.

## Offline regression (CI-safe)

These are “real pipeline” regressions without real providers:
- Gateway tool calling (mock OpenAI, real gateway + agent loop): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway wizard (WS `wizard.start`/`wizard.next`, writes config + auth enforced): `src/gateway/gateway.wizard.e2e.test.ts`

## Adding regressions (guidance)

When you fix a provider/model issue discovered in live:
- Add a CI-safe regression if possible (mock/stub provider, or capture the exact request-shape transformation)
- If it’s inherently live-only (rate limits, auth policies), keep the live test narrow and opt-in via env vars
- Prefer targeting the smallest layer that catches the bug:
  - provider request conversion/replay bug → direct models test
  - gateway session/history/tool pipeline bug → gateway live smoke or CI-safe gateway mock test
