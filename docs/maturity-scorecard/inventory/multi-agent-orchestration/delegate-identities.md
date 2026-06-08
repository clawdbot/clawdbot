---
title: "Multi-agent orchestration - Delegate Identities Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Multi-agent orchestration - Delegate Identities Maturity Note

## Summary

Docs describe delegate architecture and security expectations. Source exposes identity config and CLI identity commands. Tests cover identity command behavior and route integration.

## Category Scope

This category covers the taxonomy-defined Delegate Identities capability area for the Multi-agent orchestration surface.

## Features

- Named delegates: Create agents with explicit organizational identity.
- Authority model: Scope what a delegate can do on behalf of a user or organization.
- Delegate tiers: Support read-only, draft, send-on-behalf, and proactive modes.
- Identity delegation: Configure least-privilege Microsoft 365 or Google Workspace delegation.
- Organizational assistants: Run multi-organization delegate patterns from one Gateway.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (45%)`
- Positive signals: Docs describe delegate architecture and security expectations; Source exposes identity config and CLI identity commands; Tests cover identity command behavior and route integration.
- Negative signals: Delegate identity remains more policy/runbook than enforced end-to-end product workflow; Coverage is below Alpha because fresh runtime proof and broad enforcement tests were not found.
- Integration gaps: Delegate identity remains more policy/runbook than enforced end-to-end product workflow; Coverage is below Alpha because fresh runtime proof and broad enforcement tests were not found.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs describe delegate architecture and security expectations; Source exposes identity config and CLI identity commands.
- Bad qualities: Delegate identity remains more policy/runbook than enforced end-to-end product workflow.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Alpha (62%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/multi-agent-orchestration.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Named delegates, Authority model, Delegate tiers, Identity delegation, Organizational assistants.
- Negative signals: Delegate identity remains more policy/runbook than enforced end-to-end product workflow; Coverage is below Alpha because fresh runtime proof and broad enforcement tests were not found.
- Missing capability branches: Delegate identity remains more policy/runbook than enforced end-to-end product workflow; Coverage is below Alpha because fresh runtime proof and broad enforcement tests were not found.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Delegate identity remains more policy/runbook than enforced end-to-end product workflow.
- Coverage is below Alpha because fresh runtime proof and broad enforcement tests were not found.

## Evidence

### Docs

- `docs/concepts/delegate-architecture.md:8`
- `docs/concepts/delegate-architecture.md:160`
- `docs/gateway/security/index.md:92`

### Source

- `src/config/types.agents.ts:79`
- `src/config/zod-schema.core.ts:578`
- `src/commands/agents.commands.identity.ts:64`

### Integration tests

- None identified in this scoring slice.

### Unit tests

- `src/commands/agents.identity.test.ts:72`
- `src/commands/agents.add.test.ts:139`
- `src/routing/resolve-route.test.ts:317`

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
