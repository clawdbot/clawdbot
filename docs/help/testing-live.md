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
[Testing](/help/testing). This page covers the **live** (network-touching) test
suites: model matrix, CLI backends, ACP, and media-provider live tests, plus
credential handling.

## Live: local profile smoke commands

Source `~/.profile` before ad hoc live checks so provider keys and local tool
paths match your shell:

```bash
source ~/.profile
```

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

`voicecall smoke` is a dry run unless `--yes` is also present. Use `--yes` only
when you intentionally want to place a real notify call. For Twilio, Telnyx, and
Plivo, a successful readiness check requires a public webhook URL; local-only
loopback/private fallbacks are rejected by design.

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
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
- Set `OPENCLAW_LIVE_MODELS=modern` (or `all`, alias for modern) to actually run this suite; otherwise it skips to keep `pnpm test:live` focused on gateway smoke
- How to select models:
  - `OPENCLAW_LIVE_MODELS=modern` to run the modern allowlist (Opus/Sonnet 4.6+, GPT-5.2 + Codex, Gemini 3, DeepSeek V4, GLM 4.7, MiniMax M2.7, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` is an alias for the modern allowlist
  - or `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,openai-codex/gpt-5.2,anthropic/claude-opus-4-6,..."` (comma allowlist)
  - Modern/all sweeps default to a curated high-signal cap; set `OPENCLAW_LIVE_MAX_MODELS=0` for an exhaustive modern sweep or a positive number for a smaller cap.
  - Exhaustive sweeps use `OPENCLAW_LIVE_TEST_TIMEOUT_MS` for the whole direct-model test timeout. Default: 60 minutes.
  - Direct-model probes run with 20-way parallelism by default; set `OPENCLAW_LIVE_MODEL_CONCURRENCY` to override.
- How to select providers:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (comma allowlist)
- Where keys come from:
  - By default: profile store and env fallbacks
  - Set `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to enforce **profile store** only
- Why this exists:
  - Separates “provider API is broken / key is invalid” from “gateway agent pipeline is broken”
  - Contains small, isolated regressions (example: OpenAI Responses/Codex Responses reasoning replay + tool-call flows)

### Layer 2: Gateway + dev agent smoke (what "@openclaw" actually does)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Goal:
  - Spin up an in-process gateway
  - Create/patch a `agent:dev:*` session (model override per run)
  - Iterate models-with-keys and assert:
    - “meaningful” response (no tools)
    - a real tool invocation works (read probe)
    - optional extra tool probes (exec+read probe)
    - OpenAI regression paths (tool-call-only → follow-up) keep working
- Probe details (so you can explain failures quickly):
  - `read` probe: the test writes a nonce file in the workspace and asks the agent to `read` it and echo the nonce back.
  - `exec+read` probe: the test asks the agent to `exec`-write a nonce into a temp file, then `read` it back.
  - image probe: the test attaches a generated PNG (cat + randomized code) and expects the model to return `cat <CODE>`.
  - Implementation reference: `src/gateway/gateway-models.profiles.live.test.ts` and `src/gateway/live-image-probe.ts`.
- How to enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
- How to select models:
  - Default: modern allowlist (Opus/Sonnet 4.6+, GPT-5.2 + Codex, Gemini 3, DeepSeek V4, GLM 4.7, MiniMax M2.7, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` is an alias for the modern allowlist
  - Or set `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (or comma list) to narrow
  - Modern/all gateway sweeps default to a curated high-signal cap; set `OPENCLAW_LIVE_GATEWAY_MAX_MODELS=0` for an exhaustive modern sweep or a positive number for a smaller cap.
- How to select providers (avoid “OpenRouter everything”):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (comma allowlist)
- Tool + image probes are always on in this live test:
  - `read` probe + `exec+read` probe (tool stress)
  - image probe runs when the model advertises image input support
  - Flow (high level):
    - Test generates a tiny PNG with “CAT” + random code (`src/gateway/live-image-probe.ts`)
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

## Live: CLI backend smoke (Claude, Codex, Gemini, or other local CLIs)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Goal: validate the Gateway + agent pipeline using a local CLI backend, without touching your default config.
- Backend-specific smoke defaults live with the owning extension's `cli-backend.ts` definition.
- Enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Defaults:
  - Default provider/model: `claude-cli/claude-sonnet-4-6`
  - Command/args/image behavior come from the owning CLI backend plugin metadata.
- Overrides (optional):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.2"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` to send a real image attachment (paths are injected into the prompt). Docker recipes default this off unless explicitly requested.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` to pass image file paths as CLI args instead of prompt injection.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (or `"list"`) to control how image args are passed when `IMAGE_ARG` is set.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` to send a second turn and validate resume flow.
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE=1` to opt into the Claude Sonnet -> Opus same-session continuity probe when the selected model supports a switch target. Docker recipes default this off for aggregate reliability.
  - `OPENCLAW_LIVE_CLI_BACKEND_MCP_PROBE=1` to opt into the MCP/tool loopback probe. Docker recipes default this off unless explicitly requested.

Example:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.2" \
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
pnpm test:docker:live-cli-backend:codex
pnpm test:docker:live-cli-backend:gemini
```

Notes:

- The Docker runner lives at `scripts/test-live-cli-backend-docker.sh`.
- It runs the live CLI-backend smoke inside the repo Docker image as the non-root `node` user.
- It resolves CLI smoke metadata from the owning extension, then installs the matching Linux CLI package (`@anthropic-ai/claude-code`, `@openai/codex`, or `@google/gemini-cli`) into a cached writable prefix at `OPENCLAW_DOCKER_CLI_TOOLS_DIR` (default: `~/.cache/openclaw/docker-cli-tools`).
- `pnpm test:docker:live-cli-backend:claude-subscription` requires portable Claude Code subscription OAuth through either `~/.claude/.credentials.json` with `claudeAiOauth.subscriptionType` or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. It first proves direct `claude -p` in Docker, then runs two Gateway CLI-backend turns without preserving Anthropic API-key env vars. This subscription lane disables the Claude MCP/tool and image probes by default because Claude currently routes third-party app usage through extra-usage billing instead of normal subscription plan limits.
- The live CLI-backend smoke now exercises the same end-to-end flow for Claude, Codex, and Gemini: text turn, image classification turn, then MCP `cron` tool call verified through the gateway CLI.
- Claude's default smoke also patches the session from Sonnet to Opus and verifies the resumed session still remembers an earlier note.

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
  - `OPENCLAW_LIVE_ACP_BIND_CODEX_MODEL=gpt-5.2`
  - `OPENCLAW_LIVE_ACP_BIND_OPENCODE_MODEL=opencode/kimi-k2.6`
  - `OPENCLAW_LIVE_ACP_BIND_REQUIRE_TRANSCRIPT=1`
  - `OPENCLAW_LIVE_ACP_BIND_REQUIRE_CRON=1`
  - `OPENCLAW_LIVE_ACP_BIND_PARENT_MODEL=openai/gpt-5.2`
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
- It sources `~/.profile`, stages the matching CLI auth material into the container, then installs the requested live CLI (`@anthropic-ai/claude-code`, `@openai/codex`, Factory Droid via `https://app.factory.ai/cli`, `@google/gemini-cli`, or `opencode-ai`) if missing. The ACP backend itself is the bundled embedded `acpx/runtime` package from the `acpx` plugin.
- The Droid Docker variant stages `~/.factory` for settings, forwards `FACTORY_API_KEY`, and requires that API key because local Factory OAuth/keyring auth is not portable into the container. It uses ACPX's built-in `droid exec --output-format acp` registry entry.
- The OpenCode Docker variant is a strict single-agent regression lane. It writes a temporary `OPENCODE_CONFIG_CONTENT` default model from `OPENCLAW_LIVE_ACP_BIND_OPENCODE_MODEL` (default `opencode/kimi-k2.6`) after sourcing `~/.profile`, and `pnpm test:docker:live-acp-bind:opencode` requires a bound assistant transcript instead of accepting the generic post-bind skip.
- Direct `acpx` CLI calls are only a manual/workaround path for comparing behavior outside the Gateway. The Docker ACP bind smoke exercises OpenClaw's embedded `acpx` runtime backend.

## Live: Codex app-server harness smoke

- Goal: validate the plugin-owned Codex harness through the normal gateway
  `agent` method:
  - load the bundled `codex` plugin
  - select `OPENCLAW_AGENT_RUNTIME=codex`
  - send a first gateway agent turn to `openai/gpt-5.2` with the Codex harness forced
  - send a second turn to the same OpenClaw session and verify the app-server
    thread can resume
  - run `/codex status` and `/codex models` through the same gateway command
    path
  - optionally run two Guardian-reviewed escalated shell probes: one benign
    command that should be approved and one fake-secret upload that should be
    denied so the agent asks back
- Test: `src/gateway/gateway-codex-harness.live.test.ts`
- Enable: `OPENCLAW_LIVE_CODEX_HARNESS=1`
- Default model: `openai/gpt-5.2`
- Optional image probe: `OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=1`
- Optional MCP/tool probe: `OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=1`
- Optional Guardian probe: `OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=1`
- The smoke sets `OPENCLAW_AGENT_HARNESS_FALLBACK=none` so a broken Codex
  harness cannot pass by silently falling back to PI.
- Auth: Codex app-server auth from the local Codex subscription login. Docker
  smokes can also provide `OPENAI_API_KEY` for non-Codex probes when applicable,
  plus optional copied `~/.codex/auth.json` and `~/.codex/config.toml`.

Local recipe:

```bash
source ~/.profile
OPENCLAW_LIVE_CODEX_HARNESS=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_MODEL=openai/gpt-5.2 \
  pnpm test:live -- src/gateway/gateway-codex-harness.live.test.ts
```

Docker recipe:

```bash
source ~/.profile
pnpm test:docker:live-codex-harness
```

Docker notes:

- The Docker runner lives at `scripts/test-live-codex-harness-docker.sh`.
- It sources the mounted `~/.profile`, passes `OPENAI_API_KEY`, copies Codex CLI
  auth files when present, installs `@openai/codex` into a writable mounted npm
  prefix, stages the source tree, then runs only the Codex-harness live test.
- Docker enables the image, MCP/tool, and Guardian probes by default. Set
  `OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=0` or
  `OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=0` or
  `OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=0` when you need a narrower debug
  run.
- Docker also exports `OPENCLAW_AGENT_HARNESS_FALLBACK=none`, matching the live
  test config so legacy aliases or PI fallback cannot hide a Codex harness
  regression.

### Recommended live recipes

Narrow, explicit allowlists are fastest and least flaky:

- Single model, direct (no gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Single model, gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool calling across several providers:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,deepseek/deepseek-v4-flash,zai/glm-5.1,minimax/MiniMax-M2.7" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google focus (Gemini API key + Antigravity):
  - Gemini (API key): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google adaptive thinking smoke:
  - If local keys live in shell profile: `source ~/.profile`
  - Gemini 3 dynamic default: `pnpm openclaw qa manual --provider-mode live-frontier --model google/gemini-3.1-pro-preview --alt-model google/gemini-3.1-pro-preview --message '/think adaptive Reply exactly: GEMINI_ADAPTIVE_OK' --timeout-ms 180000`
  - Gemini 2.5 dynamic budget: `pnpm openclaw qa manual --provider-mode live-frontier --model google/gemini-2.5-flash --alt-model google/gemini-2.5-flash --message '/think adaptive Reply exactly: GEMINI25_ADAPTIVE_OK' --timeout-ms 180000`

Notes:

- `google/...` uses the Gemini API (API key).
- `google-antigravity/...` uses the Antigravity OAuth bridge (Cloud Code Assist-style agent endpoint).
- `google-gemini-cli/...` uses the local Gemini CLI on your machine (separate auth + tooling quirks).
- Gemini API vs Gemini CLI:
  - API: OpenClaw calls Google’s hosted Gemini API over HTTP (API key / profile auth); this is what most users mean by “Gemini”.
  - CLI: OpenClaw shells out to a local `gemini` binary; it has its own auth and can behave differently (streaming/tool support/version skew).

## Live: model matrix (what we cover)

There is no fixed “CI model list” (live is opt-in), but these are the **recommended** models to cover regularly on a dev machine with keys.

### Modern smoke set (tool calling + image)

This is the “common models” run we expect to keep working:

- OpenAI (non-Codex): `openai/gpt-5.2`
- OpenAI Codex OAuth: `openai-codex/gpt-5.2`
- Anthropic: `anthropic/claude-opus-4-6` (or `anthropic/claude-sonnet-4-6`)
- Google (Gemini API): `google/gemini-3.1-pro-preview` and `google/gemini-3-flash-preview` (avoid older Gemini 2.x models)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` and `google-antigravity/gemini-3-flash`
- DeepSeek: `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro`
- Z.AI (GLM): `zai/glm-5.1`
- MiniMax: `minimax/MiniMax-M2.7`

Run gateway smoke with tools + image:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3.1-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,deepseek/deepseek-v4-flash,zai/glm-5.1,minimax/MiniMax-M2.7" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Baseline: tool calling (Read + optional Exec)

Pick at least one per provider family:

- OpenAI: `openai/gpt-5.2`
- Anthropic: `anthropic/claude-opus-4-6` (or `anthropic/claude-sonnet-4-6`)
- Google: `google/gemini-3-flash-preview` (or `google/gemini-3.1-pro-preview`)
- DeepSeek: `deepseek/deepseek-v4-flash`
- Z.AI (GLM): `zai/glm-5.1`
- MiniMax: `minimax/MiniMax-M2.7`

Optional additional coverage (nice to have):

- xAI: `xai/grok-4` (or latest available)
- Mistral: `mistral/`… (pick one “tools” capable model you have enabled)
- Cerebras: `cerebras/`… (if you have access)
- LM Studio: `lmstudio/`… (local; tool calling depends on API mode)

### Vision: image send (attachment → multimodal message)

Include at least one image-capable model in `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI vision-capable variants, etc.) to exercise the image probe.

### Aggregators / alternate gateways

If you have keys enabled, we also support testing via:

- OpenRouter: `openrouter/...` (hundreds of models; use `openclaw models scan` to find tool+image capable candidates)
- OpenCode: `opencode/...` for Zen and `opencode-go/...` for Go (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

More providers you can include in the live matrix (if you have creds/config):

- Built-in: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `opencode-go`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Via `models.providers` (custom endpoints): `minimax` (cloud/API), plus any OpenAI/Anthropic-compatible proxy (LM Studio, vLLM, LiteLLM, etc.)

<Tip>
Do not hardcode "all models" in docs. The authoritative list is whatever `discoverModels(...)` returns on your machine plus whatever keys are available.
</Tip>

## Credentials (never commit)

Live tests discover credentials the same way the CLI does. Practical implications:

- If the CLI works, live tests should find the same keys.
- If a live test says “no creds”, debug the same way you’d debug `openclaw models list` / model selection.

- Per-agent auth profiles: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (this is what “profile keys” means in the live tests)
- Config: `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`)
- Legacy state dir: `~/.openclaw/credentials/` (copied into the staged live home when present, but not the main profile-key store)
- Live local runs copy the active config, per-agent `auth-profiles.json` files, legacy `credentials/`, and supported external CLI auth dirs into a temp test home by default; staged live homes skip `workspace/` and `sandboxes/`, and `agents.*.workspace` / `agentDir` path overrides are stripped so probes stay off your real host workspace.

If you want to rely on env keys (e.g. exported in your `~/.profile`), run local tests after `source ~/.profile`, or use the Docker runners below (they can mount `~/.profile` into the container).

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
  - Loads missing provider env vars from your login shell (`~/.profile`) before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in `auth-profiles.json` do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs each configured provider through the shared image-generation runtime:
    - `<provider>:generate`
    - `<provider>:edit` when the provider declares edit support
- Current bundled providers covered:
  - `fal`
  - `google`
  - `minimax`
  - `openai`
  - `openrouter`
  - `vydra`
  - `xai`
- Optional narrowing:
  - `OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS="openai,google,openrouter,xai"`
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
plugin activation, on-demand bundled runtime-dependency repair, the shared
image-generation runtime, and the live provider request.

## Music generation live

- Test: `extensions/music-generation-providers.live.test.ts`
- Enable: `OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/music-generation-providers.live.test.ts`
- Harness: `pnpm test:live:media music`
- Scope:
  - Exercises the shared bundled music-generation provider path
  - Currently covers Google and MiniMax
  - Loads provider env vars from your login shell (`~/.profile`) before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in `auth-profiles.json` do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs both declared runtime modes when available:
    - `generate` with prompt-only input
    - `edit` when the provider declares `capabilities.edit.enabled`
  - Current shared-lane coverage:
    - `google`: `generate`, `edit`
    - `minimax`: `generate`
    - `comfy`: separate Comfy live file, not this shared sweep
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
  - Exercises the shared bundled video-generation provider path
  - Defaults to the release-safe smoke path: non-FAL providers, one text-to-video request per provider, one-second lobster prompt, and a per-provider operation cap from `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS` (`180000` by default)
  - Skips FAL by default because provider-side queue latency can dominate release time; pass `--video-providers fal` or `OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS="fal"` to run it explicitly
  - Loads provider env vars from your login shell (`~/.profile`) before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in `auth-profiles.json` do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs only `generate` by default
  - Set `OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1` to also run declared transform modes when available:
    - `imageToVideo` when the provider declares `capabilities.imageToVideo.enabled` and the selected provider/model accepts buffer-backed local image input in the shared sweep
    - `videoToVideo` when the provider declares `capabilities.videoToVideo.enabled` and the selected provider/model accepts buffer-backed local video input in the shared sweep
  - Current declared-but-skipped `imageToVideo` providers in the shared sweep:
    - `vydra` because bundled `veo3` is text-only and bundled `kling` requires a remote image URL
  - Provider-specific Vydra coverage:
    - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_VYDRA_VIDEO=1 pnpm test:live -- extensions/vydra/vydra.live.test.ts`
    - that file runs `veo3` text-to-video plus a `kling` lane that uses a remote image URL fixture by default
  - Current `videoToVideo` live coverage:
    - `runway` only when the selected model is `runway/gen4_aleph`
  - Current declared-but-skipped `videoToVideo` providers in the shared sweep:
    - `alibaba`, `qwen`, `xai` because those paths currently require remote `http(s)` / MP4 reference URLs
    - `google` because the current shared Gemini/Veo lane uses local buffer-backed input and that path is not accepted in the shared sweep
    - `openai` because the current shared lane lacks org-specific video inpaint/remix access guarantees
- Optional narrowing:
  - `OPENCLAW_LIVE_VIDEO_GENERATION_PROVIDERS="google,openai,runway"`
  - `OPENCLAW_LIVE_VIDEO_GENERATION_MODELS="google/veo-3.1-fast-generate-preview,openai/sora-2,runway/gen4_aleph"`
  - `OPENCLAW_LIVE_VIDEO_GENERATION_SKIP_PROVIDERS=""` to include every provider in the default sweep, including FAL
  - `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS=60000` to reduce each provider operation cap for an aggressive smoke run
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

## Media live harness

- Command: `pnpm test:live:media`
- Purpose:
  - Runs the shared image, music, and video live suites through one repo-native entrypoint
  - Auto-loads missing provider env vars from `~/.profile`
  - Auto-narrows each suite to providers that currently have usable auth by default
  - Reuses `scripts/test-live.mjs`, so heartbeat and quiet-mode behavior stay consistent
- Examples:
  - `pnpm test:live:media`
  - `pnpm test:live:media image video --providers openai,google,minimax`
  - `pnpm test:live:media video --video-providers openai,runway --all-providers`
  - `pnpm test:live:media music --quiet`

## Related

- [Testing](/help/testing) — unit, integration, QA, and Docker suites
