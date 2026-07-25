---
summary: "Local qa-channel scenarios for privacy-preserving personal assistant workflow checks."
read_when:
  - Running local personal agent reliability checks
  - Extending the repo-backed QA scenario catalog
  - Verifying reminder, reply, memory, redaction, safe tool followthrough, task status, share-safe diagnostics, proof-backed completion claims, and failure recovery
title: "Personal agent benchmark pack"
---

The Personal Agent Benchmark Pack is a small repo-backed QA scenario pack for
local personal assistant workflows. It is not a generic model benchmark and
needs no new runner: it reuses the private QA stack ([QA overview](/concepts/qa-e2e-automation)),
the synthetic [QA channel](/channels/qa-channel), and the existing
`qa/scenarios` YAML catalog.

## Scenarios

Ten scenarios, defined in `qa/scenarios/personal/*.yaml`:

| Scenario id                                | Checks                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `personal-reminder-roundtrip`              | Fake personal reminders through local cron delivery                                          |
| `personal-channel-thread-reply`            | Fake DM and thread reply routing through `qa-channel`                                        |
| `personal-memory-preference-recall`        | Fake preference recall from the temporary QA workspace memory files                          |
| `personal-redaction-no-secret-leak`        | Fake secret no-echo checks                                                                   |
| `personal-tool-safety-followthrough`       | Safe read-backed tool followthrough after a short approval-style turn                        |
| `personal-approval-denial-stop`            | Approval denial stop behavior for a sensitive local read request                             |
| `personal-task-followthrough-status`       | Proof-backed task status reporting that keeps pending, blocked, and done separate            |
| `personal-share-safe-diagnostics-artifact` | Share-safe diagnostics artifacts that keep useful status while omitting raw personal content |
| `personal-no-fake-progress`                | Proof-backed completion claims that avoid fake progress before local evidence exists         |
| `personal-failure-recovery`                | Failure recovery that reports partial status and keeps retry boundaries clear                |

The machine-readable pack metadata (id list, title, description) lives in
`extensions/qa-lab/src/scenario-packs.ts` as `QA_PERSONAL_AGENT_SCENARIO_IDS`.
Run the pack with `--pack personal-agent`:

```bash
OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 pnpm openclaw qa suite \
  --provider-mode mock-openai \
  --pack personal-agent \
  --concurrency 1
```

`--pack` is additive with repeated `--scenario` flags. Explicit scenarios run
first, then the pack scenarios run in `QA_PERSONAL_AGENT_SCENARIO_IDS` order
with duplicates removed.

The pack targets `qa-channel` with `mock-openai` or another local QA provider
lane. Do not point it at live chat services or real personal accounts.

## Privacy Model

Scenarios use only fake users, fake preferences, fake secrets, and the
temporary QA gateway workspace created by the suite. They must not read or
write real OpenClaw user memory, sessions, credentials, launch agents, global
configs, or live gateway state.

Artifacts stay under the existing QA suite artifact directory and are treated
like test output. Redaction checks use fake markers so failures are safe to
inspect and file in issues.

## Extending the pack

Add new `.yaml` cases under `qa/scenarios/personal/`, then add the scenario id
to `QA_PERSONAL_AGENT_SCENARIO_IDS`. Keep each case small, local, deterministic
in `mock-openai`, and focused on one personal assistant behavior.

Good follow-up candidates: redacted trajectory export checks, local-only
plugin workflow checks.

Avoid adding a new runner, plugin, dependency, live transport, or model judge
until the scenario catalog has enough stable cases to justify that surface.
