---
summary: "Private QA automation shape for qa-lab, qa-channel, seeded scenarios, and protocol reports"
read_when:
  - Extending qa-lab or qa-channel
  - Adding repo-backed QA scenarios
  - Building higher-realism QA automation around the Gateway dashboard
title: "QA E2E automation"
---

The private QA stack is meant to exercise OpenClaw in a more realistic,
channel-shaped way than a single unit test can.

Current pieces:

- `extensions/qa-channel`: synthetic message channel with DM, channel, thread,
  reaction, edit, and delete surfaces.
- `extensions/qa-lab`: debugger UI and QA bus for observing the transcript,
  injecting inbound messages, and exporting a Markdown report.
- `qa/`: repo-backed seed assets for the kickoff task and baseline QA
  scenarios.

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

That lane provisions a disposable Tuwunel homeserver in Docker, registers
temporary driver, SUT, and observer users, creates one private room, then runs
the real Matrix plugin inside a QA gateway child. The live transport lane keeps
the child config scoped to the transport under test, so Matrix runs without
`qa-channel` in the child config. It writes the structured report artifacts and
a combined stdout/stderr log into the selected Matrix QA output directory. To
capture the outer `scripts/run-node.mjs` build/launcher output too, set
`OPENCLAW_RUN_NODE_OUTPUT_LOG=<path>` to a repo-local log file.
Matrix progress is printed by default. The CLI default profile is `all`, so
plain `pnpm openclaw qa matrix` still runs the full catalog. Use `--profile
fast` for the release-critical transport contract, or shard full coverage with
`transport`, `media`, `e2ee-smoke`, `e2ee-deep`, and `e2ee-cli`. `--fail-fast`
stops after the first failed scenario when you want a release gate instead of a
full inventory. `OPENCLAW_QA_MATRIX_TIMEOUT_MS` bounds the full run,
`OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS` can shorten no-reply quiet windows for
CI, and `OPENCLAW_QA_MATRIX_CLEANUP_TIMEOUT_MS` bounds cleanup so a stuck
Docker teardown reports the exact recovery command instead of hanging.

For a transport-real Telegram smoke lane, run:

```bash
pnpm openclaw qa telegram
```

That lane targets one real private Telegram group instead of provisioning a
disposable server. It requires `OPENCLAW_QA_TELEGRAM_GROUP_ID`,
`OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN`, and
`OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN`, plus two distinct bots in the same
private group. The SUT bot must have a Telegram username, and bot-to-bot
observation works best when both bots have Bot-to-Bot Communication Mode
enabled in `@BotFather`.
The command exits non-zero when any scenario fails. Use `--allow-failures` when
you want artifacts without a failing exit code.
The Telegram report and summary include per-reply RTT from the driver message
send request to the observed SUT reply, starting with the canary.

Before using pooled live credentials, run:

```bash
pnpm openclaw qa credentials doctor
```

The doctor checks Convex broker env, validates endpoint settings, and verifies
admin/list reachability when the maintainer secret is present. It reports only
set/missing status for secrets.

For a transport-real Discord smoke lane, run:

```bash
pnpm openclaw qa discord
```

That lane targets one real private Discord guild channel with two bots: a
driver bot controlled by the harness and a SUT bot started by the child
OpenClaw gateway through the bundled Discord plugin. It requires
`OPENCLAW_QA_DISCORD_GUILD_ID`, `OPENCLAW_QA_DISCORD_CHANNEL_ID`,
`OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN`, `OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN`,
and `OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID` when using env credentials.
The lane verifies channel mention handling and checks that the SUT bot has
registered the native `/help` command with Discord.
The command exits non-zero when any scenario fails. Use `--allow-failures` when
you want artifacts without a failing exit code.

Live transport lanes now share one smaller contract instead of each inventing
their own scenario list shape:

`qa-channel` remains the broad synthetic product-behavior suite and is not part
of the live transport coverage matrix.

| Lane     | Canary | Mention gating | Allowlist block | Top-level reply | Restart resume | Thread follow-up | Thread isolation | Reaction observation | Help command | Native command registration |
| -------- | ------ | -------------- | --------------- | --------------- | -------------- | ---------------- | ---------------- | -------------------- | ------------ | --------------------------- |
| Matrix   | x      | x              | x               | x               | x              | x                | x                | x                    |              |                             |
| Telegram | x      | x              |                 |                 |                |                  |                  |                      | x            |                             |
| Discord  | x      | x              |                 |                 |                |                  |                  |                      |              | x                           |

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

`qa-lab` owns a generic transport seam for markdown QA scenarios.
`qa-channel` is the first adapter on that seam, but the design target is wider:
future real or synthetic channels should plug into the same suite runner
instead of adding a transport-specific QA runner.

At the architecture level, the split is:

- `qa-lab` owns generic scenario execution, worker concurrency, artifact writing, and reporting.
- the transport adapter owns gateway config, readiness, inbound and outbound observation, transport actions, and normalized transport state.
- markdown scenario files under `qa/scenarios/` define the test run; `qa-lab` provides the reusable runtime surface that executes them.

Maintainer-facing adoption guidance for new channel adapters lives in
[Testing](/help/testing#adding-a-channel-to-qa).

## Reporting

`qa-lab` exports a Markdown protocol report from the observed bus timeline.
The report should answer:

- What worked
- What failed
- What stayed blocked
- What follow-up scenarios are worth adding

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

- [Testing](/help/testing)
- [QA Channel](/channels/qa-channel)
- [Dashboard](/web/dashboard)
