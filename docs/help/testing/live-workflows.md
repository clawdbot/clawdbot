---
summary: "Live provider debugging lanes plus the Docker and Parallels smokes that support them"
title: "Live and Docker/Parallels workflows"
read_when:
  - You are debugging a real provider or model
  - You need a live Docker or Parallels lane
---

## Live and Docker/Parallels workflows

When debugging real providers/models (requires real creds):

- Live suite (models + gateway tool/image probes): `pnpm test:live`
- Target one live file quietly: `pnpm test:live -- src/agents/models.profiles.live.test.ts`
- Runtime performance reports: dispatch `OpenClaw Performance` with
  `live_openai_candidate=true` for a real `openai/gpt-5.6-luna` agent turn or
  `deep_profile=true` for Kova CPU/heap/trace artifacts. Daily scheduled runs
  publish mock-provider, deep-profile, and GPT-5.6 Luna lane reports to
  `openclaw/clawgrit-reports` from a separate artifact-consuming publisher job;
  missing or invalid publisher authentication fails scheduled and
  `profile=release` runs. Manual non-release dispatches keep the GitHub artifacts
  and treat report publication as advisory. The mock-provider report also
  includes source-level gateway boot, memory, plugin-pressure, repeated
  fake-model hello-loop, and CLI startup numbers.
- Docker live model sweep: `pnpm test:docker:live-models`
  - Each selected model runs a text turn plus a small file-read-style probe.
    Models whose metadata advertises `image` input also run a tiny image turn.
    Disable the extra probes with `OPENCLAW_LIVE_MODEL_FILE_PROBE=0` or
    `OPENCLAW_LIVE_MODEL_IMAGE_PROBE=0` when isolating provider failures.
  - CI coverage: daily `OpenClaw Scheduled Live And E2E Checks` and manual
    `OpenClaw Release Checks` both call the reusable live/E2E workflow with
    `include_live_suites: true`, which includes Docker live model matrix jobs
    sharded by provider.
  - For focused CI reruns, dispatch `OpenClaw Live And E2E Checks (Reusable)`
    with `include_live_suites: true` and `live_models_only: true`.
  - Add new high-signal provider secrets to `scripts/ci-hydrate-live-auth.sh`
    plus `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml` and its
    scheduled/release callers.
- Native Codex bound-chat smoke: `pnpm test:docker:live-codex-bind`
  - Runs a Docker live lane against the Codex app-server path, binds a
    synthetic Slack DM with `/codex bind`, exercises `/codex fast` and
    `/codex permissions`, then verifies a plain reply and an image attachment
    route through the native plugin binding instead of ACP.
- Codex app-server harness smoke: `pnpm test:docker:live-codex-harness`
  - Runs gateway agent turns through the plugin-owned Codex app-server
    harness, verifies `/codex status` and `/codex models`, and by default
    exercises image, cron MCP, sub-agent, and Guardian probes. Disable the
    sub-agent probe with `OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_PROBE=0` when
    isolating other failures. For a focused sub-agent check, disable the
    other probes:
    `OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=0 OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=0 OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=0 OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_PROBE=1 pnpm test:docker:live-codex-harness`.
    This exits after the sub-agent probe unless
    `OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_ONLY=0` is set.
- Codex on-demand install smoke: `pnpm test:docker:codex-on-demand`
  - Installs the packaged OpenClaw tarball in Docker, runs OpenAI API-key
    onboarding, and verifies the Codex plugin plus `@openai/codex` dependency
    were downloaded into the managed npm project root on demand.
- Codex npm-plugin live package smoke: `pnpm test:docker:live-codex-npm-plugin`
  - Installs the candidate OpenClaw package and exact Codex plugin into Docker,
    then uses a real OpenAI key for CLI preflight and same-session turns.
  - Its zero-retry medium-thinking follow-through turn must send progress, keep
    working through randomized workspace reads and an exact artifact write,
    then send completion. A progress-only terminal turn fails the lane.
- Live plugin tool dependency smoke: `pnpm test:docker:live-plugin-tool`
  - Packs a fixture plugin with a real `slugify` dependency, installs it
    through `npm-pack:`, verifies the dependency under the managed npm
    project root, then asks a live OpenAI model to call the plugin tool and
    return the hidden slug.
- OpenClaw rescue command smoke: `pnpm test:live:system-agent-rescue-channel`
  - Opt-in belt-and-suspenders check for the message-channel rescue command
    surface. Exercises `/openclaw status`, queues a persistent model
    change, replies `/openclaw yes`, and verifies the audit/config write
    path.
- OpenClaw first-run Docker smoke: `pnpm test:docker:system-agent-first-run`
  - Starts from an empty OpenClaw state dir and first proves the packaged
    `openclaw setup` CLI fails closed without inference. It then
    tests and activates fake Claude through the packaged activation module.
    Only afterward does a fuzzy packaged CLI request reach the planner and
    resolve to typed setup, followed by one-shot model, agent, Discord config,
    and SecretRef operations. It validates config and audit entries. This is
    supporting gate/operation evidence, not an interactive onboarding or
    OpenClaw agent/tool/approval proof. The same lane is exposed in QA Lab by
    `pnpm openclaw qa suite --scenario system-agent-ring-zero-setup`.
- Moonshot/Kimi cost smoke: with `MOONSHOT_API_KEY` set, run
  `openclaw models list --provider moonshot --json`, then run an isolated
  `openclaw agent --local --session-id live-kimi-cost --message 'Reply exactly: KIMI_LIVE_OK' --thinking off --json`
  against `moonshot/kimi-k2.6`. Verify the JSON reports Moonshot/K2.6 and the
  assistant transcript stores normalized `usage.cost`.

<Tip>
When you only need one failing case, prefer narrowing live tests via the allowlist env vars described below.
</Tip>
