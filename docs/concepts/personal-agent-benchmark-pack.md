---
summary: "Local qa-channel scenarios for privacy-preserving personal assistant workflow checks."
read_when:
  - Running local personal agent reliability checks
  - Extending the repo-backed QA scenario catalog
  - Verifying reminder, reply, memory, redaction, and safe tool followthrough behavior
title: "Personal agent benchmark pack"
---

The Personal Agent Benchmark Pack is a small repo-backed QA scenario pack for
local personal assistant workflows. It is not a generic model benchmark and it
does not require a new runner. The pack reuses the private QA stack described in
[QA overview](/concepts/qa-e2e-automation), the synthetic
[QA channel](/channels/qa-channel), and the existing `qa/scenarios` markdown
catalog.

The first pack is intentionally narrow:

- fake personal reminders through local cron delivery
- fake DM and thread reply routing through `qa-channel`
- fake preference recall from the temporary QA workspace memory files
- fake secret no-echo checks
- safe read-backed tool followthrough after a short approval-style turn

## Scenarios

The machine-readable pack metadata lives in
`extensions/qa-lab/src/scenario-packs.ts`. Run the pack with
`--pack personal-agent`:

```bash
OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 pnpm openclaw qa suite \
  --provider-mode mock-openai \
  --pack personal-agent \
  --concurrency 1
```

`--pack` is additive with repeated `--scenario` flags. Explicit scenarios run
first, then the pack scenarios run in `QA_PERSONAL_AGENT_SCENARIO_IDS` order with
duplicates removed.

The pack is designed for `qa-channel` with `mock-openai` or another local QA
provider lane. It should not be pointed at live chat services or real personal
accounts.

## Privacy Model

The scenarios use only fake users, fake preferences, fake secrets, and the
temporary QA gateway workspace created by the suite. They must not read or write
real OpenClaw user memory, sessions, credentials, launch agents, global configs,
or live gateway state.

Artifacts stay under the existing QA suite artifact directory and should be
treated like test output. Redaction checks use fake markers so failures are safe
to inspect and file in issues.

## Extending The Pack

Add new cases under `qa/scenarios/personal/`, then add the scenario id to
`QA_PERSONAL_AGENT_SCENARIO_IDS`. Keep each case small, local, deterministic in
`mock-openai`, and focused on one personal assistant behavior.

Good follow-up candidates:

- approval denial correctness
- multi-step task ledger assertions
- redacted trajectory export checks
- local-only plugin workflow checks

Avoid adding a new runner, plugin, dependency, live transport, or model judge
until the scenario catalog has enough stable cases to justify that surface.
