---
title: "Multi-agent orchestration - Specialist Lanes Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Multi-agent orchestration - Specialist Lanes Maturity Note

## Summary

Docs describe parallel specialist lanes, subagents, and automation tasks. Source implements subagent spawn, registry run manager, and command queue behavior. Tests cover depth limits, lifecycle, and Gateway server lanes.

## Category Scope

This category covers the taxonomy-defined Specialist Lanes capability area for the Multi-agent orchestration surface.

## Features

- Lane contracts: Define ownership and workload boundaries for specialist lanes.
- Background handoff: Move heavy work to subagents or tasks.
- Concurrency controls: Bound lane and subagent concurrency.
- Priority controls: Prioritize urgent or interactive work over background work.
- Coordinator handoff: Track owners, duplicate requests, and inter-lane summaries.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Docs describe parallel specialist lanes, subagents, and automation tasks; Source implements subagent spawn, registry run manager, and command queue behavior; Tests cover depth limits, lifecycle, and Gateway server lanes.
- Negative signals: Operational lane orchestration is useful but still complex and uneven across entrypoints.
- Integration gaps: Operational lane orchestration is useful but still complex and uneven across entrypoints.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs describe parallel specialist lanes, subagents, and automation tasks; Source implements subagent spawn, registry run manager, and command queue behavior.
- Bad qualities: Operational lane orchestration is useful but still complex and uneven across entrypoints.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/multi-agent-orchestration.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Lane contracts, Background handoff, Concurrency controls, Priority controls, Coordinator handoff.
- Negative signals: Operational lane orchestration is useful but still complex and uneven across entrypoints.
- Missing capability branches: Operational lane orchestration is useful but still complex and uneven across entrypoints.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Operational lane orchestration is useful but still complex and uneven across entrypoints.

## Evidence

### Docs

- `docs/concepts/parallel-specialist-lanes.md:12`
- `docs/tools/subagents.md:11`
- `docs/automation/tasks.md:15`

### Source

- `src/agents/subagent-spawn.ts:1044`
- `src/agents/subagent-registry-run-manager.ts:608`
- `src/process/command-queue.ts:326`

### Integration tests

- `src/gateway/server-lanes.test.ts:21`

### Unit tests

- `src/agents/subagent-spawn.depth-limits.test.ts:103`
- `src/agents/openclaw-tools.subagents.sessions-spawn.lifecycle.test.ts:214`

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
