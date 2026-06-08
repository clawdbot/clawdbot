---
title: "Multi-agent orchestration - Agent Isolation Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Multi-agent orchestration - Agent Isolation Maturity Note

## Summary

Docs cover multi-agent isolation, subagents, and sandbox tools. Source implements scope config, target policy, and auth-profile portability. Tests cover subagent spawn, tool policy, and agent session boundaries.

## Category Scope

This category covers the taxonomy-defined Agent Isolation capability area for the Multi-agent orchestration surface.

## Features

- Workspace separation: Keep each agent workspace and agent directory distinct.
- State separation: Separate state, config, and session paths per agent.
- Auth separation: Keep provider and channel auth scoped to the intended agent.
- Session separation: Avoid accidental transcript and conversation crossover.
- Tool profiles: Apply per-agent tool and sandbox posture.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Docs cover multi-agent isolation, subagents, and sandbox tools; Source implements scope config, target policy, and auth-profile portability; Tests cover subagent spawn, tool policy, and agent session boundaries.
- Negative signals: Isolation is broad but still spans several policy layers, which lowers quality evidence.
- Integration gaps: Isolation is broad but still spans several policy layers, which lowers quality evidence.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs cover multi-agent isolation, subagents, and sandbox tools; Source implements scope config, target policy, and auth-profile portability.
- Bad qualities: Isolation is broad but still spans several policy layers, which lowers quality evidence.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/multi-agent-orchestration.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Workspace separation, State separation, Auth separation, Session separation, Tool profiles.
- Negative signals: Isolation is broad but still spans several policy layers, which lowers quality evidence.
- Missing capability branches: Isolation is broad but still spans several policy layers, which lowers quality evidence.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Isolation is broad but still spans several policy layers, which lowers quality evidence.

## Evidence

### Docs

- `docs/concepts/multi-agent.md:9`
- `docs/tools/subagents.md:11`
- `docs/tools/multi-agent-sandbox-tools.md:9`

### Source

- `src/agents/agent-scope-config.ts:105`
- `src/agents/subagent-target-policy.ts:47`
- `src/agents/auth-profiles/portability.ts:28`

### Integration tests

- None identified in this scoring slice.

### Unit tests

- `src/agents/subagent-spawn.test.ts:120`
- `src/agents/agent-tools.policy.test.ts:186`
- `src/commands/agent/session.test.ts:87`

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
