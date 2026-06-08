---
title: "Multi-agent orchestration - Agent Setup Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Multi-agent orchestration - Agent Setup Maturity Note

## Summary

CLI, wizard, and Gateway docs/source cover agent creation and deletion. Tests exercise add/delete and Gateway mutation behavior.

## Category Scope

This category covers the taxonomy-defined Agent Setup capability area for the Multi-agent orchestration surface.

## Features

- Add agents: Create additional named agents from CLI or onboarding flows.
- Agent list and delete: Inspect and remove configured agents.
- Identity files: Set and maintain agent identity metadata.
- Non-interactive setup: Script agent creation with model and route options.
- Single-agent default: Preserve the default main-agent topology.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: CLI, wizard, and Gateway docs/source cover agent creation and deletion; Tests exercise add/delete and Gateway mutation behavior.
- Negative signals: Fresh live multi-agent setup proof was not produced in this scoring slice.
- Integration gaps: Fresh live multi-agent setup proof was not produced in this scoring slice.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: CLI, wizard, and Gateway docs/source cover agent creation and deletion.
- Bad qualities: No implementation-quality-specific weakness was identified separately from other gap classes in this scoring slice.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/multi-agent-orchestration.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Add agents, Agent list and delete, Identity files, Non-interactive setup, Single-agent default.
- Negative signals: Fresh live multi-agent setup proof was not produced in this scoring slice.
- Missing capability branches: Fresh live multi-agent setup proof was not produced in this scoring slice.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Fresh live multi-agent setup proof was not produced in this scoring slice.

## Evidence

### Docs

- `docs/cli/agents.md:20`
- `docs/start/wizard.md:111`
- `docs/start/wizard-cli-automation.md:202`

### Source

- `src/commands/agents.commands.add.ts:121`
- `src/commands/agents.commands.delete.ts:83`
- `src/gateway/server-methods/agents.ts:507`

### Integration tests

- `src/gateway/server-methods/agents-mutate.test.ts:527`

### Unit tests

- `src/commands/agents.add.test.ts:98`
- `src/commands/agents.delete.test.ts:117`

### Surface validation commands

- `gitcrawl doctor --json`: `pass` - Archive freshness was verified before scoring.
- `discrawl status --json`: `pass` - Discord archive freshness was verified before scoring.

### Gitcrawl queries

Query: global freshness check only.

Results:

- `gitcrawl doctor --json` passed; category-specific issue queries were not run in this surface-subagent scoring package.

### Discrawl queries

Query: global freshness check only.

Results:

- `discrawl status --json` passed; category-specific Discord searches were not run in this surface-subagent scoring package.

## Audit Provenance

- Score source: `docs/kevinslin/maturity-scorecard/inventory/multi-agent-orchestration/scores.yaml`.
- Taxonomy metadata source: `.agents/skills/claw-score/taxonomy.yaml`.
- OpenClaw source ref: `openclaw@29dd7847fd`.
