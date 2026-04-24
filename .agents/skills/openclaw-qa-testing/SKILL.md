---
name: openclaw-qa-testing
description: Run, watch, debug, extend, or explain OpenClaw qa-lab and qa-channel scenarios, artifacts, and live lanes.
---

# OpenClaw QA Testing

Use this skill for `qa-lab` / `qa-channel` work. Repo-local QA only.

## Read first

- `docs/concepts/qa-e2e-automation.md`
- `docs/help/testing.md`
- `docs/channels/qa-channel.md`
- `qa/README.md`
- `qa/scenarios/index.md`
- `extensions/qa-lab/src/suite.ts`
- `extensions/qa-lab/src/character-eval.ts`

## Model policy

- Live OpenAI lane: `openai/gpt-5.4`
- Fast mode: on
- Do not use:
  - `openai/gpt-5.4-pro`
  - `openai/gpt-5.4-mini`
- Only change model policy if the user explicitly asks.

## Default workflow

1. Read the scenario pack and current suite implementation.
2. Decide lane:
   - mock/dev: `mock-openai`
   - real validation: `live-frontier`
3. For live OpenAI, use:

```bash
OPENCLAW_LIVE_OPENAI_KEY="${OPENAI_API_KEY}" \
pnpm openclaw qa suite \
  --provider-mode live-frontier \
  --model openai/gpt-5.4 \
  --alt-model openai/gpt-5.4 \
  --output-dir .artifacts/qa-e2e/run-all-live-frontier-<tag>
```

4. Watch outputs:
   - summary: `.artifacts/qa-e2e/run-all-live-frontier-<tag>/qa-suite-summary.json`
   - report: `.artifacts/qa-e2e/run-all-live-frontier-<tag>/qa-suite-report.md`
5. If the user wants to watch the live UI, find the current `openclaw-qa` listen port and report `http://127.0.0.1:<port>`.
6. If a scenario fails, fix the product or harness root cause, then rerun the full lane.

## QA credentials and 1Password

- Use `op` only inside `tmux` for QA secret lookup in this repo.
- Quick auth check inside tmux:

```bash
op account list
```

- Direct Telegram npm live test secrets currently live in 1Password item:
  - vault: `OpenClaw`
  - item: `Telegram E2E`
- That item is the first place to look for:
  - `OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN`
  - `OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN`
  - `OPENCLAW_QA_PROVIDER_MODE`
  - `OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC`
- Convex QA secrets currently live in 1Password items:
  - vault: `OpenClaw`
  - item: `OPENCLAW_QA_CONVEX_SITE_URL`
  - item: `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`
  - item: `OPENCLAW_QA_CONVEX_SECRET_CI`
- Additional related notes/login items seen during QA credential work:
  - vault: `Private`
  - items: `OPENCLAW QA`, `Convex`, `Telegram`
- If a required value is missing from those notes:
  - do not guess
  - ask the maintainer/operator for the current value or the current 1Password item name
  - for Telegram direct runs, `OPENCLAW_QA_TELEGRAM_GROUP_ID` may be stored separately from `Telegram E2E`
  - for Convex runs, the leased Telegram credential should provide the Telegram group id and bot tokens together; do not require a separate `OPENCLAW_QA_TELEGRAM_GROUP_ID`
  - for Convex runs, prefer `OpenClaw/OPENCLAW_QA_CONVEX_SITE_URL`; if that is stale or unclear, ask for the active pool URL before running
- Prefer direct Telegram envs for the npm Telegram Docker lane when available:

```bash
OPENCLAW_QA_TELEGRAM_GROUP_ID="..." \
OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN="..." \
OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN="..." \
OPENCLAW_QA_PROVIDER_MODE="mock-openai" \
OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC="openclaw@beta" \
pnpm test:docker:npm-telegram-live
```

- Prefer Convex mode when the goal is stable shared QA infra:
  - round-robin credential leasing
  - thinner wrapper for channel-specific setup
  - CLI/admin flows around the pooled credentials
- Live npm Telegram Docker lane note:
  - `scripts/e2e/npm-telegram-live-runner.ts` reads `OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE`
  - do not assume `OPENCLAW_QA_PROVIDER_MODE` is consumed by that wrapper
  - if a 1Password note only gives `OPENCLAW_QA_PROVIDER_MODE`, map it explicitly to `OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE` before running the Docker lane
- Verified live shape:
  - Convex mode can pass the real Docker lane without direct Telegram env vars
  - leased Telegram payload includes the group id coupled to the driver/SUT tokens
  - a real run of `pnpm test:docker:npm-telegram-live` passed with:
    - `OPENCLAW_QA_CREDENTIAL_SOURCE=convex`
    - `OPENCLAW_QA_CREDENTIAL_ROLE=maintainer`
    - `OPENCLAW_QA_CONVEX_SITE_URL`
    - `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`
    - `OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE=mock-openai`

## Character evals

Use `qa character-eval` for style/persona/vibe checks across multiple live models.

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
  --concurrency 16 \
  --judge-concurrency 16 \
  --output-dir .artifacts/qa-e2e/character-eval-<tag>
```

- Runs local QA gateway child processes, not Docker.
- Preferred model spec syntax is `provider/model,thinking=<level>[,fast|,no-fast|,fast=<bool>]` for both `--model` and `--judge-model`.
- Do not add new examples with separate `--model-thinking`; keep that flag as legacy compatibility only.
- Defaults to candidate models `openai/gpt-5.4`, `openai/gpt-5.2`, `openai/gpt-5`, `anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-4-6`, `zai/glm-5.1`, `moonshot/kimi-k2.5`, and `google/gemini-3.1-pro-preview` when no `--model` is passed.
- Candidate thinking defaults to `high`, with `xhigh` for OpenAI models that support it. Prefer inline `--model provider/model,thinking=<level>`; `--thinking <level>` and `--model-thinking <provider/model=level>` remain compatibility shims.
- OpenAI candidate refs default to fast mode so priority processing is used where supported. Use inline `,fast`, `,no-fast`, or `,fast=false` for one model; use `--fast` only to force fast mode for every candidate.
- Judges default to `openai/gpt-5.4,thinking=xhigh,fast` and `anthropic/claude-opus-4-6,thinking=high`.
- Report includes judge ranking, run stats, durations, and full transcripts; do not include raw judge replies. Duration is benchmark context, not a grading signal.
- Candidate and judge concurrency default to 16. Use `--concurrency <n>` and `--judge-concurrency <n>` to override when local gateways or provider limits need a gentler lane.
- Scenario source should stay markdown-driven under `qa/scenarios/`.
- For isolated character/persona evals, write the persona into `SOUL.md` and blank `IDENTITY.md` in the scenario flow. Use `SOUL.md + IDENTITY.md` only when intentionally testing how the normal OpenClaw identity combines with the character.
- Keep prompts natural and task-shaped. The candidate model should receive character setup through `SOUL.md`, then normal user turns such as chat, workspace help, and small file tasks; do not ask "how would you react?" or tell the model it is in an eval.
- Prefer at least one real task, such as creating or editing a tiny workspace artifact, so the transcript captures character under normal tool use instead of pure roleplay.

## Codex CLI model lane

Use model refs shaped like `codex-cli/<codex-model>` whenever QA should exercise Codex as a model backend.

Examples:

```bash
pnpm openclaw qa suite \
  --provider-mode live-frontier \
  --model codex-cli/<codex-model> \
  --alt-model codex-cli/<codex-model> \
  --scenario <scenario-id> \
  --output-dir .artifacts/qa-e2e/codex-<tag>
```

```bash
pnpm openclaw qa manual \
  --model codex-cli/<codex-model> \
  --message "Reply exactly: CODEX_OK"
```

- Treat the concrete Codex model name as user/config input; do not hardcode it in source, docs examples, or scenarios.
- Live QA preserves `CODEX_HOME` so Codex CLI auth/config works while keeping `HOME` and `OPENCLAW_HOME` sandboxed.
- Mock QA should scrub `CODEX_HOME`.
- If Codex returns fallback/auth text every turn, first check `CODEX_HOME`, `~/.profile`, and gateway child logs before changing scenario assertions.
- For model comparison, include `codex-cli/<codex-model>` as another candidate in `qa character-eval`; the report should label it as an opaque model name.

## Repo facts

- Seed scenarios live in `qa/`.
- Main live runner: `extensions/qa-lab/src/suite.ts`
- QA lab server: `extensions/qa-lab/src/lab-server.ts`
- Child gateway harness: `extensions/qa-lab/src/gateway-child.ts`
- Synthetic channel: `extensions/qa-channel/`

## What “done” looks like

- Full suite green for the requested lane.
- User gets:
  - watch URL if applicable
  - pass/fail counts
  - artifact paths
  - concise note on what was fixed

## Common failure patterns

- Live timeout too short:
  - widen live waits in `extensions/qa-lab/src/suite.ts`
- Discovery cannot find repo files:
  - point prompts at `repo/...` inside seeded workspace
- Subagent proof too brittle:
  - prefer stable final reply evidence over transient child-session listing
- Harness “rebuild” delay:
  - dirty tree can trigger a pre-run build; expect that before ports appear

## When adding scenarios

- Add or update scenario markdown under `qa/scenarios/`
- Keep kickoff expectations in `qa/scenarios/index.md` aligned
- Add executable coverage in `extensions/qa-lab/src/suite.ts`
- Prefer end-to-end assertions over mock-only checks
- Save outputs under `.artifacts/qa-e2e/`
