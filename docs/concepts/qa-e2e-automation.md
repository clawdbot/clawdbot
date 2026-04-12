---
summary: "Private QA automation shape for qa-lab, qa-channel, seeded scenarios, and protocol reports"
read_when:
  - Extending qa-lab or qa-channel
  - Adding repo-backed QA scenarios
  - Building higher-realism QA automation around the Gateway dashboard
title: "QA E2E Automation"
---

# QA E2E Automation

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

For a transport-real Matrix smoke lane, run:

```bash
pnpm openclaw qa matrix
```

That lane provisions a disposable Tuwunel homeserver in Docker, registers
temporary driver, SUT, and observer users, creates one private room, then runs
the real Matrix plugin inside a QA gateway child. The live transport lane keeps
the child config scoped to the transport under test, so Matrix runs without
`qa-channel` in the child config.

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

Live transport lanes now share one smaller contract instead of each inventing
their own scenario list shape:

`qa-channel` remains the broad synthetic product-behavior suite and is not part
of the live transport coverage matrix.

| Lane     | Canary | Mention gating | Allowlist block | Top-level reply | Restart resume | Thread follow-up | Thread isolation | Reaction observation | Help command |
| -------- | ------ | -------------- | --------------- | --------------- | -------------- | ---------------- | ---------------- | -------------------- | ------------ |
| Matrix   | x      | x              | x               | x               | x              | x                | x                | x                    |              |
| Telegram | x      |                |                 |                 |                |                  |                  |                      | x            |

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
with isolated gateway workers by default, up to 64 workers or the selected
scenario count. Use `--concurrency <count>` to tune the worker count, or
`--concurrency 1` for serial execution.
Live runs forward the supported QA auth inputs that are practical for the
guest: env-based provider keys, the QA live provider config path, and
`CODEX_HOME` when present. Keep `--output-dir` under the repo root so the guest
can write back through the mounted workspace.

## Repo-backed seeds

Seed assets live in `qa/`:

- `qa/scenarios/index.md`
- `qa/scenarios/*.md`

These are intentionally in git so the QA plan is visible to both humans and the
agent.

`qa-lab` should stay a generic markdown runner. Each scenario markdown file is
the source of truth for one test run and should define:

- scenario metadata
- docs and code refs
- optional plugin requirements
- optional gateway config patch
- the executable `qa-flow`

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
  --model openai/gpt-5.4,thinking=xhigh \
  --model openai/gpt-5.2,thinking=xhigh \
  --model openai/gpt-5,thinking=xhigh \
  --model anthropic/claude-opus-4-6,thinking=high \
  --model anthropic/claude-sonnet-4-6,thinking=high \
  --model zai/glm-5.1,thinking=high \
  --model moonshot/kimi-k2.5,thinking=high \
  --model google/gemini-3.1-pro-preview,thinking=high \
  --judge-model openai/gpt-5.4,thinking=xhigh,fast \
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
`xhigh` reasoning to rank the runs by naturalness, vibe, and humor.
Use `--blind-judge-models` when comparing providers: the judge prompt still gets
every transcript and run status, but candidate refs are replaced with neutral
labels such as `candidate-01`; the report maps rankings back to real refs after
parsing.
Candidate runs default to `high` thinking, with `xhigh` for OpenAI models that
support it. Override a specific candidate inline with
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
`openai/gpt-5.4`, `openai/gpt-5.2`, `openai/gpt-5`, `anthropic/claude-opus-4-6`,
`anthropic/claude-sonnet-4-6`, `zai/glm-5.1`,
`moonshot/kimi-k2.5`, and
`google/gemini-3.1-pro-preview` when no `--model` is passed.
When no `--judge-model` is passed, the judges default to
`openai/gpt-5.4,thinking=xhigh,fast` and
`anthropic/claude-opus-4-6,thinking=high`.

## Related docs

- [Testing](/help/testing)
- [QA Channel](/channels/qa-channel)
- [Dashboard](/web/dashboard)
