---
summary: "QA stack overview: qa-lab, qa-channel, repo-backed scenarios, live transport lanes, transport adapters, and reporting."
read_when:
  - Understanding how the QA stack fits together
  - Extending qa-lab, qa-channel, or a transport adapter
  - Adding repo-backed QA scenarios
  - Building higher-realism QA automation around the Gateway dashboard
title: "QA overview"
---

The private QA stack is meant to exercise OpenClaw in a more realistic,
channel-shaped way than a single unit test can.

Current pieces:

- `extensions/qa-channel`: synthetic message channel with DM, channel, thread,
  reaction, edit, and delete surfaces.
- `extensions/qa-lab`: debugger UI and QA bus for observing the transcript,
  injecting inbound messages, and exporting a Markdown report.
- `extensions/qa-matrix`, future runner plugins: live-transport adapters that
  drive a real channel inside a child QA gateway.
- `qa/`: repo-backed seed assets for the kickoff task and baseline QA
  scenarios.

## Command surface

Every QA flow runs under `pnpm openclaw qa <subcommand>`. Many have `pnpm qa:*`
script aliases; both forms are supported.

| Command                                             | Purpose                                                                                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qa run`                                            | Bundled QA self-check; writes a Markdown report.                                                                                                                       |
| `qa suite`                                          | Run repo-backed scenarios against the QA gateway lane. Aliases: `pnpm openclaw qa suite --runner multipass` for a disposable Linux VM.                                 |
| `qa coverage`                                       | Print the markdown scenario-coverage inventory (`--json` for machine output).                                                                                          |
| `qa parity-report`                                  | Compare two `qa-suite-summary.json` files and write the agentic parity report.                                                                                         |
| `qa character-eval`                                 | Run the character QA scenario across multiple live models with a judged report. See [Reporting](#reporting).                                                           |
| `qa manual`                                         | Run a one-off prompt against the selected provider/model lane.                                                                                                         |
| `qa ui`                                             | Start the QA debugger UI and local QA bus (alias: `pnpm qa:lab:ui`).                                                                                                   |
| `qa docker-build-image`                             | Build the prebaked QA Docker image.                                                                                                                                    |
| `qa docker-scaffold`                                | Write a docker-compose scaffold for the QA dashboard + gateway lane.                                                                                                   |
| `qa up`                                             | Build the QA site, start the Docker-backed stack, print the URL (alias: `pnpm qa:lab:up`; `:fast` variant adds `--use-prebuilt-image --bind-ui-dist --skip-ui-build`). |
| `qa aimock`                                         | Start only the AIMock provider server.                                                                                                                                 |
| `qa mock-openai`                                    | Start only the scenario-aware `mock-openai` provider server.                                                                                                           |
| `qa credentials doctor` / `add` / `list` / `remove` | Manage the shared Convex credential pool.                                                                                                                              |
| `qa matrix`                                         | Live transport lane against a disposable Tuwunel homeserver. See [Matrix QA](/concepts/qa-matrix).                                                                     |
| `qa telegram`                                       | Live transport lane against a real private Telegram group.                                                                                                             |
| `qa discord`                                        | Live transport lane against a real private Discord guild channel.                                                                                                      |

## Operator flow

The current QA operator flow is a two-pane QA site:

- Left: Gateway dashboard (Control UI) with the agent.
- Right: QA Lab, showing the Slack-ish transcript and scenario plan.

Run it with:

```bash
pnpm qa:lab:up
```

That builds the QA site, starts the Docker-backed gateway lane, and exposes the
QA Lab page where an operator or automation loop can give the agent a QA
mission, observe real channel behavior, and record what worked, failed, or
stayed blocked.

For faster QA Lab UI iteration without rebuilding the Docker image each time,
start the stack with a bind-mounted QA Lab bundle:

```bash
pnpm openclaw qa docker-build-image
pnpm qa:lab:build
pnpm qa:lab:up:fast
pnpm qa:lab:watch
```

`qa:lab:up:fast` keeps the Docker services on a prebuilt image and bind-mounts
`extensions/qa-lab/web/dist` into the `qa-lab` container. `qa:lab:watch`
rebuilds that bundle on change, and the browser auto-reloads when the QA Lab
asset hash changes.

For a local OpenTelemetry trace smoke, run:

```bash
pnpm qa:otel:smoke
```

That script starts a local OTLP/HTTP trace receiver, runs the
`otel-trace-smoke` QA scenario with the `diagnostics-otel` plugin enabled, then
decodes the exported protobuf spans and asserts the release-critical shape:
`openclaw.run`, `openclaw.harness.run`, `openclaw.model.call`,
`openclaw.context.assembled`, and `openclaw.message.delivery` must be present;
model calls must not export `StreamAbandoned` on successful turns; raw diagnostic IDs and
`openclaw.content.*` attributes must stay out of the trace. It writes
`otel-smoke-summary.json` next to the QA suite artifacts.

Observability QA stays source-checkout only. The npm tarball intentionally omits
QA Lab, so package Docker release lanes do not run `qa` commands. Use
`pnpm qa:otel:smoke` from a built source checkout when changing diagnostics
instrumentation.

For a transport-real Matrix smoke lane, run:

```bash
pnpm openclaw qa matrix --profile fast --fail-fast
```

The full CLI reference, profile/scenario catalog, env vars, and artifact layout for this lane live in [Matrix QA](/concepts/qa-matrix). At a glance: it provisions a disposable Tuwunel homeserver in Docker, registers temporary driver/SUT/observer users, runs the real Matrix plugin inside a child QA gateway scoped to that transport (no `qa-channel`), then writes a Markdown report, JSON summary, observed-events artifact, and combined output log under `.artifacts/qa-e2e/matrix-<timestamp>/`.

For transport-real Telegram and Discord smoke lanes:

```bash
pnpm openclaw qa telegram
pnpm openclaw qa discord
```

Both target a pre-existing real channel with two bots (driver + SUT). Required env vars, scenario lists, output artifacts, and the Convex credential pool are documented in [Telegram and Discord QA reference](#telegram-and-discord-qa-reference) below.

Before using pooled live credentials, run:

```bash
pnpm openclaw qa credentials doctor
```

The doctor checks Convex broker env, validates endpoint settings, and verifies admin/list reachability when the maintainer secret is present. It reports only set/missing status for secrets.

## Live transport coverage

Live transport lanes share one contract instead of each inventing their own scenario list shape. `qa-channel` is the broad synthetic product-behavior suite and is not part of the live transport coverage matrix.

| Lane     | Canary | Mention gating | Bot-to-bot | Allowlist block | Top-level reply | Restart resume | Thread follow-up | Thread isolation | Reaction observation | Help command | Native command registration |
| -------- | ------ | -------------- | ---------- | --------------- | --------------- | -------------- | ---------------- | ---------------- | -------------------- | ------------ | --------------------------- |
| Matrix   | x      | x              | x          | x               | x               | x              | x                | x                | x                    |              |                             |
| Telegram | x      | x              | x          |                 |                 |                |                  |                  |                      | x            |                             |
| Discord  | x      | x              | x          |                 |                 |                |                  |                  |                      |              | x                           |

This keeps `qa-channel` as the broad product-behavior suite while Matrix,
Telegram, and future live transports share one explicit transport-contract
checklist.

For a disposable Linux VM lane without bringing Docker into the QA path, run:

```bash
pnpm openclaw qa suite --runner multipass --scenario channel-chat-baseline
```

This boots a fresh Multipass guest, installs dependencies, builds OpenClaw
inside the guest, runs `qa suite`, then copies the normal QA report and
summary back into `.artifacts/qa-e2e/...` on the host.
It reuses the same scenario-selection behavior as `qa suite` on the host.
Host and Multipass suite runs execute multiple selected scenarios in parallel
with isolated gateway workers by default. `qa-channel` defaults to concurrency
4, capped by the selected scenario count. Use `--concurrency <count>` to tune
the worker count, or `--concurrency 1` for serial execution.
The command exits non-zero when any scenario fails. Use `--allow-failures` when
you want artifacts without a failing exit code.
Live runs forward the supported QA auth inputs that are practical for the
guest: env-based provider keys, the QA live provider config path, and
`CODEX_HOME` when present. Keep `--output-dir` under the repo root so the guest
can write back through the mounted workspace.

## Telegram and Discord QA reference

Matrix has a [dedicated page](/concepts/qa-matrix) because of its scenario count and Docker-backed homeserver provisioning. Telegram and Discord are smaller — a handful of scenarios each, no profile system, against pre-existing real channels — so their reference lives here.

### Shared CLI flags

Both lanes register through `extensions/qa-lab/src/live-transports/shared/live-transport-cli.ts` and accept the same flags:

| Flag                                  | Default                                                   | Description                                                                                                           |
| ------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--scenario <id>`                     | —                                                         | Run only this scenario. Repeatable.                                                                                   |
| `--output-dir <path>`                 | `<repo>/.artifacts/qa-e2e/{telegram,discord}-<timestamp>` | Where reports/summary/observed messages and the output log are written. Relative paths resolve against `--repo-root`. |
| `--repo-root <path>`                  | `process.cwd()`                                           | Repository root when invoking from a neutral cwd.                                                                     |
| `--sut-account <id>`                  | `sut`                                                     | Temporary account id inside the QA gateway config.                                                                    |
| `--provider-mode <mode>`              | `live-frontier`                                           | `mock-openai` or `live-frontier` (legacy `live-openai` still works).                                                  |
| `--model <ref>` / `--alt-model <ref>` | provider default                                          | Primary/alternate model refs.                                                                                         |
| `--fast`                              | off                                                       | Provider fast mode where supported.                                                                                   |
| `--credential-source <env\|convex>`   | `env`                                                     | See [Convex credential pool](#convex-credential-pool).                                                                |
| `--credential-role <maintainer\|ci>`  | `ci` in CI, `maintainer` otherwise                        | Role used when `--credential-source convex`.                                                                          |

Both exit non-zero on any failed scenario. `--allow-failures` writes artifacts without setting a failing exit code.

### Telegram QA

```bash
pnpm openclaw qa telegram
```

Targets one real private Telegram group with two distinct bots (driver + SUT). The SUT bot must have a Telegram username; bot-to-bot observation works best when both bots have **Bot-to-Bot Communication Mode** enabled in `@BotFather`.

Required env when `--credential-source env`:

- `OPENCLAW_QA_TELEGRAM_GROUP_ID` — numeric chat id (string).
- `OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN`

Optional:

- `OPENCLAW_QA_TELEGRAM_CAPTURE_CONTENT=1` keeps message bodies in observed-message artifacts (default redacts).

Scenarios (`extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts:44`):

- `telegram-canary`
- `telegram-mention-gating`
- `telegram-mentioned-message-reply`
- `telegram-help-command`
- `telegram-commands-command`
- `telegram-tools-compact-command`
- `telegram-whoami-command`
- `telegram-context-command`

Output artifacts:

- `telegram-qa-report.md`
- `telegram-qa-summary.json` — includes per-reply RTT (driver send → observed SUT reply) starting with the canary.
- `telegram-qa-observed-messages.json` — bodies redacted unless `OPENCLAW_QA_TELEGRAM_CAPTURE_CONTENT=1`.

### Discord QA

```bash
pnpm openclaw qa discord
```

Targets one real private Discord guild channel with two bots: a driver bot controlled by the harness and a SUT bot started by the child OpenClaw gateway through the bundled Discord plugin. Verifies channel mention handling and that the SUT bot has registered the native `/help` command with Discord.

Required env when `--credential-source env`:

- `OPENCLAW_QA_DISCORD_GUILD_ID`
- `OPENCLAW_QA_DISCORD_CHANNEL_ID`
- `OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID` — must match the SUT bot user id returned by Discord (the lane fails fast otherwise).

Optional:

- `OPENCLAW_QA_DISCORD_CAPTURE_CONTENT=1` keeps message bodies in observed-message artifacts.

Scenarios (`extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:36`):

- `discord-canary`
- `discord-mention-gating`
- `discord-native-help-command-registration`

Output artifacts:

- `discord-qa-report.md`
- `discord-qa-summary.json`
- `discord-qa-observed-messages.json` — bodies redacted unless `OPENCLAW_QA_DISCORD_CAPTURE_CONTENT=1`.

### Convex credential pool

Both Telegram and Discord lanes can lease credentials from a shared Convex pool instead of reading the env vars above. Pass `--credential-source convex` (or set `OPENCLAW_QA_CREDENTIAL_SOURCE=convex`); QA Lab acquires an exclusive lease, heartbeats it for the duration of the run, and releases it on shutdown. Pool kinds are `"telegram"` and `"discord"`.

Payload shapes the broker validates on `admin/add`:

- Telegram (`kind: "telegram"`): `{ groupId: string, driverToken: string, sutToken: string }` — `groupId` must be a numeric chat-id string.
- Discord (`kind: "discord"`): `{ guildId: string, channelId: string, driverBotToken: string, sutBotToken: string, sutApplicationId: string }`.

Operational env vars and the Convex broker endpoint contract live in [Testing → Shared Telegram credentials via Convex](/help/testing#shared-telegram-credentials-via-convex-v1) (the section name predates Discord support; the broker semantics are identical for both kinds).

## Repo-backed seeds

Seed assets live in `qa/`:

- `qa/scenarios/index.md`
- `qa/scenarios/<theme>/*.md`

These are intentionally in git so the QA plan is visible to both humans and the
agent.

`qa-lab` should stay a generic markdown runner. Each scenario markdown file is
the source of truth for one test run and should define:

- scenario metadata
- optional category, capability, lane, and risk metadata
- docs and code refs
- optional plugin requirements
- optional gateway config patch
- the executable `qa-flow`

The reusable runtime surface that backs `qa-flow` is allowed to stay generic
and cross-cutting. For example, markdown scenarios can combine transport-side
helpers with browser-side helpers that drive the embedded Control UI through the
Gateway `browser.request` seam without adding a special-case runner.

Scenario files should be grouped by product capability rather than source tree
folder. Keep scenario IDs stable when files move; use `docsRefs` and `codeRefs`
for implementation traceability.

The baseline list should stay broad enough to cover:

- DM and channel chat
- thread behavior
- message action lifecycle
- cron callbacks
- memory recall
- model switching
- subagent handoff
- repo-reading and docs-reading
- one small build task such as Lobster Invaders

## Provider mock lanes

`qa suite` has two local provider mock lanes:

- `mock-openai` is the scenario-aware OpenClaw mock. It remains the default
  deterministic mock lane for repo-backed QA and parity gates.
- `aimock` starts an AIMock-backed provider server for experimental protocol,
  fixture, record/replay, and chaos coverage. It is additive and does not
  replace the `mock-openai` scenario dispatcher.

Provider-lane implementation lives under `extensions/qa-lab/src/providers/`.
Each provider owns its defaults, local server startup, gateway model config,
auth-profile staging needs, and live/mock capability flags. Shared suite and
gateway code should route through the provider registry instead of branching on
provider names.

## Transport adapters

`qa-lab` owns a generic transport seam for markdown QA scenarios. `qa-channel` is the first adapter on that seam, but the design target is wider: future real or synthetic channels should plug into the same suite runner instead of adding a transport-specific QA runner.

At the architecture level, the split is:

- `qa-lab` owns generic scenario execution, worker concurrency, artifact writing, and reporting.
- The transport adapter owns gateway config, readiness, inbound and outbound observation, transport actions, and normalized transport state.
- Markdown scenario files under `qa/scenarios/` define the test run; `qa-lab` provides the reusable runtime surface that executes them.

### Adding a channel

Adding a channel to the markdown QA system requires exactly two things:

1. A transport adapter for the channel.
2. A scenario pack that exercises the channel contract.

Do not add a new top-level QA command root when the shared `qa-lab` host can own the flow.

`qa-lab` owns the shared host mechanics:

- the `openclaw qa` command root
- suite startup and teardown
- worker concurrency
- artifact writing
- report generation
- scenario execution
- compatibility aliases for older `qa-channel` scenarios

Runner plugins own the transport contract:

- how `openclaw qa <runner>` is mounted beneath the shared `qa` root
- how the gateway is configured for that transport
- how readiness is checked
- how inbound events are injected
- how outbound messages are observed
- how transcripts and normalized transport state are exposed
- how transport-backed actions are executed
- how transport-specific reset or cleanup is handled

The minimum adoption bar for a new channel:

1. Keep `qa-lab` as the owner of the shared `qa` root.
2. Implement the transport runner on the shared `qa-lab` host seam.
3. Keep transport-specific mechanics inside the runner plugin or channel harness.
4. Mount the runner as `openclaw qa <runner>` instead of registering a competing root command. Runner plugins should declare `qaRunners` in `openclaw.plugin.json` and export a matching `qaRunnerCliRegistrations` array from `runtime-api.ts`. Keep `runtime-api.ts` light; lazy CLI and runner execution should stay behind separate entrypoints.
5. Author or adapt markdown scenarios under the themed `qa/scenarios/` directories.
6. Use the generic scenario helpers for new scenarios.
7. Keep existing compatibility aliases working unless the repo is doing an intentional migration.

The decision rule is strict:

- If behavior can be expressed once in `qa-lab`, put it in `qa-lab`.
- If behavior depends on one channel transport, keep it in that runner plugin or plugin harness.
- If a scenario needs a new capability that more than one channel can use, add a generic helper instead of a channel-specific branch in `suite.ts`.
- If a behavior is only meaningful for one transport, keep the scenario transport-specific and make that explicit in the scenario contract.

### Scenario helper names

Preferred generic helpers for new scenarios:

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

Compatibility aliases remain available for existing scenarios — `waitForQaChannelReady`, `waitForOutboundMessage`, `waitForNoOutbound`, `formatConversationTranscript`, `resetBus` — but new scenario authoring should use the generic names. The aliases exist to avoid a flag-day migration, not as the model going forward.

## Reporting

`qa-lab` exports a Markdown protocol report from the observed bus timeline.
The report should answer:

- What worked
- What failed
- What stayed blocked
- What follow-up scenarios are worth adding

For the inventory of available scenarios — useful when sizing follow-up work or wiring a new transport — run `pnpm openclaw qa coverage` (add `--json` for machine-readable output).

For character and style checks, run the same scenario across multiple live model
refs and write a judged Markdown report:

```bash
pnpm openclaw qa character-eval \
  --model openai/gpt-5.5,thinking=medium,fast \
  --model openai/gpt-5.2,thinking=xhigh \
  --model openai/gpt-5,thinking=xhigh \
  --model anthropic/claude-opus-4-6,thinking=high \
  --model anthropic/claude-sonnet-4-6,thinking=high \
  --model zai/glm-5.1,thinking=high \
  --model moonshot/kimi-k2.5,thinking=high \
  --model google/gemini-3.1-pro-preview,thinking=high \
  --judge-model openai/gpt-5.5,thinking=xhigh,fast \
  --judge-model anthropic/claude-opus-4-6,thinking=high \
  --blind-judge-models \
  --concurrency 16 \
  --judge-concurrency 16
```

The command runs local QA gateway child processes, not Docker. Character eval
scenarios should set the persona through `SOUL.md`, then run ordinary user turns
such as chat, workspace help, and small file tasks. The candidate model should
not be told that it is being evaluated. The command preserves each full
transcript, records basic run stats, then asks the judge models in fast mode with
`xhigh` reasoning where supported to rank the runs by naturalness, vibe, and humor.
Use `--blind-judge-models` when comparing providers: the judge prompt still gets
every transcript and run status, but candidate refs are replaced with neutral
labels such as `candidate-01`; the report maps rankings back to real refs after
parsing.
Candidate runs default to `high` thinking, with `medium` for GPT-5.5 and `xhigh`
for older OpenAI eval refs that support it. Override a specific candidate inline with
`--model provider/model,thinking=<level>`. `--thinking <level>` still sets a
global fallback, and the older `--model-thinking <provider/model=level>` form is
kept for compatibility.
OpenAI candidate refs default to fast mode so priority processing is used where
the provider supports it. Add `,fast`, `,no-fast`, or `,fast=false` inline when a
single candidate or judge needs an override. Pass `--fast` only when you want to
force fast mode on for every candidate model. Candidate and judge durations are
recorded in the report for benchmark analysis, but judge prompts explicitly say
not to rank by speed.
Candidate and judge model runs both default to concurrency 16. Lower
`--concurrency` or `--judge-concurrency` when provider limits or local gateway
pressure make a run too noisy.
When no candidate `--model` is passed, the character eval defaults to
`openai/gpt-5.5`, `openai/gpt-5.2`, `openai/gpt-5`, `anthropic/claude-opus-4-6`,
`anthropic/claude-sonnet-4-6`, `zai/glm-5.1`,
`moonshot/kimi-k2.5`, and
`google/gemini-3.1-pro-preview` when no `--model` is passed.
When no `--judge-model` is passed, the judges default to
`openai/gpt-5.5,thinking=xhigh,fast` and
`anthropic/claude-opus-4-6,thinking=high`.

## Related docs

- [Matrix QA](/concepts/qa-matrix)
- [QA Channel](/channels/qa-channel)
- [Testing](/help/testing)
- [Dashboard](/web/dashboard)
