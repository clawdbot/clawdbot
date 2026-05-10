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
- [Mantis](/concepts/mantis): before and after live verification for bugs that
  need real transports, browser screenshots, VM state, and PR evidence.

## Command surface

Every QA flow runs under `pnpm openclaw qa <subcommand>`. Many have `pnpm qa:*`
script aliases; both forms are supported.

| Command                                             | Purpose                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qa run`                                            | Bundled QA self-check; writes a Markdown report.                                                                                                                                                                                                                        |
| `qa suite`                                          | Run repo-backed scenarios against the QA gateway lane. Aliases: `pnpm openclaw qa suite --runner multipass` for a disposable Linux VM.                                                                                                                                  |
| `qa coverage`                                       | Print the markdown scenario-coverage inventory (`--json` for machine output).                                                                                                                                                                                           |
| `qa parity-report`                                  | Compare two `qa-suite-summary.json` files and write the agentic parity report.                                                                                                                                                                                          |
| `qa character-eval`                                 | Run the character QA scenario across multiple live models with a judged report. See [Reporting](#reporting).                                                                                                                                                            |
| `qa manual`                                         | Run a one-off prompt against the selected provider/model lane.                                                                                                                                                                                                          |
| `qa ui`                                             | Start the QA debugger UI and local QA bus (alias: `pnpm qa:lab:ui`).                                                                                                                                                                                                    |
| `qa docker-build-image`                             | Build the prebaked QA Docker image.                                                                                                                                                                                                                                     |
| `qa docker-scaffold`                                | Write a docker-compose scaffold for the QA dashboard + gateway lane.                                                                                                                                                                                                    |
| `qa up`                                             | Build the QA site, start the Docker-backed stack, print the URL (alias: `pnpm qa:lab:up`; `:fast` variant adds `--use-prebuilt-image --bind-ui-dist --skip-ui-build`).                                                                                                  |
| `qa aimock`                                         | Start only the AIMock provider server.                                                                                                                                                                                                                                  |
| `qa mock-openai`                                    | Start only the scenario-aware `mock-openai` provider server.                                                                                                                                                                                                            |
| `qa credentials doctor` / `add` / `list` / `remove` | Manage the shared Convex credential pool.                                                                                                                                                                                                                               |
| `qa matrix`                                         | Live transport lane against a disposable Tuwunel homeserver. See [Matrix QA](/concepts/qa-matrix).                                                                                                                                                                      |
| `qa telegram`                                       | Live transport lane against a real private Telegram group.                                                                                                                                                                                                              |
| `qa discord`                                        | Live transport lane against a real private Discord guild channel.                                                                                                                                                                                                       |
| `qa slack`                                          | Live transport lane against a real private Slack channel.                                                                                                                                                                                                               |
| `qa mantis`                                         | Before and after verification runner for live transport bugs, with Discord status-reactions evidence, Crabbox desktop/browser smoke, and Slack-in-VNC smoke. See [Mantis](/concepts/mantis) and [Mantis Slack Desktop Runbook](/concepts/mantis-slack-desktop-runbook). |

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

The scenarios cover transport behavior that unit tests cannot prove end to end: mention gating, allow-bot policies, allowlists, top-level and threaded replies, DM routing, reaction handling, inbound edit suppression, restart replay dedupe, homeserver interruption recovery, approval metadata delivery, media handling, and Matrix E2EE bootstrap/recovery/verification flows. The E2EE CLI profile also drives `openclaw matrix encryption setup` and verification commands through the same disposable homeserver before checking gateway replies.

Discord also has Mantis-only opt-in scenarios for bug reproduction. Use
`--scenario discord-status-reactions-tool-only` for the explicit status reaction
timeline, or `--scenario discord-thread-reply-filepath-attachment` to create a
real Discord thread and verify that `message.thread-reply` preserves a
`filePath` attachment. These scenarios stay out of the default live Discord lane
because they are before/after repro probes rather than broad smoke coverage.
The thread-attachment Mantis workflow can also add a logged-in Discord Web
witness video when `MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR` or
`MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64` is configured in the QA
environment. That viewer profile is only for visual capture; the pass/fail
decision still comes from the Discord REST oracle.

CI uses the same command surface in `.github/workflows/qa-live-transports-convex.yml`. Scheduled and default manual runs execute the fast Matrix profile with live frontier credentials, `--fast`, and `OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS=3000`. Manual `matrix_profile=all` fans out into the five profile shards so the exhaustive catalog can run in parallel while keeping one artifact directory per shard.

For transport-real Telegram, Discord, and Slack smoke lanes:

```bash
pnpm openclaw qa telegram
pnpm openclaw qa discord
pnpm openclaw qa slack
```

They target a pre-existing real channel with two bots (driver + SUT). Required env vars, scenario lists, output artifacts, and the Convex credential pool are documented in [Telegram, Discord, and Slack QA reference](#telegram-discord-and-slack-qa-reference) below.

For a full Slack desktop VM run with VNC rescue, run:

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --gateway-setup \
  --scenario slack-canary \
  --keep-lease
```

That command leases a Crabbox desktop/browser machine, runs the Slack live lane
inside the VM, opens Slack Web in the VNC browser, captures the desktop, and
copies `slack-qa/`, `slack-desktop-smoke.png`, and `slack-desktop-smoke.mp4`
when video capture is available back to the Mantis artifact directory. Crabbox
desktop/browser leases provide the capture tools and browser/native-build helper
packages up front, so the scenario should only install fallbacks on older
leases. Mantis reports total and per-phase timings in
`mantis-slack-desktop-smoke-report.md` so slow runs show whether time went into
lease warmup, credential acquisition, remote setup, or artifact copy. Reuse
`--lease-id <cbx_...>` after logging in to Slack Web manually through VNC;
reused leases also keep Crabbox's pnpm store cache warm. The default
`--hydrate-mode source` verifies from a source checkout and runs install/build
inside the VM. Use `--hydrate-mode prehydrated` only when the reused remote
workspace already has `node_modules` and a built `dist/`; that mode skips the
expensive install/build step and fails closed when the workspace is not ready.
With `--gateway-setup`, Mantis leaves a persistent OpenClaw Slack gateway
running inside the VM on port `38973`; without it, the command runs the normal
bot-to-bot Slack QA lane and exits after artifact capture.

The operator checklist, GitHub workflow dispatch command, evidence-comment
contract, hydrate-mode decision table, timing interpretation, and failure
handling steps live in [Mantis Slack Desktop Runbook](/concepts/mantis-slack-desktop-runbook).

For an agent/CV style desktop task, run:

```bash
pnpm openclaw qa mantis visual-task \
  --browser-url https://example.net \
  --expect-text "Example Domain" \
  --vision-model openai/gpt-5.4
```

`visual-task` leases or reuses a Crabbox desktop/browser machine, starts
`crabbox record --while`, drives the visible browser through a nested
`visual-driver`, captures `visual-task.png`, runs `openclaw infer image describe`
against the screenshot when `--vision-mode image-describe` is selected, and
writes `visual-task.mp4`, `mantis-visual-task-summary.json`,
`mantis-visual-task-driver-result.json`, and `mantis-visual-task-report.md`.
When `--expect-text` is set, the vision prompt asks for a structured JSON
verdict and only passes when the model reports positive visible evidence; a
negative response that merely quotes the target text fails the assertion.
Use `--vision-mode metadata` for a no-model smoke that proves the desktop,
browser, screenshot, and video plumbing without calling an image-understanding
provider. Recording is a required artifact for `visual-task`; if Crabbox records
no non-empty `visual-task.mp4`, the task fails even when the visual driver
passed. On failure, Mantis keeps the lease for VNC unless the task had already
passed and `--keep-lease` was not set.

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
| Slack    | x      | x              | x          | x               | x               | x              | x                | x                |                      |              |                             |

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

## Telegram, Discord, and Slack QA reference

Matrix has a [dedicated page](/concepts/qa-matrix) because of its scenario count and Docker-backed homeserver provisioning. Telegram, Discord, and Slack are smaller - a handful of scenarios each, no profile system, against pre-existing real channels - so their reference lives here.

### Shared CLI flags

These lanes register through `extensions/qa-lab/src/live-transports/shared/live-transport-cli.ts` and accept the same flags:

| Flag                                  | Default                                                         | Description                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--scenario <id>`                     | -                                                               | Run only this scenario. Repeatable.                                                                                   |
| `--output-dir <path>`                 | `<repo>/.artifacts/qa-e2e/{telegram,discord,slack}-<timestamp>` | Where reports/summary/observed messages and the output log are written. Relative paths resolve against `--repo-root`. |
| `--repo-root <path>`                  | `process.cwd()`                                                 | Repository root when invoking from a neutral cwd.                                                                     |
| `--sut-account <id>`                  | `sut`                                                           | Temporary account id inside the QA gateway config.                                                                    |
| `--provider-mode <mode>`              | `live-frontier`                                                 | `mock-openai` or `live-frontier` (legacy `live-openai` still works).                                                  |
| `--model <ref>` / `--alt-model <ref>` | provider default                                                | Primary/alternate model refs.                                                                                         |
| `--fast`                              | off                                                             | Provider fast mode where supported.                                                                                   |
| `--credential-source <env\|convex>`   | `env`                                                           | See [Convex credential pool](#convex-credential-pool).                                                                |
| `--credential-role <maintainer\|ci>`  | `ci` in CI, `maintainer` otherwise                              | Role used when `--credential-source convex`.                                                                          |

Each lane exits non-zero on any failed scenario. `--allow-failures` writes artifacts without setting a failing exit code.

### Telegram QA

```bash
pnpm openclaw qa telegram
```

Targets one real private Telegram group with two distinct bots (driver + SUT). The SUT bot must have a Telegram username; bot-to-bot observation works best when both bots have **Bot-to-Bot Communication Mode** enabled in `@BotFather`.

Required env when `--credential-source env`:

- `OPENCLAW_QA_TELEGRAM_GROUP_ID` - numeric chat id (string).
- `OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN`

Optional:

- `OPENCLAW_QA_TELEGRAM_CAPTURE_CONTENT=1` keeps message bodies in observed-message artifacts (default redacts).

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
- `telegram-reply-chain-exact-marker`
- `telegram-stream-final-single-message`
- `telegram-long-final-reuses-preview`
- `telegram-long-final-three-chunks`

The implicit default set always covers canary, mention gating, native command replies, command addressing, and bot-to-bot group replies. `mock-openai` defaults also include deterministic reply-chain and final-message streaming checks. `telegram-current-session-status-tool` remains opt-in because it is only stable when threaded directly after canary, not after arbitrary native command replies. Use `pnpm openclaw qa telegram --list-scenarios --provider-mode mock-openai` to print the current default/optional split with regression refs.

Output artifacts:

- `telegram-qa-report.md`
- `telegram-qa-summary.json` - includes per-reply RTT (driver send → observed SUT reply) starting with the canary.
- `telegram-qa-observed-messages.json` - bodies redacted unless `OPENCLAW_QA_TELEGRAM_CAPTURE_CONTENT=1`.

### Discord QA

```bash
pnpm openclaw qa discord
```

Targets one real private Discord guild channel with two bots: a driver bot controlled by the harness and a SUT bot started by the child OpenClaw gateway through the bundled Discord plugin. Verifies channel mention handling, that the SUT bot has registered the native `/help` command with Discord, and opt-in Mantis evidence scenarios.

Required env when `--credential-source env`:

- `OPENCLAW_QA_DISCORD_GUILD_ID`
- `OPENCLAW_QA_DISCORD_CHANNEL_ID`
- `OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID` - must match the SUT bot user id returned by Discord (the lane fails fast otherwise).

Optional:

- `OPENCLAW_QA_DISCORD_CAPTURE_CONTENT=1` keeps message bodies in observed-message artifacts.
- `OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID` selects the voice/stage channel for `discord-voice-autojoin`; without it, the scenario picks the first visible voice/stage channel for the SUT bot.

Scenarios (`extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:36`):

- `discord-canary`
- `discord-mention-gating`
- `discord-native-help-command-registration`
- `discord-voice-autojoin` - opt-in voice scenario. Runs by itself, enables `channels.discord.voice.autoJoin`, and verifies the SUT bot's current Discord voice state is the target voice/stage channel. Convex Discord credentials may include optional `voiceChannelId`; otherwise the runner discovers the first visible voice/stage channel in the guild.
- `discord-status-reactions-tool-only` - opt-in Mantis scenario. Runs by itself because it switches the SUT to always-on, tool-only guild replies with `messages.statusReactions.enabled=true`, then captures a REST reaction timeline plus HTML/PNG visual artifacts. Mantis before/after reports also preserve scenario-provided MP4 artifacts as `baseline.mp4` and `candidate.mp4`.

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
  --model openai/gpt-5.4 \
  --alt-model openai/gpt-5.4 \
  --fast
```

Output artifacts:

- `discord-qa-report.md`
- `discord-qa-summary.json`
- `discord-qa-observed-messages.json` - bodies redacted unless `OPENCLAW_QA_DISCORD_CAPTURE_CONTENT=1`.
- `discord-qa-reaction-timelines.json` and `discord-status-reactions-tool-only-timeline.png` when the status-reaction scenario runs.

### Slack QA

```bash
pnpm openclaw qa slack
```

Targets one real private Slack channel with two distinct bots: a driver bot controlled by the harness and a SUT bot started by the child OpenClaw gateway through the bundled Slack plugin.

Required env when `--credential-source env`:

- `OPENCLAW_QA_SLACK_CHANNEL_ID`
- `OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_APP_TOKEN`

Optional:

- `OPENCLAW_QA_SLACK_CAPTURE_CONTENT=1` keeps message bodies in observed-message artifacts.

Scenarios (`extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts:39`):

- `slack-canary`
- `slack-mention-gating`
- `slack-allowlist-block`
- `slack-top-level-reply-shape`
- `slack-restart-resume`
- `slack-thread-follow-up`
- `slack-thread-isolation`

Output artifacts:

- `slack-qa-report.md`
- `slack-qa-summary.json`
- `slack-qa-observed-messages.json` - bodies redacted unless `OPENCLAW_QA_SLACK_CAPTURE_CONTENT=1`.

#### Setting up the Slack workspace

The lane needs two distinct Slack apps in one workspace, plus a channel both bots are members of:

- `channelId` - the `Cxxxxxxxxxx` id of a channel both bots have been invited to. Use a dedicated channel; the lane posts on every run.
- `driverBotToken` - bot token (`xoxb-...`) of the **Driver** app.
- `sutBotToken` - bot token (`xoxb-...`) of the **SUT** app, which must be a separate Slack app from the driver so its bot user id is distinct.
- `sutAppToken` - app-level token (`xapp-...`) of the SUT app with `connections:write`, used by Socket Mode so the SUT app can receive events.

Prefer a Slack workspace dedicated to QA over reusing a production workspace.

The SUT manifest below intentionally narrows the bundled Slack plugin's production install (`extensions/slack/src/setup-shared.ts:10`) to the permissions and events covered by the live Slack QA suite. For the production-channel setup as users see it, see [Slack channel quick setup](/channels/slack#quick-setup); the QA Driver/SUT pair is intentionally separate because the lane needs two distinct bot user ids in one workspace.

**1. Create the Driver app**

Go to [api.slack.com/apps](https://api.slack.com/apps) → _Create New App_ → _From a manifest_ → pick the QA workspace, paste the following manifest, then _Install to Workspace_:

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

Copy the _Bot User OAuth Token_ (`xoxb-...`) - that becomes `driverBotToken`. The driver only needs to post messages and identify itself; no events, no Socket Mode.

**2. Create the SUT app**

Repeat _Create New App → From a manifest_ in the same workspace. This QA app intentionally uses a narrower version of the bundled Slack plugin's production manifest (`extensions/slack/src/setup-shared.ts:10`): reaction scopes and events are omitted because the live Slack QA suite does not cover reaction handling yet.

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

- _Install to Workspace_ → copy the _Bot User OAuth Token_ → that becomes `sutBotToken`.
- _Basic Information → App-Level Tokens → Generate Token and Scopes_ → add scope `connections:write` → save → copy the `xapp-...` value → that becomes `sutAppToken`.

Verify the two bots have distinct user ids by calling `auth.test` on each token. The runtime distinguishes driver and SUT by user id; reusing one app for both will fail mention-gating immediately.

**3. Create the channel**

In the QA workspace, create a channel (e.g. `#openclaw-qa`) and invite both bots from inside the channel:

```
/invite @OpenClaw QA Driver
/invite @OpenClaw QA SUT
```

Copy the `Cxxxxxxxxxx` id from _channel info → About → Channel ID_ - that becomes `channelId`. A public channel works; if you use a private channel both apps already have `groups:history` so the harness's history reads will still succeed.

**4. Register the credentials**

Two options. Use env vars for single-machine debugging (set the four `OPENCLAW_QA_SLACK_*` variables and pass `--credential-source env`), or seed the shared Convex pool so CI and other maintainers can lease them.

For the Convex pool, write the four fields to a JSON file:

```json
{
  "channelId": "Cxxxxxxxxxx",
  "driverBotToken": "xoxb-...",
  "sutBotToken": "xoxb-...",
  "sutAppToken": "xapp-..."
}
```

With `OPENCLAW_QA_CONVEX_SITE_URL` and `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` exported in your shell, register and verify:

```bash
pnpm openclaw qa credentials add \
  --kind slack \
  --payload-file slack-creds.json \
  --note "QA Slack pool seed"

pnpm openclaw qa credentials list --kind slack --status all --json
```

Expect `count: 1`, `status: "active"`, no `lease` field.

**5. Verify end to end**

Run the lane locally to confirm both bots can talk to each other through the broker:

```bash
pnpm openclaw qa slack \
  --credential-source convex \
  --credential-role maintainer \
  --output-dir .artifacts/qa-e2e/slack-local
```

A green run completes in well under 30 seconds and `slack-qa-report.md` shows both `slack-canary` and `slack-mention-gating` at status `pass`. If the lane hangs for ~90 seconds and exits with `Convex credential pool exhausted for kind "slack"`, either the pool is empty or every row is leased - `qa credentials list --kind slack --status all --json` will tell you which.

### Convex credential pool

Telegram, Discord, Slack, and WhatsApp lanes can lease credentials from a shared Convex pool instead of reading the env vars above. Pass `--credential-source convex` (or set `OPENCLAW_QA_CREDENTIAL_SOURCE=convex`); QA Lab acquires an exclusive lease, heartbeats it for the duration of the run, and releases it on shutdown. Pool kinds are `"telegram"`, `"discord"`, `"slack"`, and `"whatsapp"`.

Payload shapes the broker validates on `admin/add`:

- Telegram (`kind: "telegram"`): `{ groupId: string, driverToken: string, sutToken: string }` - `groupId` must be a numeric chat-id string.
- Discord (`kind: "discord"`): `{ guildId: string, channelId: string, driverBotToken: string, sutBotToken: string, sutApplicationId: string }`.
- WhatsApp (`kind: "whatsapp"`): `{ driverPhoneE164: string, sutPhoneE164: string, driverAuthArchiveBase64: string, sutAuthArchiveBase64: string, groupJid?: string }` - phone numbers must be distinct E.164 strings.

Slack lanes can also use the pool. Slack payload shape checks currently live in the Slack QA runner rather than the broker; use `{ channelId: string, driverBotToken: string, sutBotToken: string, sutAppToken: string }`, with a Slack channel id like `Cxxxxxxxxxx`. See [Setting up the Slack workspace](#setting-up-the-slack-workspace) for app and scope provisioning.

Operational env vars and the Convex broker endpoint contract live in [Testing → Shared Telegram credentials via Convex](/help/testing#shared-telegram-credentials-via-convex-v1) (the section name predates the multi-channel pool; the lease semantics are shared across kinds).

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

Compatibility aliases remain available for existing scenarios - `waitForQaChannelReady`, `waitForOutboundMessage`, `waitForNoOutbound`, `formatConversationTranscript`, `resetBus` - but new scenario authoring should use the generic names. The aliases exist to avoid a flag-day migration, not as the model going forward.

## Reporting

`qa-lab` exports a Markdown protocol report from the observed bus timeline.
The report should answer:

- What worked
- What failed
- What stayed blocked
- What follow-up scenarios are worth adding

For the inventory of available scenarios - useful when sizing follow-up work or wiring a new transport - run `pnpm openclaw qa coverage` (add `--json` for machine-readable output).

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
