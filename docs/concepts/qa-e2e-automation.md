---
summary: "QA stack overview: qa-lab, qa-channel, repo-backed scenarios, live transport lanes, transport adapters, and reporting."
read_when:
  - Understanding how the QA stack fits together
  - Extending qa-lab, qa-channel, or a transport adapter
  - Adding repo-backed QA scenarios
  - Building higher-realism QA automation around the Gateway dashboard
title: "QA overview"
---

The private QA stack exercises OpenClaw in a realistic, channel-shaped way that
a unit test cannot.

Pieces:

- `extensions/qa-channel`: synthetic message channel with DM, channel, thread,
  reaction, edit, and delete surfaces.
- `extensions/qa-lab`: debugger UI and QA bus for observing the transcript,
  injecting inbound messages, and exporting a Markdown report.
- `extensions/qa-matrix`: live-transport adapter that drives the real Matrix
  plugin inside a child QA gateway.
- `qa/`: repo-backed seed assets for the kickoff task and baseline QA
  scenarios.
- [Mantis](/concepts/mantis): before/after live verification for bugs that
  need real transports, browser screenshots, VM state, and PR evidence.

## Command surface

Every QA flow runs under `pnpm openclaw qa <subcommand>`. Many have `pnpm qa:*`
script aliases; both forms work.

| Command                                             | Purpose                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qa run`                                            | Bundled QA self-check without `--qa-profile`; taxonomy-backed maturity profile runner with `--qa-profile smoke-ci`, `--qa-profile release`, or `--qa-profile all`.                                                                                                  |
| `qa suite`                                          | Run repo-backed scenarios against the QA gateway lane. `--runner multipass` uses a disposable Linux VM instead of the host.                                                                                                                                         |
| `qa coverage`                                       | Print the YAML scenario-coverage inventory (`--json` for machine output; `--match <query>` to find scenarios for a touched behavior; `--tools` for runtime tool fixture coverage).                                                                                  |
| `qa parity-report`                                  | Compare two `qa-suite-summary.json` files for a model-axis parity gate, or use `--runtime-axis --token-efficiency` to write Codex-vs-OpenClaw runtime parity and token-efficiency reports.                                                                          |
| `qa confidence-report`                              | Classify QA proof artifacts against a manifest into a zero-unknown confidence report.                                                                                                                                                                               |
| `qa confidence-self-test`                           | Write seeded negative-control canaries proving the confidence gate detects drift.                                                                                                                                                                                   |
| `qa jsonl-replay`                                   | Replay curated JSONL transcripts through the runtime parity replay harness.                                                                                                                                                                                         |
| `qa character-eval`                                 | Run the character QA scenario across multiple live models with a judged report. See [Reporting](#reporting).                                                                                                                                                        |
| `qa manual`                                         | Run a one-off prompt against the selected provider/model lane.                                                                                                                                                                                                      |
| `qa ui`                                             | Start the QA debugger UI and local QA bus (alias: `pnpm qa:lab:ui`).                                                                                                                                                                                                |
| `qa docker-build-image`                             | Build the prebaked QA Docker image.                                                                                                                                                                                                                                 |
| `qa docker-scaffold`                                | Write a docker-compose scaffold for the QA dashboard + gateway lane.                                                                                                                                                                                                |
| `qa up`                                             | Build the QA site, start the Docker-backed stack, print the URL (alias: `pnpm qa:lab:up`; `:fast` variant adds `--use-prebuilt-image --bind-ui-dist --skip-ui-build`).                                                                                              |
| `qa aimock`                                         | Start only the AIMock provider server.                                                                                                                                                                                                                              |
| `qa mock-openai`                                    | Start only the scenario-aware `mock-openai` provider server.                                                                                                                                                                                                        |
| `qa credentials doctor` / `add` / `list` / `remove` | Manage the shared Convex credential pool.                                                                                                                                                                                                                           |
| `qa discord`                                        | Live transport lane against a real private Discord guild channel.                                                                                                                                                                                                   |
| `qa matrix`                                         | Live transport lane against a disposable Tuwunel homeserver. See [Matrix QA](/concepts/qa-matrix).                                                                                                                                                                  |
| `qa slack`                                          | Live transport lane against a real private Slack channel.                                                                                                                                                                                                           |
| `qa telegram`                                       | Live transport lane against a real private Telegram group.                                                                                                                                                                                                          |
| `qa whatsapp`                                       | Live transport lane against real WhatsApp Web accounts.                                                                                                                                                                                                             |
| `qa mantis`                                         | Before/after verification runner for live transport bugs, with Discord status-reactions evidence, Crabbox desktop/browser smoke, and Slack-in-VNC smoke. See [Mantis](/concepts/mantis) and [Mantis Slack Desktop Runbook](/concepts/mantis-slack-desktop-runbook). |

`qa matrix` is registered as a runner plugin (`extensions/qa-matrix`); every
other lane above is built into `qa-lab` directly.

### Profile-backed `qa run`

Profile-backed `qa run` reads membership from `taxonomy.yaml`, then dispatches
the resolved scenarios through `qa suite`. `--surface` and `--category` filter
the selected profile instead of defining separate lanes. The resulting
`qa-evidence.json` includes a profile scorecard summary with selected-category
counts and missing coverage IDs; the individual evidence entries remain the
source of truth for the tests, coverage roles, and results. Taxonomy feature
coverage IDs are exact proof targets, not aliases: primary scenario coverage
fulfills matching IDs, secondary coverage stays advisory. Coverage IDs use
dotted `namespace.behavior` form with lowercase alphanumeric/dash segments;
profile, surface, and category IDs may still use the existing dashed or dotted
taxonomy IDs.

Slim evidence omits per-entry `execution` and sets `evidenceMode: "slim"`;
`smoke-ci` defaults to slim, and `--evidence-mode full` restores full entries:

```bash
pnpm openclaw qa run \
  --qa-profile smoke-ci \
  --category channel-framework.conversation-routing-and-delivery \
  --provider-mode mock-openai \
  --output-dir .artifacts/qa-e2e/smoke-ci-profile-dispatch
```

Use `smoke-ci` for deterministic profile proof with mock model providers and
Crabline local provider servers. Use `release` for Stable/LTS proof against
live channels. Use `all` only for explicit full-taxonomy evidence runs; it
selects every active maturity category and can be dispatched through the `QA
Profile Evidence` GitHub Actions workflow with `qa_profile=all`. When a
command also needs an OpenClaw root profile, put the root profile before the
QA command:

```bash
pnpm openclaw --profile work qa run --qa-profile smoke-ci
```

## Operator flow

The current QA operator flow is a two-pane QA site:

- Left: Gateway dashboard (Control UI) with the agent.
- Right: QA Lab, showing the Slack-ish transcript and scenario plan.

Run it with:

```bash
pnpm qa:lab:up
```

That builds the QA site, starts the Docker-backed gateway lane, and exposes
the QA Lab page where an operator or automation loop can give the agent a QA
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

`qa:lab:up:fast` keeps the Docker services on a prebuilt image and
bind-mounts `extensions/qa-lab/web/dist` into the `qa-lab` container.
`qa:lab:watch` rebuilds that bundle on change, and the browser auto-reloads
when the QA Lab asset hash changes.

### Observability smokes

<Note>
Observability QA stays source-checkout only. The npm tarball intentionally
omits QA Lab (and `qa-channel`/`qa-matrix`), so package Docker release lanes
do not run `qa` commands. Run these from a built source checkout when
changing diagnostics instrumentation.
</Note>

| Alias                                   | What it runs                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm qa:otel:smoke`                    | Local OpenTelemetry receiver plus the `otel-trace-smoke` scenario with `diagnostics-otel` enabled.                                      |
| `pnpm qa:otel:collector-smoke`          | Same lane behind a real OpenTelemetry Collector Docker container. Use it when changing endpoint wiring or collector/OTLP compatibility. |
| `pnpm qa:prometheus:smoke`              | The `docker-prometheus-smoke` scenario with `diagnostics-prometheus` enabled.                                                           |
| `pnpm qa:observability:smoke`           | `qa:otel:smoke` followed by `qa:prometheus:smoke`.                                                                                      |
| `pnpm qa:observability:collector-smoke` | `qa:otel:collector-smoke` followed by `qa:prometheus:smoke`.                                                                            |

`qa:otel:smoke` starts a local OTLP/HTTP receiver, runs a minimal QA-channel
agent turn, then asserts traces, metrics, and logs are exported. It decodes
the exported protobuf trace spans and checks the release-critical shape:
`openclaw.run`, `openclaw.harness.run`, a latest GenAI semantic-convention
model-call span, `openclaw.context.assembled`, and `openclaw.message.delivery`
must all be present. The smoke forces
`OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`, so the model-call
span must use the `{gen_ai.operation.name} {gen_ai.request.model}` name; model
calls must not export `StreamAbandoned` on successful turns; raw diagnostic
IDs and `openclaw.content.*` attributes must stay out of the trace. The scenario
prompt asks the model to reply with a fixed marker and to withhold a fixed
secret string; the raw OTLP payloads must not contain either, or the QA
session key derived from the scenario id. It writes `otel-smoke-summary.json`
next to the QA suite artifacts.

`qa:prometheus:smoke` verifies unauthenticated scrapes are rejected, then
checks the authenticated scrape includes release-critical metric families
without prompt content, response content, raw diagnostic identifiers, auth
tokens, or local paths.

### Matrix smoke lanes

For a transport-real Matrix smoke lane that does not require model-provider
credentials, run the fast profile with the deterministic mock OpenAI provider:

```bash
OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS=3000 \
  pnpm openclaw qa matrix --provider-mode mock-openai --profile fast --fail-fast
```

For the live-frontier provider lane, supply OpenAI-compatible credentials
explicitly:

```bash
OPENCLAW_LIVE_OPENAI_KEY="${OPENAI_API_KEY}" \
OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS=3000 \
  pnpm openclaw qa matrix --provider-mode live-frontier --profile fast --fail-fast
```

The full CLI reference, profile/scenario catalog, env vars, and artifact
layout for this lane live in [Matrix QA](/concepts/qa-matrix). At a glance: it
provisions a disposable Tuwunel homeserver in Docker, registers temporary
driver/SUT/observer users, runs the real Matrix plugin inside a child QA
gateway scoped to that transport (no `qa-channel`), then writes a Markdown
report, JSON summary, observed-events artifact, and combined output log under
`.artifacts/qa-e2e/matrix-<timestamp>/`.

The scenarios cover transport behavior that unit tests cannot prove end to
end: mention gating, allow-bot policies, allowlists, top-level and threaded
replies, DM routing, reaction handling, inbound edit suppression, restart
replay dedupe, homeserver interruption recovery, approval metadata delivery,
media handling, and Matrix E2EE bootstrap/recovery/verification flows. The
E2EE CLI profile also drives `openclaw matrix encryption setup` and
verification commands through the same disposable homeserver before checking
gateway replies.

CI uses the same command surface in
`.github/workflows/qa-live-transports-convex.yml`. Scheduled and default
manual runs execute the fast Matrix profile with QA-provided live-frontier
credentials, `--fast`, and `OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS=3000`.
Manual `matrix_profile=all` fans out into five profile shards: `transport`,
`media`, `e2ee-smoke`, `e2ee-deep`, and `e2ee-cli`.

### Discord Mantis scenarios

Discord also has Mantis-only opt-in scenarios for bug reproduction. Use
`--scenario discord-status-reactions-tool-only` for the explicit status
reaction timeline, or `--scenario discord-thread-reply-filepath-attachment`
to create a real Discord thread and verify that `message.thread-reply`
preserves a `filePath` attachment. These scenarios stay out of the default
live Discord lane because they are before/after repro probes rather than
broad smoke coverage. The thread-attachment Mantis workflow can also add a
logged-in Discord Web witness video when
`MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR` or
`MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64` is configured in the QA
environment. That viewer profile is only for visual capture; the pass/fail
decision still comes from the Discord REST oracle.

For transport-real Discord, Slack, Telegram, and WhatsApp smoke lanes:

```bash
pnpm openclaw qa discord
pnpm openclaw qa slack
pnpm openclaw qa telegram
pnpm openclaw qa whatsapp
```

They target a pre-existing real channel with two bots or accounts (driver +
SUT). Required env vars, scenario lists, output artifacts, and the Convex
credential pool are documented in
[Discord, Slack, Telegram, and WhatsApp QA reference](#discord-slack-telegram-and-whatsapp-qa-reference)
below.

### Mantis Slack desktop and visual-task runners

For a full Slack desktop VM run with VNC rescue, run:

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --gateway-setup \
  --scenario slack-canary \
  --keep-lease
```

That command leases a Crabbox desktop/browser machine, runs the Slack live
lane inside the VM, opens Slack Web in the VNC browser, captures the desktop,
and copies `slack-qa/`, `slack-desktop-smoke.png`, and
`slack-desktop-smoke.mp4` (when video capture is available) back to the
Mantis artifact directory. Crabbox desktop/browser leases provide the capture
tools and browser/native-build helper packages up front, so the scenario
should only install fallbacks on older leases. Mantis reports total and
per-phase timings in `mantis-slack-desktop-smoke-report.md` so slow runs show
whether time went into lease warmup, credential acquisition, remote setup, or
artifact copy. Reuse `--lease-id <cbx_...>` after logging in to Slack Web
manually through VNC; reused leases also keep Crabbox's pnpm store cache
warm. The default `--hydrate-mode source` verifies from a source checkout and
runs install/build inside the VM. Use `--hydrate-mode prehydrated` only when
the reused remote workspace already has `node_modules` and a built `dist/`;
that mode skips the expensive install/build step and fails closed when the
workspace is not ready. With `--gateway-setup`, Mantis leaves a persistent
OpenClaw Slack gateway running inside the VM on port `38973`; without it, the
command runs the normal bot-to-bot Slack QA lane and exits after artifact
capture.

To prove native Slack approval UI with desktop evidence, run the Mantis
approval checkpoint mode:

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --approval-checkpoints \
  --credential-source convex \
  --credential-role maintainer
```

This mode is mutually exclusive with `--gateway-setup`. It runs the Slack
approval scenarios, rejects non-approval scenario ids, waits at each pending
and resolved approval state, renders the observed Slack API message into
`approval-checkpoints/<scenario>-pending.png` and
`approval-checkpoints/<scenario>-resolved.png`, then fails if any checkpoint,
message evidence, acknowledgement, or rendered screenshot is missing or
empty. Cold CI leases may still show Slack sign-in in
`slack-desktop-smoke.png`; the approval checkpoint images are the visual
proof for this lane.

The default checkpoint run keeps the two standard Slack approval scenarios.
To capture either opt-in Codex approval route, select it explicitly with
`--scenario slack-codex-approval-exec-native` or
`--scenario slack-codex-approval-plugin-native`; Mantis accepts both and emits
the same pending/resolved screenshot pair. The runner expands its checkpoint
and remote-command deadlines for each selected Codex route so the full
approval, agent completion, and resolved-update sequence can finish.

The operator checklist, GitHub workflow dispatch command, evidence-comment
contract, hydrate-mode decision table, timing interpretation, and failure
handling steps live in
[Mantis Slack Desktop Runbook](/concepts/mantis-slack-desktop-runbook).

For an agent/CV style desktop task, run:

```bash
pnpm openclaw qa mantis visual-task \
  --browser-url https://example.net \
  --expect-text "Example Domain" \
  --vision-model openai/gpt-5.6-luna
```

`visual-task` leases or reuses a Crabbox desktop/browser machine, starts
`crabbox record --while`, drives the visible browser through a nested
`visual-driver`, captures `visual-task.png`, runs `openclaw infer image
describe` against the screenshot when `--vision-mode image-describe` is
selected, and writes `visual-task.mp4`, `mantis-visual-task-summary.json`,
`mantis-visual-task-driver-result.json`, and
`mantis-visual-task-report.md`. When `--expect-text` is set, the vision
prompt asks for a structured JSON verdict (`visible`, `evidence`, `reason`)
and only passes when the model reports `visible: true` with evidence that
cites the expected text; a `visible: false` response that merely quotes the
target text still fails the assertion. Use `--vision-mode metadata` for a
no-model smoke that proves the desktop, browser, screenshot, and video
plumbing without calling an image-understanding provider. Recording is a
required artifact for `visual-task`; if Crabbox records no non-empty
`visual-task.mp4`, the task fails even when the visual driver passed. On
failure, Mantis keeps the lease for VNC unless the task had already passed
and `--keep-lease` was not set.

### Credential pool health check

Before using pooled live credentials, run:

```bash
pnpm openclaw qa credentials doctor
```

The doctor checks Convex broker env (`OPENCLAW_QA_CONVEX_SITE_URL`,
`OPENCLAW_QA_CONVEX_ENDPOINT_PREFIX`), validates endpoint settings, reports
only set/missing status for `OPENCLAW_QA_CONVEX_SECRET_CI` and
`OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`, and verifies admin/list reachability
when the maintainer secret is present.

## Live transport coverage

Live transport lanes share one contract instead of each inventing their own
scenario list shape. `qa-channel` is the broad synthetic product-behavior
suite and is not part of the live transport coverage matrix.

Live transport runners import the shared scenario ids, baseline coverage
helpers, and scenario-selection helper from
`openclaw/plugin-sdk/qa-live-transport-scenarios`.

| Lane     | Canary | Mention gating | Bot-to-bot | Allowlist block | Top-level reply | Quote reply | Restart resume | Thread follow-up | Thread isolation | Reaction observation | Help command | Native command registration |
| -------- | ------ | -------------- | ---------- | --------------- | --------------- | ----------- | -------------- | ---------------- | ---------------- | -------------------- | ------------ | --------------------------- |
| Discord  | x      | x              | x          |                 |                 |             |                |                  |                  |                      |              | x                           |
| Matrix   | x      | x              | x          | x               | x               |             | x              | x                | x                | x                    |              |                             |
| Slack    | x      | x              | x          | x               | x               |             | x              | x                | x                |                      |              |                             |
| Telegram | x      | x              | x          |                 |                 |             |                |                  |                  |                      | x            |                             |
| WhatsApp | x      | x              |            | x               | x               | x           | x              |                  |                  | x                    | x            |                             |

This keeps `qa-channel` as the broad product-behavior suite while Matrix,
Telegram, and the other live transports share one explicit transport-contract
checklist.

For a disposable Linux VM lane without bringing Docker into the QA path, run:

```bash
pnpm openclaw qa suite --runner multipass --scenario channel-chat-baseline
```

This boots a fresh Multipass guest, installs dependencies, builds OpenClaw
inside the guest, runs `qa suite`, then copies the normal QA report and
summary back into `.artifacts/qa-e2e/...` on the host. It reuses the same
scenario-selection behavior as `qa suite` on the host.

Host and Multipass suite runs execute multiple selected scenarios in
parallel with isolated gateway workers by default. `qa-channel` defaults to
concurrency 4, capped by the selected scenario count. Use `--concurrency
<count>` to tune the worker count, or `--concurrency 1` for serial execution.
Use `--pack personal-agent` to run the personal assistant benchmark pack (10
scenarios). The pack selector is additive with repeated `--scenario` flags:
explicit scenarios run first, then pack scenarios run in pack order with
duplicates removed. Use `--pack observability` to select the
`otel-trace-smoke` and `docker-prometheus-smoke` scenarios together when a
custom QA runner already supplies the OpenTelemetry collector setup.

The command exits non-zero when any scenario fails. Use `--allow-failures`
when you want artifacts without a failing exit code.

Live runs forward the supported QA auth inputs that are practical for the
guest: env-based provider keys, the QA live provider config path, and
`CODEX_HOME` when present. Keep `--output-dir` under the repo root so the
guest can write back through the mounted workspace.

## Discord, Slack, Telegram, and WhatsApp QA reference

Matrix has a [dedicated page](/concepts/qa-matrix) because of its scenario
count and Docker-backed homeserver provisioning. Discord, Slack, Telegram,
and WhatsApp run against pre-existing real transports, so their reference
lives here.

### Shared CLI flags

These lanes register through
`extensions/qa-lab/src/live-transports/shared/live-transport-cli.ts` and
accept the same flags:

| Flag                                  | Default                                            | Description                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scenario <id>`                     | -                                                  | Run only this scenario. Repeatable.                                                                                                             |
| `--output-dir <path>`                 | `<repo>/.artifacts/qa-e2e/<transport>-<timestamp>` | Where reports, summaries, evidence, transport-specific artifacts, and the output log are written. Relative paths resolve against `--repo-root`. |
| `--repo-root <path>`                  | `process.cwd()`                                    | Repository root when invoking from a neutral cwd.                                                                                               |
| `--sut-account <id>`                  | `sut`                                              | Temporary account id inside the QA gateway config.                                                                                              |
| `--provider-mode <mode>`              | `live-frontier`                                    | `mock-openai` or `live-frontier` (legacy `live-openai` still works).                                                                            |
| `--model <ref>` / `--alt-model <ref>` | provider default                                   | Primary/alternate model refs.                                                                                                                   |
| `--fast`                              | off                                                | Provider fast mode where supported.                                                                                                             |
| `--credential-source <env\|convex>`   | `env`                                              | See [Convex credential pool](#convex-credential-pool).                                                                                          |
| `--credential-role <maintainer\|ci>`  | `ci` in CI, `maintainer` otherwise                 | Role used when `--credential-source convex`.                                                                                                    |

Each lane exits non-zero on any failed scenario. `--allow-failures` writes
artifacts without setting a failing exit code. Telegram also accepts
`--list-scenarios` to print available scenario ids and exit; the other lanes
do not expose that flag.

### Telegram QA

```bash
pnpm openclaw qa telegram
```

Targets one real private Telegram group with two distinct bots (driver +
SUT). The SUT bot must have a Telegram username; bot-to-bot observation works
best when both bots have **Bot-to-Bot Communication Mode** enabled in
`@BotFather`.

Required env when `--credential-source env`:

- `OPENCLAW_QA_TELEGRAM_GROUP_ID` - numeric chat id (string).
- `OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN`

Scenarios (`extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts`):

- `telegram-canary`
- `telegram-mention-gating`
- `telegram-mentioned-message-reply`
- `telegram-help-command`
- `telegram-commands-command`
- `telegram-tools-compact-command`
- `telegram-whoami-command`
- `telegram-status-command`
- `telegram-repeated-command-authorization`
- `telegram-other-bot-command-gating`
- `telegram-context-command`
- `telegram-current-session-status-tool`
- `telegram-tool-only-usage-footer`
- `telegram-reply-chain-exact-marker`
- `telegram-stream-final-single-message`
- `telegram-long-final-reuses-preview`
- `telegram-long-final-three-chunks`

The implicit default set always covers canary, mention gating, native command
replies, command addressing, and bot-to-bot group replies. `mock-openai`
defaults also include deterministic reply-chain and final-message streaming
checks. `telegram-current-session-status-tool` and
`telegram-tool-only-usage-footer` remain opt-in: the former is only stable
when threaded directly after canary, and the latter is a real-Telegram proof
of the `/usage` footer on tool-only replies. Use `pnpm openclaw qa telegram
--list-scenarios --provider-mode mock-openai` to print the current
default/optional split with regression refs.

Output artifacts:

- `telegram-qa-report.md`
- `qa-evidence.json` - evidence entries for the live transport checks,
  including profile, coverage, provider, channel, artifacts, result, and RTT
  fields.

Package Telegram runs use the same Telegram credential contract. Repeated RTT
measurement is part of the normal package Telegram live lane; the RTT
distribution is folded into `qa-evidence.json` under `result.timing` for the
selected RTT check.

```bash
OPENCLAW_QA_CREDENTIAL_SOURCE=convex \
pnpm test:docker:npm-telegram-live
```

When `OPENCLAW_QA_CREDENTIAL_SOURCE=convex` is set, the package live wrapper
leases a `kind: "telegram"` credential, exports the leased group/driver/SUT
bot env into the installed-package run, heartbeats the lease, and releases it
on shutdown. The package wrapper defaults to 20 RTT checks of
`telegram-mentioned-message-reply`, a 30s RTT timeout, and Convex role
`maintainer` outside CI when Convex is selected. Override
`OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES`, `OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS`,
or `OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES` to tune RTT measurement without
creating a separate RTT command or Telegram-specific summary format.

### Discord QA

```bash
pnpm openclaw qa discord
```

Targets one real private Discord guild channel with two bots: a driver bot
controlled by the harness and a SUT bot started by the child OpenClaw gateway
through the bundled Discord plugin. Verifies channel mention handling, that
the SUT bot has registered the native `/help` command with Discord, and
opt-in Mantis evidence scenarios.

Required env when `--credential-source env`:

- `OPENCLAW_QA_DISCORD_GUILD_ID`
- `OPENCLAW_QA_DISCORD_CHANNEL_ID`
- `OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID` - must match the SUT bot user id
  returned by Discord (the lane fails fast otherwise).

Optional:

- `OPENCLAW_QA_DISCORD_CAPTURE_CONTENT=1` keeps message bodies in
  observed-message artifacts.
- `OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID` selects the voice/stage channel for
  `discord-voice-autojoin`; without it, the scenario picks the first visible
  voice/stage channel for the SUT bot.

Scenarios (`extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:36`):

- `discord-canary`
- `discord-mention-gating`
- `discord-native-help-command-registration`
- `discord-voice-autojoin` - opt-in voice scenario. Runs by itself, enables
  `channels.discord.voice.autoJoin`, and verifies the SUT bot's current
  Discord voice state is the target voice/stage channel. Convex Discord
  credentials may include optional `voiceChannelId`; otherwise the runner
  discovers the first visible voice/stage channel in the guild.
- `discord-status-reactions-tool-only` - opt-in Mantis scenario. Runs by
  itself because it switches the SUT to always-on, tool-only guild replies
  with `messages.statusReactions.enabled=true`, then captures a REST
  reaction timeline plus HTML/PNG visual artifacts. Mantis before/after
  reports also preserve scenario-provided MP4 artifacts as `baseline.mp4`
  and `candidate.mp4`.
- `discord-thread-reply-filepath-attachment` - opt-in Mantis scenario; see
  [Discord Mantis scenarios](#discord-mantis-scenarios).

Run the Discord voice auto-join scenario explicitly:

```bash
pnpm openclaw qa discord \
  --scenario discord-voice-autojoin \
  --provider-mode mock-openai
```

Run the Mantis status-reaction scenario explicitly:

```bash
pnpm openclaw qa discord \
  --scenario discord-status-reactions-tool-only \
  --provider-mode live-frontier \
  --model openai/gpt-5.6-luna \
  --alt-model openai/gpt-5.6-luna \
  --fast
```

Output artifacts:

- `discord-qa-report.md`
- `qa-evidence.json` - evidence entries for the live transport checks.
- `discord-qa-observed-messages.json` - bodies redacted unless
  `OPENCLAW_QA_DISCORD_CAPTURE_CONTENT=1`.
- `discord-qa-reaction-timelines.json` and
  `discord-status-reactions-tool-only-timeline.png` when the status-reaction
  scenario runs.

### Slack QA

```bash
pnpm openclaw qa slack
```

Targets one real private Slack channel with two distinct bots: a driver bot
controlled by the harness and a SUT bot started by the child OpenClaw gateway
through the bundled Slack plugin.

Required env when `--credential-source env`:

- `OPENCLAW_QA_SLACK_CHANNEL_ID`
- `OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_APP_TOKEN`

Optional:

- `OPENCLAW_QA_SLACK_CAPTURE_CONTENT=1` keeps message bodies in
  observed-message artifacts.
- `OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR` enables visual approval
  checkpoints for Mantis. The runner writes `<scenario>.pending.json` and
  `<scenario>.resolved.json`, then waits for matching `.ack.json` files.
- `OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_TIMEOUT_MS` overrides the checkpoint
  acknowledgement timeout. The default is `120000`.

Canonical YAML scenarios exposed through the Slack live adapter:

- `thread-follow-up`
- `thread-isolation`

Imperative Slack scenarios (`extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts`):

- `slack-canary`
- `slack-mention-gating`
- `slack-allowlist-block`
- `slack-channel-disabled-warning` - opt-in real-Slack probe that confirms a
  configured disabled channel emits a structured warning without replying.
- `slack-top-level-reply-shape`
- `slack-restart-resume`
- `slack-progress-commentary-true`, `slack-progress-commentary-false`,
  `slack-progress-commentary-omitted`, and
  `slack-progress-commentary-verbose-dedupe` - opt-in real-Slack probes for
  independent commentary/tool-progress controls, the omitted-key legacy
  default, and single-delivery behavior when durable verbose progress is on.
- `slack-reaction-glyph-native` - opt-in live message-tool reaction scenario.
  Instructs the agent to pass the exact `✅` glyph and confirms Slack stored
  `white_check_mark` for the SUT bot on the target message.
- `slack-chart-presentation-native` - opt-in portable chart scenario that
  verifies the native `data_visualization` block and exact accessible text.
- `slack-table-presentation-native` - opt-in portable table scenario that
  verifies the native `data_table` block, exact rows, and accessible text.
- `slack-table-invalid-blocks-fallback` - opt-in direct-transport scenario
  that sends a structurally readable over-limit raw table with 101 data rows
  plus its header through the
  production Slack send path, proves Slack itself returns `invalid_blocks`,
  and verifies the stored formatting-disabled fallback is complete and has no
  native data block. The report keeps only safe error-code, count, and boolean
  evidence; raw synthetic table text follows
  `OPENCLAW_QA_SLACK_CAPTURE_CONTENT`.
- `slack-approval-exec-native` - opt-in native Slack exec approval scenario.
  Requests an exec approval through the gateway, verifies the Slack message
  has native approval buttons, resolves it, and verifies the resolved Slack
  update.
- `slack-approval-plugin-native` - opt-in native Slack plugin approval
  scenario. Enables exec and plugin approval forwarding together so plugin
  events are not suppressed by exec approval routing, then verifies the same
  pending/resolved native Slack UI path.
- `slack-codex-approval-exec-native` - opt-in Codex Guardian command approval
  scenario. Enables the Codex plugin in Guardian mode, routes a
  Slack-originated Gateway agent turn through the Codex app-server harness,
  waits for the native Slack plugin approval prompt for
  `openclaw-codex-app-server`, resolves it, and verifies the Codex turn
  finishes with the expected command-output and assistant markers.
- `slack-codex-approval-plugin-native` - opt-in Codex Guardian file approval
  scenario. Uses an outside-workspace `apply_patch` instruction so Codex emits
  the app-server file-change approval route, then verifies the same native
  Slack pending/resolved approval path, final assistant marker, and exact file
  contents before cleanup.

The Codex approval scenarios require an `openai/*` or `codex/*` `--model`, the
normal live model credentials, and Codex auth or API-key auth accepted by the Codex plugin.
The Slack report includes the Codex app-server method, selected Codex model key,
final Codex turn status, and operation-marker verification alongside the
redacted Slack approval metadata.

Output artifacts:

- `slack-qa-report.md`
- `qa-evidence.json` - evidence entries for the live transport checks.
- `slack-qa-observed-messages.json` - bodies redacted unless
  `OPENCLAW_QA_SLACK_CAPTURE_CONTENT=1`.
- `approval-checkpoints/` - only when Mantis sets
  `OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR`; contains checkpoint JSON,
  acknowledgement JSON, and pending/resolved screenshots.

#### Setting up the Slack workspace

The lane needs two distinct Slack apps in one workspace, plus a channel both
bots are members of:

- `channelId` - the `Cxxxxxxxxxx` id of a channel both bots have been
  invited to. Use a dedicated channel; the lane posts on every run.
- `driverBotToken` - bot token (`xoxb-...`) of the **Driver** app.
- `sutBotToken` - bot token (`xoxb-...`) of the **SUT** app, which must be a
  separate Slack app from the driver so its bot user id is distinct.
- `sutAppToken` - app-level token (`xapp-...`) of the SUT app with
  `connections:write`, used by Socket Mode so the SUT app can receive events.

Prefer a Slack workspace dedicated to QA over reusing a production
workspace.

The SUT manifest below intentionally narrows the bundled Slack plugin's
production install (`extensions/slack/src/setup-shared.ts:12`) to the
permissions and events covered by the live Slack QA suite. For the
production-channel setup as users see it, see
[Slack channel quick setup](/channels/slack#quick-setup); the QA Driver/SUT
pair is intentionally separate because the lane needs two distinct bot user
ids in one workspace.

**1. Create the Driver app**

Go to [api.slack.com/apps](https://api.slack.com/apps) → _Create New App_ →
_From a manifest_ → pick the QA workspace, paste the following manifest,
then _Install to Workspace_:

```json
{
  "display_information": {
    "name": "OpenClaw QA Driver",
    "description": "Test driver bot for OpenClaw QA Slack live lane"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw QA Driver",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": ["chat:write", "channels:history", "groups:history", "users:read"]
    }
  },
  "settings": {
    "socket_mode_enabled": false
  }
}
```

Copy the _Bot User OAuth Token_ (`xoxb-...`) - that becomes
`driverBotToken`. The driver only needs to post messages and identify
itself; no events, no Socket Mode.

**2. Create the SUT app**

Repeat _Create New App → From a manifest_ in the same workspace. This QA app
intentionally uses a narrower version of the bundled Slack plugin's
production manifest (`extensions/slack/src/setup-shared.ts:12`): reaction
scopes and events are omitted because the live Slack QA suite does not cover
reaction handling yet.

```json
{
  "display_information": {
    "name": "OpenClaw QA SUT",
    "description": "OpenClaw QA SUT connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw QA SUT",
      "always_online": true
    },
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "emoji:read",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "pins:read",
        "pins:write",
        "usergroups:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_home_opened",
        "app_mention",
        "channel_rename",
        "member_joined_channel",
        "member_left_channel",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

After Slack creates the app, do two things on its settings page:

- _Install to Workspace_ → copy the _Bot User OAuth Token_ → that becomes
  `sutBotToken`.
- _Basic Information → App-Level Tokens → Generate Token and Scopes_ → add
  scope `connections:write` → save → copy the `xapp-...` value → that
  becomes `sutAppToken`.

Verify the two bots have distinct user ids by calling `auth.test` on each
token. The runtime distinguishes driver and SUT by user id; reusing one app
for both will fail mention-gating immediately.

**3. Create the channel**

In the QA workspace, create a channel (e.g. `#openclaw-qa`) and invite both
bots from inside the channel:

```text
/invite @OpenClaw QA Driver
/invite @OpenClaw QA SUT
```

Copy the `Cxxxxxxxxxx` id from _channel info → About → Channel ID_ - that
becomes `channelId`. A public channel works; if you use a private channel
both apps already have `groups:history` so the harness's history reads will
still succeed.

**4. Register the credentials**

Two options. Use env vars for single-machine debugging (set the four
`OPENCLAW_QA_SLACK_*` variables and pass `--credential-source env`), or seed
the shared Convex pool so CI and other maintainers can lease them.

For the Convex pool, write the four fields to a JSON file:

```json
{
  "channelId": "Cxxxxxxxxxx",
  "driverBotToken": "xoxb-...",
  "sutBotToken": "xoxb-...",
  "sutAppToken": "xapp-..."
}
```

With `OPENCLAW_QA_CONVEX_SITE_URL` and `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`
exported in your shell, register and verify:

```bash
pnpm openclaw qa credentials add \
  --kind slack \
  --payload-file slack-creds.json \
  --note "QA Slack pool seed"

pnpm openclaw qa credentials list --kind slack --status all --json
```

Expect `count: 1`, `status: "active"`, no `lease` field.

**5. Verify end to end**

Run the lane locally to confirm both bots can talk to each other through the
broker:

```bash
pnpm openclaw qa slack \
  --credential-source convex \
  --credential-role maintainer \
  --output-dir .artifacts/qa-e2e/slack-local
```

A green run completes in well under 30 seconds and `slack-qa-report.md`
shows both `slack-canary` and `slack-mention-gating` at status `pass`. If the
lane hangs for ~90 seconds and exits with `Convex credential pool exhausted
for kind "slack"`, either the pool is empty or every row is leased - `qa
credentials list --kind slack --status all --json` will tell you which.

### WhatsApp QA

```bash
pnpm openclaw qa whatsapp
```

Targets two dedicated WhatsApp Web accounts: a driver account controlled by
the harness and a SUT account started by the child OpenClaw gateway through
the bundled WhatsApp plugin.

Required env when `--credential-source env`:

- `OPENCLAW_QA_WHATSAPP_DRIVER_PHONE_E164`
- `OPENCLAW_QA_WHATSAPP_SUT_PHONE_E164`
- `OPENCLAW_QA_WHATSAPP_DRIVER_AUTH_ARCHIVE_BASE64`
- `OPENCLAW_QA_WHATSAPP_SUT_AUTH_ARCHIVE_BASE64`

Optional:

- `OPENCLAW_QA_WHATSAPP_GROUP_JID` enables group scenarios such as
  `whatsapp-mention-gating`, `whatsapp-group-pending-history-context`,
  `whatsapp-broadcast-group-fanout`, `whatsapp-group-activation-always`,
  `whatsapp-group-reply-to-bot-triggers`, group action/media/poll scenarios,
  and `whatsapp-group-allowlist-block`.
- `OPENCLAW_QA_WHATSAPP_CAPTURE_CONTENT=1` keeps message bodies in
  observed-message artifacts.

Scenario catalog (`extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts`):

- Baseline and group gating: `whatsapp-canary`, `whatsapp-pairing-block`,
  `whatsapp-mention-gating`, `whatsapp-group-pending-history-context`,
  `whatsapp-group-activation-always`, `whatsapp-group-reply-to-bot-triggers`,
  `whatsapp-top-level-reply-shape`, `whatsapp-restart-resume`,
  `whatsapp-group-allowlist-block`.
- Native commands: `whatsapp-help-command`, `whatsapp-status-command`,
  `whatsapp-commands-command`, `whatsapp-tools-compact-command`,
  `whatsapp-whoami-command`, `whatsapp-context-command`,
  `whatsapp-native-new-command`.
- Reply and final-output behavior: `whatsapp-tool-only-usage-footer`,
  `whatsapp-reply-to-message`, `whatsapp-group-reply-to-message`,
  `whatsapp-reply-to-mode-batched`, `whatsapp-reply-context-isolation`,
  `whatsapp-reply-delivery-shape`, `whatsapp-stream-final-message-accounting`.
- User-path message actions: `whatsapp-agent-message-action-react` starts
  from a real driver DM, lets the model call the `message` tool, and
  observes the native WhatsApp reaction. `whatsapp-agent-message-action-upload-file`
  uses the same posture for `message(action=upload-file)` and observes
  native WhatsApp media. `whatsapp-group-agent-message-action-react` and
  `whatsapp-group-agent-message-action-upload-file` prove the same
  user-visible actions in a real WhatsApp group.
- Group fanout: `whatsapp-broadcast-group-fanout` starts from one mentioned
  WhatsApp group message and verifies distinct visible replies from `main`
  and `qa-second`.
- Group activation: `whatsapp-group-activation-always` changes a real group
  session to `/activation always`, proves an unmentioned group message wakes
  the agent, then restores `/activation mention`.
  `whatsapp-group-reply-to-bot-triggers` seeds a bot reply, sends a native
  quoted reply to it without an explicit mention, and verifies the agent
  wakes from that reply context.
- Inbound media and structured messages: `whatsapp-inbound-image-caption`,
  `whatsapp-audio-preflight`, `whatsapp-inbound-structured-messages`,
  `whatsapp-group-audio-gating`, `whatsapp-inbound-reaction-no-trigger`.
  These send real WhatsApp image, audio, document, location, contact,
  sticker, and reaction events through the driver.
- Direct Gateway contract probes: `whatsapp-outbound-media-matrix`,
  `whatsapp-outbound-document-preserves-filename`, `whatsapp-outbound-poll`,
  `whatsapp-outbound-send-serialization`,
  `whatsapp-group-outbound-media`, `whatsapp-group-outbound-poll`,
  `whatsapp-message-actions`, `whatsapp-reply-context-isolation`,
  `whatsapp-reply-delivery-shape`. These bypass model prompting on purpose
  and prove deterministic Gateway/channel `send`, `poll`, and
  `message.action` contracts.
- Access-control coverage: `whatsapp-access-control-dm-open`,
  `whatsapp-access-control-dm-disabled`, `whatsapp-access-control-group-open`,
  `whatsapp-access-control-group-disabled`, `whatsapp-group-allowlist-block`.
- Native approvals: `whatsapp-approval-exec-deny-native`,
  `whatsapp-approval-exec-native`, `whatsapp-approval-exec-reaction-native`,
  `whatsapp-approval-exec-group-reaction-native`,
  `whatsapp-approval-plugin-native`.
- Status reactions: `whatsapp-status-reactions`,
  `whatsapp-status-reaction-lifecycle`.

The catalog currently contains 52 scenarios. The `live-frontier` default lane
is kept small at 10 scenarios for fast smoke coverage. The `mock-openai`
default lane runs 45 scenarios deterministically through the real WhatsApp
transport while mocking only model output; approval scenarios and a few
heavier/blocking checks remain explicit by scenario id.

The WhatsApp QA driver observes structured live events (`text`, `media`,
`location`, `reaction`, and `poll`) and can actively send media, polls,
contacts, locations, and stickers. QA Lab imports that driver through the
`@openclaw/whatsapp/api.js` package surface instead of reaching into private
WhatsApp runtime files. For group observations, `fromJid` is the group JID
while `participantJid` and `fromPhoneE164` identify the participant sender.
Message content is redacted by default. Direct Gateway poll, upload-file,
media, group poll, group media, and reply-shape probes are transport/API
contract checks; they are not treated as proof that a user prompt made the
agent choose the same action. User-path action proof comes from scenarios
such as `whatsapp-agent-message-action-react` and
`whatsapp-group-agent-message-action-react`, where the driver sends a normal
WhatsApp message and QA Lab observes the resulting native WhatsApp artifact.
WhatsApp reports include each scenario's posture (`user-path`,
`direct-gateway`, or `native-approval`) so evidence cannot be mistaken for a
stronger contract than it actually proves.

Output artifacts:

- `whatsapp-qa-report.md`
- `qa-evidence.json` - evidence entries for the live transport checks.
- `whatsapp-qa-observed-messages.json` - bodies redacted unless
  `OPENCLAW_QA_WHATSAPP_CAPTURE_CONTENT=1`.

### Convex credential pool

Discord, Slack, Telegram, and WhatsApp lanes can lease credentials from a
shared Convex pool instead of reading the env vars above. Pass
`--credential-source convex` (or set `OPENCLAW_QA_CREDENTIAL_SOURCE=convex`);
QA Lab acquires an exclusive lease, heartbeats it for the duration of the
run, and releases it on shutdown. Pool kinds are `"discord"`, `"slack"`,
`"telegram"`, and `"whatsapp"`.

Payload shapes the broker validates on `admin/add`:

- Discord (`kind: "discord"`): `{ guildId: string, channelId: string,
driverBotToken: string, sutBotToken: string, sutApplicationId: string }`.
- Telegram (`kind: "telegram"`): `{ groupId: string, driverToken: string,
sutToken: string }` - `groupId` must be a numeric chat-id string.
- Telegram real user (`kind: "telegram-user"`): `{ groupId: string, sutToken:
string, testerUserId: string, testerUsername: string, telegramApiId:
string, telegramApiHash: string, tdlibDatabaseEncryptionKey: string,
tdlibArchiveBase64: string, tdlibArchiveSha256: string,
desktopTdataArchiveBase64: string, desktopTdataArchiveSha256: string }` -
  Mantis Telegram Desktop proof only. Generic QA Lab lanes must not acquire
  this kind.
- WhatsApp (`kind: "whatsapp"`): `{ driverPhoneE164: string, sutPhoneE164:
string, driverAuthArchiveBase64: string, sutAuthArchiveBase64: string,
groupJid?: string }` - phone numbers must be distinct E.164 strings.

The Mantis Telegram Desktop proof workflow holds one exclusive Convex
`telegram-user` lease for both the TDLib CLI driver and Telegram Desktop
witness, then releases it after publishing proof.

When a PR needs a deterministic visual diff, Mantis can use the same mock
model reply on `main` and on the PR head while the Telegram formatter or
delivery layer changes. Capture defaults are tuned for PR comments: standard
Crabbox class, 24fps desktop recording, 24fps motion GIF, and 1920px preview
width. Before/after comments should publish a clean bundle that contains
only the intended GIFs.

Slack lanes can also use the pool. Slack payload shape checks currently live
in the Slack QA runner rather than the broker; use `{ channelId: string,
driverBotToken: string, sutBotToken: string, sutAppToken: string }`, with a
Slack channel id like `Cxxxxxxxxxx`. See
[Setting up the Slack workspace](#setting-up-the-slack-workspace) for app
and scope provisioning.

Operational env vars and the Convex broker endpoint contract live in
[Testing → Shared Telegram credentials via Convex](/help/testing#shared-telegram-credentials-via-convex-v1)
(the section name predates the multi-channel pool; the lease semantics are
shared across kinds).

## Repo-backed seeds

Seed assets live in `qa/`:

- `qa/scenarios/index.yaml`
- `qa/scenarios/<theme>/*.yaml`

These are intentionally in git so the QA plan is visible to both humans and
the agent.

`qa-lab` stays a generic YAML scenario runner. Each scenario YAML file is the
source of truth for one test run and should define:

- top-level `title`
- `scenario` metadata
- optional category, capability, lane, and risk metadata in `scenario`
- docs and code refs in `scenario`
- optional plugin requirements in `scenario`
- optional gateway config patch in `scenario`
- executable top-level `flow` for flow scenarios, or
  `scenario.execution.kind` / `scenario.execution.path` for Vitest and
  Playwright scenarios

The reusable runtime surface that backs `flow` stays generic and
cross-cutting. For example, YAML scenarios can combine transport-side
helpers with browser-side helpers that drive the embedded Control UI through
the Gateway `browser.request` seam without adding a special-case runner.

Scenario files should be grouped by product capability rather than source
tree folder. Keep scenario IDs stable when files move; use `docsRefs` and
`codeRefs` for implementation traceability.

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
- `aimock` starts an AIMock-backed provider server for experimental
  protocol, fixture, record/replay, and chaos coverage. It is additive and
  does not replace the `mock-openai` scenario dispatcher.

Provider-lane implementation lives under `extensions/qa-lab/src/providers/`.
Each provider owns its defaults, local server startup, gateway model config,
auth-profile staging needs, and live/mock capability flags. Shared suite and
gateway code routes through the provider registry instead of branching on
provider names.

## Transport adapters

`qa-lab` owns a generic transport seam for YAML QA scenarios. `qa-channel` is
the synthetic default. `crabline` starts local provider-shaped servers and
runs OpenClaw's normal channel plugins against them. `live` is reserved for
real provider credentials and external channels.

At the architecture level, the split is:

- `qa-lab` owns generic scenario execution, worker concurrency, artifact
  writing, and reporting.
- The transport adapter owns gateway config, readiness, inbound and outbound
  observation, transport actions, and normalized transport state.
- YAML scenario files under `qa/scenarios/` define the test run; `qa-lab`
  provides the reusable runtime surface that executes them.

### Adding a channel

Adding a channel to the YAML QA system requires the channel implementation
plus a scenario pack that exercises the channel contract. For smoke CI
coverage, add the matching Crabline local provider server and expose it
through the `crabline` driver.

Do not add a new top-level QA command root when the shared `qa-lab` host can
own the flow.

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
3. Keep transport-specific mechanics inside the runner plugin or channel
   harness.
4. Mount the runner as `openclaw qa <runner>` instead of registering a
   competing root command. Runner plugins should declare `qaRunners` in
   `openclaw.plugin.json` and export a matching `qaRunnerCliRegistrations`
   array from `runtime-api.ts`. Keep `runtime-api.ts` light; lazy CLI and
   runner execution should stay behind separate entrypoints. An optional
   `adapterFactory` exposes the transport to shared scenarios without changing
   the command's existing scenario catalog.
5. Author or adapt YAML scenarios under the themed `qa/scenarios/`
   directories.
6. Use the generic scenario helpers for new scenarios.
7. Keep existing compatibility aliases working unless the repo is doing an
   intentional migration.

The decision rule is strict:

- If behavior can be expressed once in `qa-lab`, put it in `qa-lab`.
- If behavior depends on one channel transport, keep it in that runner
  plugin or plugin harness.
- If a scenario needs a new capability that more than one channel can use,
  add a generic helper instead of a channel-specific branch in `suite.ts`.
- If a behavior is only meaningful for one transport, keep the scenario
  transport-specific and make that explicit in the scenario contract.

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

Compatibility aliases remain available for existing scenarios -
`waitForQaChannelReady`, `waitForOutboundMessage`, `waitForNoOutbound`,
`formatConversationTranscript`, `resetBus` - but new scenario authoring
should use the generic names. The aliases exist to avoid a flag-day
migration, not as the model going forward.

## Reporting

`qa-lab` exports a Markdown protocol report from the observed bus timeline.
The report should answer:

- What worked
- What failed
- What stayed blocked
- What follow-up scenarios are worth adding

For the inventory of available scenarios - useful when sizing follow-up work
or wiring a new transport - run `pnpm openclaw qa coverage` (add `--json`
for machine-readable output). When choosing focused proof for a touched
behavior or file path, run `pnpm openclaw qa coverage --match <query>`. The
match report searches scenario metadata, docs refs, code refs, coverage IDs,
plugins, and provider requirements, then prints matching `qa suite
--scenario ...` targets.

Every `qa suite` run writes top-level `qa-evidence.json`,
`qa-suite-summary.json`, and `qa-suite-report.md` artifacts for the selected
scenario set. Scenarios that declare `execution.kind: vitest` or
`execution.kind: playwright` run the matching test path and also write
per-scenario logs. Scenarios that declare `execution.kind: script` run the
evidence producer at `execution.path` through `node --import tsx` (with
`${outputDir}` and `${scenarioId}` expanded in `execution.args`); the
producer writes its own `qa-evidence.json`, whose entries are imported into
the suite output and whose artifact paths are resolved relative to that
producer `qa-evidence.json`. When `qa suite` is reached through `qa run
--qa-profile`, the same `qa-evidence.json` also includes the profile
scorecard summary for the selected taxonomy categories.

Treat coverage output as a discovery aid, not a gate replacement; the
selected scenario still needs the right provider mode, live transport,
Multipass, Testbox, or release lane for the behavior under test. For
scorecard context, see [Maturity scorecard](/maturity/scorecard).

For character and style checks, run the same scenario across multiple live
model refs and write a judged Markdown report:

```bash
pnpm openclaw qa character-eval \
  --model openai/gpt-5.6-luna,thinking=medium,fast \
  --model openai/gpt-5.2,thinking=xhigh \
  --model openai/gpt-5,thinking=xhigh \
  --model anthropic/claude-opus-4-8,thinking=high \
  --model anthropic/claude-sonnet-4-6,thinking=high \
  --model zai/glm-5.1,thinking=high \
  --model moonshot/kimi-k2.5,thinking=high \
  --model google/gemini-3.1-pro-preview,thinking=high \
  --judge-model openai/gpt-5.6-sol,thinking=xhigh,fast \
  --judge-model anthropic/claude-opus-4-8,thinking=high \
  --blind-judge-models \
  --concurrency 16 \
  --judge-concurrency 16
```

The command runs local QA gateway child processes, not Docker. Character
eval scenarios should set the persona through `SOUL.md`, then run ordinary
user turns such as chat, workspace help, and small file tasks. The candidate
model should not be told that it is being evaluated. The command preserves
each full transcript, records basic run stats, then asks the judge models in
fast mode with `xhigh` reasoning where supported to rank the runs by
naturalness, vibe, and humor. Use `--blind-judge-models` when comparing
providers: the judge prompt still gets every transcript and run status, but
candidate refs are replaced with neutral labels such as `candidate-01`; the
report maps rankings back to real refs after parsing.

Candidate runs default to `high` thinking, with `medium` for GPT-5.6 Luna and
`xhigh` for older OpenAI eval refs that support it. Override a specific
candidate inline with `--model provider/model,thinking=<level>`; inline
options also support `fast`, `no-fast`, and `fast=<bool>`. `--thinking
<level>` still sets a global fallback, and the older `--model-thinking
<provider/model=level>` form is kept for compatibility. OpenAI candidate
refs default to fast mode so priority processing is used where the provider
supports it. Pass `--fast` only when you want to force fast mode on for
every candidate model. Candidate and judge durations are recorded in the
report for benchmark analysis, but judge prompts explicitly say not to rank
by speed. Candidate and judge model runs both default to concurrency 16.
Lower `--concurrency` or `--judge-concurrency` when provider limits or local
gateway pressure make a run too noisy.

When no candidate `--model` is passed, the character eval defaults to
`openai/gpt-5.6-luna`, `openai/gpt-5.2`, `openai/gpt-5`,
`anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-4-6`, `zai/glm-5.1`,
`moonshot/kimi-k2.5`, and `google/gemini-3.1-pro-preview`. When no
`--judge-model` is passed, the judges default to
`openai/gpt-5.6-sol,thinking=xhigh,fast` and
`anthropic/claude-opus-4-8,thinking=high`.

## Related docs

- [Matrix QA](/concepts/qa-matrix)
- [Maturity scorecard](/maturity/scorecard)
- [Personal agent benchmark pack](/concepts/personal-agent-benchmark-pack)
- [QA Channel](/channels/qa-channel)
- [Testing](/help/testing)
- [Dashboard](/web/dashboard)
