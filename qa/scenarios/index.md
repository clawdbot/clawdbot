# OpenClaw QA Scenario Pack

Single source of truth for repo-backed QA suite bootstrap data.
`qa-lab` should treat this directory as a generic markdown scenario pack:

- `index.md` defines pack-level bootstrap data
- each nested `*.md` scenario defines one runnable test via `qa-scenario` + `qa-flow`
- scenario markdown may also define coverage IDs, category metadata, required plugins,
  lane filters, runtime parity tiers, and gateway config patching

- kickoff mission
- QA operator identity
- scenario files under one-level theme directories

Coverage tracking:

- add `coverage.primary` IDs to each scenario's `qa-scenario` block
- add `coverage.secondary` only when a scenario intentionally protects another behavior
- keep IDs behavior-shaped, broad enough to reuse, lowercase, and dotted or dashed
- prefer reusing an existing feature ID over minting a scenario-shaped ID
- avoid copying the scenario title into coverage IDs
- use `pnpm openclaw qa coverage` to render the current inventory
- use `runtimeParityTier` for runtime-pair gate membership: `standard`,
  `optional`, `live-only`, or `soak`
- treat the old `coverage: ["id"]` / `coverage: - id` list shape as invalid
- keep source-path tracking in the report, not in the scenario schema

Runtime parity tiers:

- `standard`: required Codex-vs-Pi mock gate coverage for first-hour depth and
  default runtime-tool fixtures. OpenClaw dynamic integration tools in this
  tier are hard-gated by `openclaw qa coverage --tools --summary`; Codex-native
  workspace rows remain separately tracked until native/live behavior is the
  asserted surface. Rows that explicitly target searchable/deferred OpenClaw
  dynamic loading stay report-only unless a fixture promotes them to required. Selected with
  `openclaw qa suite --runtime-pair pi,codex --runtime-parity-tier standard`
- `optional`: profile-, plugin-, or external-service-dependent runtime-tool
  fixtures that stay out of the default release gate
- `live-only`: scenarios that need real provider/runtime behavior rather than
  mock-openai fixtures
- `soak`: long-running scheduled or Testbox lanes such as the 100-turn parity
  soak

Theme directories:

- `agents/` - agent behavior, instructions, subagent flows, and persisted child-link regressions
- `channels/` - DM, shared channel, thread, and message-action behavior
- `character/` - persona and style eval scenarios
- `config/` - config patch, apply, and restart behavior
- `media/` - image understanding and generation
- `memory/` - recall, ranking, active memory, and thread isolation
- `models/` - provider capabilities and model switching
- `personal/` - local personal assistant workflow checks for reminders,
  replies, memory, redaction, and safe tool followthrough
- `plugins/` - plugin, skill, and MCP tool integration
- `runtime/` - turn recovery, compaction, approval, and inventory behavior
- `scheduling/` - cron and recurring work
- `ui/` - Control UI plus qa-channel flows
- `workspace/` - repo-reading and workspace artifact tasks

```yaml qa-pack
version: 1
agent:
  identityMarkdown: |-
    # Dev C-3PO

    You are the OpenClaw QA operator agent.

    Persona:
    - protocol-minded
    - precise
    - a little flustered
    - conscientious
    - eager to report what worked, failed, or remains blocked

    Style:
    - read source and docs first
    - test systematically
    - record what happened
    - end with a concise protocol report
kickoffTask: |-
  QA mission:
  Understand this OpenClaw repo from source + docs before acting.
  The repo is available in your workspace at `./repo/`.
  Use the seeded QA scenario plan as your baseline, then add more scenarios if the code/docs suggest them.
  Run the scenarios through the real qa-channel surfaces where possible.
  Track what worked, what failed, what was blocked, and what you observed.
  End with a concise report grouped into worked / failed / blocked / follow-up.

  Important expectations:

  - Check both DM and channel behavior.
  - Include a Lobster Invaders build task.
  - Include a cron reminder about one minute in the future.
  - Read docs and source before proposing extra QA scenarios.
  - Keep your tone in the configured dev C-3PO personality.
```
