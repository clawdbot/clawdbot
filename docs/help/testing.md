---
summary: "Testing kit: unit/e2e/live suites, Docker runners, and what each test covers"
read_when:
  - Running tests locally or in CI
  - Adding regressions for model/provider bugs
  - Debugging gateway + agent behavior
title: "Testing"
---

# Testing

OpenClaw has three Vitest suites (unit/integration, e2e, live) and a small set of Docker runners.

This doc is a “how we test” guide:

- What each suite covers (and what it deliberately does _not_ cover)
- Which commands to run for common workflows (local, pre-push, debugging)
- How live tests discover credentials and select models/providers
- How to add regressions for real-world model/provider issues

## Quick start

Most days:

- Full gate (expected before push): `pnpm build && pnpm check && pnpm test`
- Faster local full-suite run on a roomy machine: `pnpm test:max`
- Direct Vitest watch loop: `pnpm test:watch`
- Direct file targeting now routes extension/channel paths too: `pnpm test extensions/discord/src/monitor/message-handler.preflight.test.ts`
- Prefer targeted runs first when you are iterating on a single failure.
- Docker-backed QA site: `pnpm qa:lab:up`
- Linux VM-backed QA lane: `pnpm openclaw qa suite --runner multipass --scenario channel-chat-baseline`

When you touch tests or want extra confidence:

- Coverage gate: `pnpm test:coverage`
- E2E suite: `pnpm test:e2e`

When debugging real providers/models (requires real creds):

- Live suite (models + gateway tool/image probes): `pnpm test:live`
- Target one live file quietly: `pnpm test:live -- src/agents/models.profiles.live.test.ts`

Tip: when you only need one failing case, prefer narrowing live tests via the allowlist env vars described below.

## QA-specific runners

These commands sit beside the main test suites when you need QA-lab realism:

- `pnpm openclaw qa suite`
  - Runs repo-backed QA scenarios directly on the host.
  - Runs multiple selected scenarios in parallel by default with isolated
    gateway workers, up to 64 workers or the selected scenario count. Use
    `--concurrency <count>` to tune the worker count, or `--concurrency 1` for
    the older serial lane.
- `pnpm openclaw qa suite --runner multipass`
  - Runs the same QA suite inside a disposable Multipass Linux VM.
  - Keeps the same scenario-selection behavior as `qa suite` on the host.
  - Reuses the same provider/model selection flags as `qa suite`.
  - Live runs forward the supported QA auth inputs that are practical for the guest:
    env-based provider keys, the QA live provider config path, and `CODEX_HOME`
    when present.
  - Output dirs must stay under the repo root so the guest can write back through
    the mounted workspace.
  - Writes the normal QA report + summary plus Multipass logs under
    `.artifacts/qa-e2e/...`.
- `pnpm qa:lab:up`
  - Starts the Docker-backed QA site for operator-style QA work.
- `pnpm openclaw qa matrix`
  - Runs the Matrix live QA lane against a disposable Docker-backed Tuwunel homeserver.
  - Provisions three temporary Matrix users (`driver`, `sut`, `observer`) plus one private room, then starts a QA gateway child with the real Matrix plugin as the SUT transport.
  - Uses the pinned stable Tuwunel image `ghcr.io/matrix-construct/tuwunel:v1.5.1` by default. Override with `OPENCLAW_QA_MATRIX_TUWUNEL_IMAGE` when you need to test a different image.
  - Matrix currently supports only `--credential-source env` because the lane provisions disposable users locally.
  - Writes a Matrix QA report, summary, and observed-events artifact under `.artifacts/qa-e2e/...`.
- `pnpm openclaw qa telegram`
  - Runs the Telegram live QA lane against a real private group using the driver and SUT bot tokens from env.
  - Requires `OPENCLAW_QA_TELEGRAM_GROUP_ID`, `OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN`, and `OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN`. The group id must be the numeric Telegram chat id.
  - Supports `--credential-source convex` for shared pooled credentials. Use env mode by default, or set `OPENCLAW_QA_CREDENTIAL_SOURCE=convex` to opt into pooled leases.
  - Requires two distinct bots in the same private group, with the SUT bot exposing a Telegram username.
  - For stable bot-to-bot observation, enable Bot-to-Bot Communication Mode in `@BotFather` for both bots and ensure the driver bot can observe group bot traffic.
  - Writes a Telegram QA report, summary, and observed-messages artifact under `.artifacts/qa-e2e/...`.

Live transport lanes share one standard contract so new transports do not drift:

`qa-channel` remains the broad synthetic QA suite and is not part of the live
transport coverage matrix.

| Lane     | Canary | Mention gating | Allowlist block | Top-level reply | Restart resume | Thread follow-up | Thread isolation | Reaction observation | Help command |
| -------- | ------ | -------------- | --------------- | --------------- | -------------- | ---------------- | ---------------- | -------------------- | ------------ |
| Matrix   | x      | x              | x               | x               | x              | x                | x                | x                    |              |
| Telegram | x      |                |                 |                 |                |                  |                  |                      | x            |

### Shared Telegram credentials via Convex (v1)

When `--credential-source convex` (or `OPENCLAW_QA_CREDENTIAL_SOURCE=convex`) is enabled for
`openclaw qa telegram`, QA lab acquires an exclusive lease from a Convex-backed pool, heartbeats
that lease while the lane is running, and releases the lease on shutdown.

Reference Convex project scaffold:

- `qa/convex-credential-broker/`

Required env vars:

- `OPENCLAW_QA_CONVEX_SITE_URL` (for example `https://your-deployment.convex.site`)
- One secret for the selected role:
  - `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` for `maintainer`
  - `OPENCLAW_QA_CONVEX_SECRET_CI` for `ci`
- Credential role selection:
  - CLI: `--credential-role maintainer|ci`
  - Env default: `OPENCLAW_QA_CREDENTIAL_ROLE` (defaults to `maintainer`)

Optional env vars:

- `OPENCLAW_QA_CREDENTIAL_LEASE_TTL_MS` (default `1200000`)
- `OPENCLAW_QA_CREDENTIAL_HEARTBEAT_INTERVAL_MS` (default `30000`)
- `OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS` (default `90000`)
- `OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS` (default `15000`)
- `OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX` (default `/qa-credentials/v1`)
- `OPENCLAW_QA_CREDENTIAL_OWNER_ID` (optional trace id)
- `OPENCLAW_QA_ALLOW_INSECURE_HTTP=1` allows loopback `http://` Convex URLs for local-only development.

`OPENCLAW_QA_CONVEX_SITE_URL` should use `https://` in normal operation.

Maintainer admin commands (pool add/remove/list) require
`OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` specifically.

CLI helpers for maintainers:

```bash
pnpm openclaw qa credentials add --kind telegram --payload-file qa/telegram-credential.json
pnpm openclaw qa credentials list --kind telegram
pnpm openclaw qa credentials remove --credential-id <credential-id>
```

Use `--json` for machine-readable output in scripts and CI utilities.

Default endpoint contract (`OPENCLAW_QA_CONVEX_SITE_URL` + `/qa-credentials/v1`):

- `POST /acquire`
  - Request: `{ kind, ownerId, actorRole, leaseTtlMs, heartbeatIntervalMs }`
  - Success: `{ status: "ok", credentialId, leaseToken, payload, leaseTtlMs?, heartbeatIntervalMs? }`
  - Exhausted/retryable: `{ status: "error", code: "POOL_EXHAUSTED" | "NO_CREDENTIAL_AVAILABLE", ... }`
- `POST /heartbeat`
  - Request: `{ kind, ownerId, actorRole, credentialId, leaseToken, leaseTtlMs }`
  - Success: `{ status: "ok" }` (or empty `2xx`)
- `POST /release`
  - Request: `{ kind, ownerId, actorRole, credentialId, leaseToken }`
  - Success: `{ status: "ok" }` (or empty `2xx`)
- `POST /admin/add` (maintainer secret only)
  - Request: `{ kind, actorId, payload, note?, status? }`
  - Success: `{ status: "ok", credential }`
- `POST /admin/remove` (maintainer secret only)
  - Request: `{ credentialId, actorId }`
  - Success: `{ status: "ok", changed, credential }`
  - Active lease guard: `{ status: "error", code: "LEASE_ACTIVE", ... }`
- `POST /admin/list` (maintainer secret only)
  - Request: `{ kind?, status?, includePayload?, limit? }`
  - Success: `{ status: "ok", credentials, count }`

Payload shape for Telegram kind:

- `{ groupId: string, driverToken: string, sutToken: string }`
- `groupId` must be a numeric Telegram chat id string.
- `admin/add` validates this shape for `kind: "telegram"` and rejects malformed payloads.

### Adding a channel to QA

Adding a channel to the markdown QA system requires exactly two things:

1. A transport adapter for the channel.
2. A scenario pack that exercises the channel contract.

Do not add a channel-specific QA runner when the shared `qa-lab` runner can
own the flow.

`qa-lab` owns the shared mechanics:

- suite startup and teardown
- worker concurrency
- artifact writing
- report generation
- scenario execution
- compatibility aliases for older `qa-channel` scenarios

The channel adapter owns the transport contract:

- how the gateway is configured for that transport
- how readiness is checked
- how inbound events are injected
- how outbound messages are observed
- how transcripts and normalized transport state are exposed
- how transport-backed actions are executed
- how transport-specific reset or cleanup is handled

The minimum adoption bar for a new channel is:

1. Implement the transport adapter on the shared `qa-lab` seam.
2. Register the adapter in the transport registry.
3. Keep transport-specific mechanics inside the adapter or the channel harness.
4. Author or adapt markdown scenarios under `qa/scenarios/`.
5. Use the generic scenario helpers for new scenarios.
6. Keep existing compatibility aliases working unless the repo is doing an intentional migration.

The decision rule is strict:

- If behavior can be expressed once in `qa-lab`, put it in `qa-lab`.
- If behavior depends on one channel transport, keep it in that adapter or plugin harness.
- If a scenario needs a new capability that more than one channel can use, add a generic helper instead of a channel-specific branch in `suite.ts`.
- If a behavior is only meaningful for one transport, keep the scenario transport-specific and make that explicit in the scenario contract.

Preferred generic helper names for new scenarios are:

- `waitForTransportReady`
- `waitForChannelReady`
- `injectInboundMessage`
- `injectOutboundMessage`
- `waitForTransportOutboundMessage`
- `waitForChannelOutboundMessage`
- `waitForNoTransportOutbound`
- `getTransportSnapshot`
- `readTransportMessage`
- `readTransportTranscript`
- `formatTransportTranscript`
- `resetTransport`

Compatibility aliases remain available for existing scenarios, including:

- `waitForQaChannelReady`
- `waitForOutboundMessage`
- `waitForNoOutbound`
- `formatConversationTranscript`
- `resetBus`

New channel work should use the generic helper names.
Compatibility aliases exist to avoid a flag day migration, not as the model for
new scenario authoring.

## Test suites (what runs where)

Think of the suites as “increasing realism” (and increasing flakiness/cost):

### Unit / integration (default)

- Command: `pnpm test`
- Config: ten sequential shard runs (`vitest.full-*.config.ts`) over the existing scoped Vitest projects
- Files: core/unit inventories under `src/**/*.test.ts`, `packages/**/*.test.ts`, `test/**/*.test.ts`, and the whitelisted `ui` node tests covered by `vitest.unit.config.ts`
- Scope:
  - Pure unit tests
  - In-process integration tests (gateway auth, routing, tooling, parsing, config)
  - Deterministic regressions for known bugs
- Expectations:
  - Runs in CI
  - No real keys required
  - Should be fast and stable
- Projects note:
  - Untargeted `pnpm test` now runs eleven smaller shard configs (`core-unit-src`, `core-unit-security`, `core-unit-ui`, `core-unit-support`, `core-support-boundary`, `core-contracts`, `core-bundled`, `core-runtime`, `agentic`, `auto-reply`, `extensions`) instead of one giant native root-project process. This cuts peak RSS on loaded machines and avoids auto-reply/extension work starving unrelated suites.
  - `pnpm test --watch` still uses the native root `vitest.config.ts` project graph, because a multi-shard watch loop is not practical.
  - `pnpm test`, `pnpm test:watch`, and `pnpm test:perf:imports` route explicit file/directory targets through scoped lanes first, so `pnpm test extensions/discord/src/monitor/message-handler.preflight.test.ts` avoids paying the full root project startup tax.
  - `pnpm test:changed` expands changed git paths into the same scoped lanes when the diff only touches routable source/test files; config/setup edits still fall back to the broad root-project rerun.
  - Import-light unit tests from agents, commands, plugins, auto-reply helpers, `plugin-sdk`, and similar pure utility areas route through the `unit-fast` lane, which skips `test/setup-openclaw-runtime.ts`; stateful/runtime-heavy files stay on the existing lanes.
  - Selected `plugin-sdk` and `commands` helper source files also map changed-mode runs to explicit sibling tests in those light lanes, so helper edits avoid rerunning the full heavy suite for that directory.
  - `auto-reply` now has three dedicated buckets: top-level core helpers, top-level `reply.*` integration tests, and the `src/auto-reply/reply/**` subtree. This keeps the heaviest reply harness work off the cheap status/chunk/token tests.
- Embedded runner note:
  - When you change message-tool discovery inputs or compaction runtime context,
    keep both levels of coverage.
  - Add focused helper regressions for pure routing/normalization boundaries.
  - Also keep the embedded runner integration suites healthy:
    `src/agents/pi-embedded-runner/compact.hooks.test.ts`,
    `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts`, and
    `src/agents/pi-embedded-runner/run.overflow-compaction.loop.test.ts`.
  - Those suites verify that scoped ids and compaction behavior still flow
    through the real `run.ts` / `compact.ts` paths; helper-only tests are not a
    sufficient substitute for those integration paths.
- Pool note:
  - Base Vitest config now defaults to `threads`.
  - The shared Vitest config also fixes `isolate: false` and uses the non-isolated runner across the root projects, e2e, and live configs.
  - The root UI lane keeps its `jsdom` setup and optimizer, but now runs on the shared non-isolated runner too.
  - Each `pnpm test` shard inherits the same `threads` + `isolate: false` defaults from the shared Vitest config.
  - The shared `scripts/run-vitest.mjs` launcher now also adds `--no-maglev` for Vitest child Node processes by default to reduce V8 compile churn during big local runs. Set `OPENCLAW_VITEST_ENABLE_MAGLEV=1` if you need to compare against stock V8 behavior.
- Fast-local iteration note:
  - `pnpm test:changed` routes through scoped lanes when the changed paths map cleanly to a smaller suite.
  - `pnpm test:max` and `pnpm test:changed:max` keep the same routing behavior, just with a higher worker cap.
  - Local worker auto-scaling is intentionally conservative now and also backs off when the host load average is already high, so multiple concurrent Vitest runs do less damage by default.
  - The base Vitest config marks the projects/config files as `forceRerunTriggers` so changed-mode reruns stay correct when test wiring changes.
  - The config keeps `OPENCLAW_VITEST_FS_MODULE_CACHE` enabled on supported hosts; set `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/abs/path` if you want one explicit cache location for direct profiling.
- Perf-debug note:
  - `pnpm test:perf:imports` enables Vitest import-duration reporting plus import-breakdown output.
  - `pnpm test:perf:imports:changed` scopes the same profiling view to files changed since `origin/main`.
- `pnpm test:perf:changed:bench -- --ref <git-ref>` compares routed `test:changed` against the native root-project path for that committed diff and prints wall time plus macOS max RSS.
- `pnpm test:perf:changed:bench -- --worktree` benchmarks the current dirty tree by routing the changed file list through `scripts/test-projects.mjs` and the root Vitest config.
  - `pnpm test:perf:profile:main` writes a main-thread CPU profile for Vitest/Vite startup and transform overhead.
  - `pnpm test:perf:profile:runner` writes runner CPU+heap profiles for the unit suite with file parallelism disabled.

### E2E (gateway smoke)

- Command: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- Files: `src/**/*.e2e.test.ts`, `test/**/*.e2e.test.ts`
- Runtime defaults:
  - Uses Vitest `threads` with `isolate: false`, matching the rest of the repo.
  - Uses adaptive workers (CI: up to 2, local: 1 by default).
  - Runs in silent mode by default to reduce console I/O overhead.
- Useful overrides:
  - `OPENCLAW_E2E_WORKERS=<n>` to force worker count (capped at 16).
  - `OPENCLAW_E2E_VERBOSE=1` to re-enable verbose console output.
- Scope:
  - Multi-instance gateway end-to-end behavior
  - WebSocket/HTTP surfaces, node pairing, and heavier networking
- Expectations:
  - Runs in CI (when enabled in the pipeline)
  - No real keys required
  - More moving parts than unit tests (can be slower)

### E2E: OpenShell backend smoke

- Command: `pnpm test:e2e:openshell`
- File: `test/openshell-sandbox.e2e.test.ts`
- Scope:
  - Starts an isolated OpenShell gateway on the host via Docker
  - Creates a sandbox from a temporary local Dockerfile
  - Exercises OpenClaw's OpenShell backend over real `sandbox ssh-config` + SSH exec
  - Verifies remote-canonical filesystem behavior through the sandbox fs bridge
- Expectations:
  - Opt-in only; not part of the default `pnpm test:e2e` run
  - Requires a local `openshell` CLI plus a working Docker daemon
  - Uses isolated `HOME` / `XDG_CONFIG_HOME`, then destroys the test gateway and sandbox
- Useful overrides:
  - `OPENCLAW_E2E_OPENSHELL=1` to enable the test when running the broader e2e suite manually
  - `OPENCLAW_E2E_OPENSHELL_COMMAND=/path/to/openshell` to point at a non-default CLI binary or wrapper script

### Live (real providers + real models)

- Command: `pnpm test:live`
- Config: `vitest.live.config.ts`
- Files: `src/**/*.live.test.ts`
- Default: **enabled** by `pnpm test:live` (sets `OPENCLAW_LIVE_TEST=1`)
- Scope:
  - “Does this provider/model actually work _today_ with real creds?”
  - Catch provider format changes, tool-calling quirks, auth issues, and rate limit behavior
- Expectations:
  - Not CI-stable by design (real networks, real provider policies, quotas, outages)
  - Costs money / uses rate limits
  - Prefer running narrowed subsets instead of “everything”
- Live runs source `~/.profile` to pick up missing API keys.
- By default, live runs still isolate `HOME` and copy config/auth material into a temp test home so unit fixtures cannot mutate your real `~/.openclaw`.
- Set `OPENCLAW_LIVE_USE_REAL_HOME=1` only when you intentionally need live tests to use your real home directory.
- `pnpm test:live` now defaults to a quieter mode: it keeps `[live] ...` progress output, but suppresses the extra `~/.profile` notice and mutes gateway bootstrap logs/Bonjour chatter. Set `OPENCLAW_LIVE_TEST_QUIET=0` if you want the full startup logs back.
- API key rotation (provider-specific): set `*_API_KEYS` with comma/semicolon format or `*_API_KEY_1`, `*_API_KEY_2` (for example `OPENAI_API_KEYS`, `ANTHROPIC_API_KEYS`, `GEMINI_API_KEYS`) or per-live override via `OPENCLAW_LIVE_*_KEY`; tests retry on rate limit responses.
- Progress/heartbeat output:
  - Live suites now emit progress lines to stderr so long provider calls are visibly active even when Vitest console capture is quiet.
  - `vitest.live.config.ts` disables Vitest console interception so provider/gateway progress lines stream immediately during live runs.
  - Tune direct-model heartbeats with `OPENCLAW_LIVE_HEARTBEAT_MS`.
  - Tune gateway/probe heartbeats with `OPENCLAW_LIVE_GATEWAY_HEARTBEAT_MS`.

## Which suite should I run?

Use this decision table:

- Editing logic/tests: run `pnpm test` (and `pnpm test:coverage` if you changed a lot)
- Touching gateway networking / WS protocol / pairing: add `pnpm test:e2e`
- Debugging “my bot is down” / provider-specific failures / tool calling: run a narrowed `pnpm test:live`

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
  - `OPENCLAW_LIVE_MODELS=modern` to run the modern allowlist (Opus/Sonnet 4.6+, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.7, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` is an alias for the modern allowlist
  - or `OPENCLAW_LIVE_MODELS="openai/gpt-5.4,anthropic/claude-opus-4-6,..."` (comma allowlist)
  - Modern/all sweeps default to a curated high-signal cap; set `OPENCLAW_LIVE_MAX_MODELS=0` for an exhaustive modern sweep or a positive number for a smaller cap.
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
  - Default: modern allowlist (Opus/Sonnet 4.6+, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.7, Grok 4)
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

Tip: to see what you can test on your machine (and the exact `provider/model` ids), run:

```bash
openclaw models list
openclaw models list --json
```

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
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.4"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` to send a real image attachment (paths are injected into the prompt).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` to pass image file paths as CLI args instead of prompt injection.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (or `"list"`) to control how image args are passed when `IMAGE_ARG` is set.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` to send a second turn and validate resume flow.
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE=0` to disable the default Claude Sonnet -> Opus same-session continuity probe (set to `1` to force it on when the selected model supports a switch target).

Example:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.4" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

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
  - `OPENCLAW_LIVE_ACP_BIND_AGENT=gemini`
  - `OPENCLAW_LIVE_ACP_BIND_AGENTS=claude,codex,gemini`
  - `OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND='npx -y @agentclientprotocol/claude-agent-acp@<version>'`
- Notes:
  - This lane uses the gateway `chat.send` surface with admin-only synthetic originating-route fields so tests can attach message-channel context without pretending to deliver externally.
  - When `OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND` is unset, the test uses the embedded `acpx` plugin's built-in agent registry for the selected ACP harness agent.

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
pnpm test:docker:live-acp-bind:gemini
```

Docker notes:

- The Docker runner lives at `scripts/test-live-acp-bind-docker.sh`.
- By default, it runs the ACP bind smoke against all supported live CLI agents in sequence: `claude`, `codex`, then `gemini`.
- Use `OPENCLAW_LIVE_ACP_BIND_AGENTS=claude`, `OPENCLAW_LIVE_ACP_BIND_AGENTS=codex`, or `OPENCLAW_LIVE_ACP_BIND_AGENTS=gemini` to narrow the matrix.
- It sources `~/.profile`, stages the matching CLI auth material into the container, installs `acpx` into a writable npm prefix, then installs the requested live CLI (`@anthropic-ai/claude-code`, `@openai/codex`, or `@google/gemini-cli`) if missing.
- Inside Docker, the runner sets `OPENCLAW_LIVE_ACP_BIND_ACPX_COMMAND=$HOME/.npm-global/bin/acpx` so acpx keeps provider env vars from the sourced profile available to the child harness CLI.

## Live: Codex app-server harness smoke

- Goal: validate the plugin-owned Codex harness through the normal gateway
  `agent` method:
  - load the bundled `codex` plugin
  - select `OPENCLAW_AGENT_RUNTIME=codex`
  - send a first gateway agent turn to `codex/gpt-5.4`
  - send a second turn to the same OpenClaw session and verify the app-server
    thread can resume
  - run `/codex status` and `/codex models` through the same gateway command
    path
- Test: `src/gateway/gateway-codex-harness.live.test.ts`
- Enable: `OPENCLAW_LIVE_CODEX_HARNESS=1`
- Default model: `codex/gpt-5.4`
- Optional image probe: `OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=1`
- Optional MCP/tool probe: `OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=1`
- The smoke sets `OPENCLAW_AGENT_HARNESS_FALLBACK=none` so a broken Codex
  harness cannot pass by silently falling back to PI.
- Auth: `OPENAI_API_KEY` from the shell/profile, plus optional copied
  `~/.codex/auth.json` and `~/.codex/config.toml`

Local recipe:

```bash
source ~/.profile
OPENCLAW_LIVE_CODEX_HARNESS=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=1 \
  OPENCLAW_LIVE_CODEX_HARNESS_MODEL=codex/gpt-5.4 \
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
- Docker enables the image and MCP/tool probes by default. Set
  `OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=0` or
  `OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=0` when you need a narrower debug run.
- Docker also exports `OPENCLAW_AGENT_HARNESS_FALLBACK=none`, matching the live
  test config so `openai-codex/*` or PI fallback cannot hide a Codex harness
  regression.

### Recommended live recipes

Narrow, explicit allowlists are fastest and least flaky:

- Single model, direct (no gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.4" pnpm test:live src/agents/models.profiles.live.test.ts`

- Single model, gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.4" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool calling across several providers:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.4,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/MiniMax-M2.7" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google focus (Gemini API key + Antigravity):
  - Gemini (API key): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

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

- OpenAI (non-Codex): `openai/gpt-5.4` (optional: `openai/gpt-5.4-mini`)
- OpenAI Codex: `openai-codex/gpt-5.4`
- Anthropic: `anthropic/claude-opus-4-6` (or `anthropic/claude-sonnet-4-6`)
- Google (Gemini API): `google/gemini-3.1-pro-preview` and `google/gemini-3-flash-preview` (avoid older Gemini 2.x models)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` and `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/MiniMax-M2.7`

Run gateway smoke with tools + image:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.4,openai-codex/gpt-5.4,anthropic/claude-opus-4-6,google/gemini-3.1-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/MiniMax-M2.7" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Baseline: tool calling (Read + optional Exec)

Pick at least one per provider family:

- OpenAI: `openai/gpt-5.4` (or `openai/gpt-5.4-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (or `anthropic/claude-sonnet-4-6`)
- Google: `google/gemini-3-flash-preview` (or `google/gemini-3.1-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
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

Tip: don’t try to hardcode “all models” in docs. The authoritative list is whatever `discoverModels(...)` returns on your machine + whatever keys are available.

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

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Enable: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## BytePlus coding plan live

- Test: `src/agents/byteplus.live.test.ts`
- Enable: `BYTEPLUS_API_KEY=... BYTEPLUS_LIVE_TEST=1 pnpm test:live src/agents/byteplus.live.test.ts`
- Optional model override: `BYTEPLUS_CODING_MODEL=ark-code-latest`

## ComfyUI workflow media live

- Test: `extensions/comfy/comfy.live.test.ts`
- Enable: `OPENCLAW_LIVE_TEST=1 COMFY_LIVE_TEST=1 pnpm test:live -- extensions/comfy/comfy.live.test.ts`
- Scope:
  - Exercises the bundled comfy image, video, and `music_generate` paths
  - Skips each capability unless `models.providers.comfy.<capability>` is configured
  - Useful after changing comfy workflow submission, polling, downloads, or plugin registration

## Image generation live

- Test: `src/image-generation/runtime.live.test.ts`
- Command: `pnpm test:live src/image-generation/runtime.live.test.ts`
- Harness: `pnpm test:live:media image`
- Scope:
  - Enumerates every registered image-generation provider plugin
  - Loads missing provider env vars from your login shell (`~/.profile`) before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in `auth-profiles.json` do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs the stock image-generation variants through the shared runtime capability:
    - `google:flash-generate`
    - `google:pro-generate`
    - `google:pro-edit`
    - `openai:default-generate`
- Current bundled providers covered:
  - `openai`
  - `google`
- Optional narrowing:
  - `OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS="openai,google"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_MODELS="openai/gpt-image-1,google/gemini-3.1-flash-image-preview"`
  - `OPENCLAW_LIVE_IMAGE_GENERATION_CASES="google:flash-generate,google:pro-edit"`
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

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
  - `OPENCLAW_LIVE_MUSIC_GENERATION_MODELS="google/lyria-3-clip-preview,minimax/music-2.5+"`
- Optional auth behavior:
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to force profile-store auth and ignore env-only overrides

## Video generation live

- Test: `extensions/video-generation-providers.live.test.ts`
- Enable: `OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/video-generation-providers.live.test.ts`
- Harness: `pnpm test:live:media video`
- Scope:
  - Exercises the shared bundled video-generation provider path
  - Loads provider env vars from your login shell (`~/.profile`) before probing
  - Uses live/env API keys ahead of stored auth profiles by default, so stale test keys in `auth-profiles.json` do not mask real shell credentials
  - Skips providers with no usable auth/profile/model
  - Runs both declared runtime modes when available:
    - `generate` with prompt-only input
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

## Docker runners (optional "works in Linux" checks)

These Docker runners split into two buckets:

- Live-model runners: `test:docker:live-models` and `test:docker:live-gateway` run only their matching profile-key live file inside the repo Docker image (`src/agents/models.profiles.live.test.ts` and `src/gateway/gateway-models.profiles.live.test.ts`), mounting your local config dir and workspace (and sourcing `~/.profile` if mounted). The matching local entrypoints are `test:live:models-profiles` and `test:live:gateway-profiles`.
- Docker live runners default to a smaller smoke cap so a full Docker sweep stays practical:
  `test:docker:live-models` defaults to `OPENCLAW_LIVE_MAX_MODELS=12`, and
  `test:docker:live-gateway` defaults to `OPENCLAW_LIVE_GATEWAY_SMOKE=1`,
  `OPENCLAW_LIVE_GATEWAY_MAX_MODELS=8`,
  `OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS=45000`, and
  `OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS=90000`. Override those env vars when you
  explicitly want the larger exhaustive scan.
- `test:docker:all` builds the live Docker image once via `test:docker:live-build`, then reuses it for the two live Docker lanes.
- Container smoke runners: `test:docker:openwebui`, `test:docker:onboard`, `test:docker:gateway-network`, `test:docker:mcp-channels`, and `test:docker:plugins` boot one or more real containers and verify higher-level integration paths.

The live-model Docker runners also bind-mount only the needed CLI auth homes (or all supported ones when the run is not narrowed), then copy them into the container home before the run so external-CLI OAuth can refresh tokens without mutating the host auth store:

- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- ACP bind smoke: `pnpm test:docker:live-acp-bind` (script: `scripts/test-live-acp-bind-docker.sh`)
- CLI backend smoke: `pnpm test:docker:live-cli-backend` (script: `scripts/test-live-cli-backend-docker.sh`)
- Codex app-server harness smoke: `pnpm test:docker:live-codex-harness` (script: `scripts/test-live-codex-harness-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Open WebUI live smoke: `pnpm test:docker:openwebui` (script: `scripts/e2e/openwebui-docker.sh`)
- Onboarding wizard (TTY, full scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Gateway networking (two containers, WS auth + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)
- MCP channel bridge (seeded Gateway + stdio bridge + raw Claude notification-frame smoke): `pnpm test:docker:mcp-channels` (script: `scripts/e2e/mcp-channels-docker.sh`)
- Plugins (install smoke + `/plugin` alias + Claude-bundle restart semantics): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)

The live-model Docker runners also bind-mount the current checkout read-only and
stage it into a temporary workdir inside the container. This keeps the runtime
image slim while still running Vitest against your exact local source/config.
The staging step skips large local-only caches and app build outputs such as
`.pnpm-store`, `.worktrees`, `__openclaw_vitest__`, and app-local `.build` or
Gradle output directories so Docker live runs do not spend minutes copying
machine-specific artifacts.
They also set `OPENCLAW_SKIP_CHANNELS=1` so gateway live probes do not start
real Telegram/Discord/etc. channel workers inside the container.
`test:docker:live-models` still runs `pnpm test:live`, so pass through
`OPENCLAW_LIVE_GATEWAY_*` as well when you need to narrow or exclude gateway
live coverage from that Docker lane.
`test:docker:openwebui` is a higher-level compatibility smoke: it starts an
OpenClaw gateway container with the OpenAI-compatible HTTP endpoints enabled,
starts a pinned Open WebUI container against that gateway, signs in through
Open WebUI, verifies `/api/models` exposes `openclaw/default`, then sends a
real chat request through Open WebUI's `/api/chat/completions` proxy.
The first run can be noticeably slower because Docker may need to pull the
Open WebUI image and Open WebUI may need to finish its own cold-start setup.
This lane expects a usable live model key, and `OPENCLAW_PROFILE_FILE`
(`~/.profile` by default) is the primary way to provide it in Dockerized runs.
Successful runs print a small JSON payload like `{ "ok": true, "model":
"openclaw/default", ... }`.
`test:docker:mcp-channels` is intentionally deterministic and does not need a
real Telegram, Discord, or iMessage account. It boots a seeded Gateway
container, starts a second container that spawns `openclaw mcp serve`, then
verifies routed conversation discovery, transcript reads, attachment metadata,
live event queue behavior, outbound send routing, and Claude-style channel +
permission notifications over the real stdio MCP bridge. The notification check
inspects the raw stdio MCP frames directly so the smoke validates what the
bridge actually emits, not just what a specific client SDK happens to surface.

Manual ACP plain-language thread smoke (not CI):

- `bun scripts/dev/discord-acp-plain-language-smoke.ts --channel <discord-channel-id> ...`
- Keep this script for regression/debug workflows. It may be needed again for ACP thread routing validation, so do not delete it.

Useful env vars:

- `OPENCLAW_CONFIG_DIR=...` (default: `~/.openclaw`) mounted to `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (default: `~/.openclaw/workspace`) mounted to `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (default: `~/.profile`) mounted to `/home/node/.profile` and sourced before running tests
- `OPENCLAW_DOCKER_CLI_TOOLS_DIR=...` (default: `~/.cache/openclaw/docker-cli-tools`) mounted to `/home/node/.npm-global` for cached CLI installs inside Docker
- External CLI auth dirs/files under `$HOME` are mounted read-only under `/host-auth...`, then copied into `/home/node/...` before tests start
  - Default dirs: `.minimax`
  - Default files: `~/.codex/auth.json`, `~/.codex/config.toml`, `.claude.json`, `~/.claude/.credentials.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json`
  - Narrowed provider runs mount only the needed dirs/files inferred from `OPENCLAW_LIVE_PROVIDERS` / `OPENCLAW_LIVE_GATEWAY_PROVIDERS`
  - Override manually with `OPENCLAW_DOCKER_AUTH_DIRS=all`, `OPENCLAW_DOCKER_AUTH_DIRS=none`, or a comma list like `OPENCLAW_DOCKER_AUTH_DIRS=.claude,.codex`
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` to narrow the run
- `OPENCLAW_LIVE_GATEWAY_PROVIDERS=...` / `OPENCLAW_LIVE_PROVIDERS=...` to filter providers in-container
- `OPENCLAW_SKIP_DOCKER_BUILD=1` to reuse an existing `openclaw:local-live` image for reruns that do not need a rebuild
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to ensure creds come from the profile store (not env)
- `OPENCLAW_OPENWEBUI_MODEL=...` to choose the model exposed by the gateway for the Open WebUI smoke
- `OPENCLAW_OPENWEBUI_PROMPT=...` to override the nonce-check prompt used by the Open WebUI smoke
- `OPENWEBUI_IMAGE=...` to override the pinned Open WebUI image tag

## Docs sanity

Run docs checks after doc edits: `pnpm check:docs`.
Run full Mintlify anchor validation when you need in-page heading checks too: `pnpm docs:check-links:anchors`.

## Offline regression (CI-safe)

These are “real pipeline” regressions without real providers:

- Gateway tool calling (mock OpenAI, real gateway + agent loop): `src/gateway/gateway.test.ts` (case: "runs a mock OpenAI tool call end-to-end via gateway agent loop")
- Gateway wizard (WS `wizard.start`/`wizard.next`, writes config + auth enforced): `src/gateway/gateway.test.ts` (case: "runs wizard over ws and writes auth token config")

## Agent reliability evals (skills)

We already have a few CI-safe tests that behave like “agent reliability evals”:

- Mock tool-calling through the real gateway + agent loop (`src/gateway/gateway.test.ts`).
- End-to-end wizard flows that validate session wiring and config effects (`src/gateway/gateway.test.ts`).

What’s still missing for skills (see [Skills](/tools/skills)):

- **Decisioning:** when skills are listed in the prompt, does the agent pick the right skill (or avoid irrelevant ones)?
- **Compliance:** does the agent read `SKILL.md` before use and follow required steps/args?
- **Workflow contracts:** multi-turn scenarios that assert tool order, session history carryover, and sandbox boundaries.

Future evals should stay deterministic first:

- A scenario runner using mock providers to assert tool calls + order, skill file reads, and session wiring.
- A small suite of skill-focused scenarios (use vs avoid, gating, prompt injection).
- Optional live evals (opt-in, env-gated) only after the CI-safe suite is in place.

## Contract tests (plugin and channel shape)

Contract tests verify that every registered plugin and channel conforms to its
interface contract. They iterate over all discovered plugins and run a suite of
shape and behavior assertions. The default `pnpm test` unit lane intentionally
skips these shared seam and smoke files; run the contract commands explicitly
when you touch shared channel or provider surfaces.

### Commands

- All contracts: `pnpm test:contracts`
- Channel contracts only: `pnpm test:contracts:channels`
- Provider contracts only: `pnpm test:contracts:plugins`

### Channel contracts

Located in `src/channels/plugins/contracts/*.contract.test.ts`:

- **plugin** - Basic plugin shape (id, name, capabilities)
- **setup** - Setup wizard contract
- **session-binding** - Session binding behavior
- **outbound-payload** - Message payload structure
- **inbound** - Inbound message handling
- **actions** - Channel action handlers
- **threading** - Thread ID handling
- **directory** - Directory/roster API
- **group-policy** - Group policy enforcement

### Provider status contracts

Located in `src/plugins/contracts/*.contract.test.ts`.

- **status** - Channel status probes
- **registry** - Plugin registry shape

### Provider contracts

Located in `src/plugins/contracts/*.contract.test.ts`:

- **auth** - Auth flow contract
- **auth-choice** - Auth choice/selection
- **catalog** - Model catalog API
- **discovery** - Plugin discovery
- **loader** - Plugin loading
- **runtime** - Provider runtime
- **shape** - Plugin shape/interface
- **wizard** - Setup wizard

### When to run

- After changing plugin-sdk exports or subpaths
- After adding or modifying a channel or provider plugin
- After refactoring plugin registration or discovery

Contract tests run in CI and do not require real API keys.

## Adding regressions (guidance)

When you fix a provider/model issue discovered in live:

- Add a CI-safe regression if possible (mock/stub provider, or capture the exact request-shape transformation)
- If it’s inherently live-only (rate limits, auth policies), keep the live test narrow and opt-in via env vars
- Prefer targeting the smallest layer that catches the bug:
  - provider request conversion/replay bug → direct models test
  - gateway session/history/tool pipeline bug → gateway live smoke or CI-safe gateway mock test
- SecretRef traversal guardrail:
  - `src/secrets/exec-secret-ref-id-parity.test.ts` derives one sampled target per SecretRef class from registry metadata (`listSecretTargetRegistryEntries()`), then asserts traversal-segment exec ids are rejected.
  - If you add a new `includeInPlan` SecretRef target family in `src/secrets/target-registry-data.ts`, update `classifyTargetClass` in that test. The test intentionally fails on unclassified target ids so new classes cannot be skipped silently.
