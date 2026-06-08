---
title: "OpenClaw App SDK - Agent Conversations Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# OpenClaw App SDK - Agent Conversations Maturity Note

## Summary

Docs cover creating and continuing agent conversations. Client source implements conversation send, wait, stream, and normalization helpers. Tests cover unit behavior plus Gateway-backed e2e conversation paths.

## Category Scope

This category covers the taxonomy-defined Agent Conversations capability area for the OpenClaw App SDK surface.

## Features

- Agent handles: SDK-side agent object creation and lookup.
- Agent runs: Agent execution path with streamed run events.
- Run results: Run result envelope, wait semantics, timeout handling, and result normalization.
- Session creation: Reusable session handle creation.
- Session send: Session transcript interaction from external apps.
- Session controls: Patch, abort, and compact operations.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Docs cover creating and continuing agent conversations; Client source implements conversation send, wait, stream, and normalization helpers; Tests cover unit behavior plus Gateway-backed e2e conversation paths.
- Negative signals: Coverage is strong for core paths but thinner for long-running and multi-client live scenarios.
- Integration gaps: Coverage is strong for core paths but thinner for long-running and multi-client live scenarios.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Stable (80%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs cover creating and continuing agent conversations; Client source implements conversation send, wait, stream, and normalization helpers.
- Bad qualities: No implementation-quality-specific weakness was identified separately from other gap classes in this scoring slice.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/openclaw-app-sdk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Agent handles, Agent runs, Run results, Session creation, Session send, Session controls.
- Negative signals: Coverage is strong for core paths but thinner for long-running and multi-client live scenarios.
- Missing capability branches: Coverage is strong for core paths but thinner for long-running and multi-client live scenarios.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Coverage is strong for core paths but thinner for long-running and multi-client live scenarios.

## Evidence

### Docs

- `docs/concepts/openclaw-sdk.md:95-151`
- `docs/reference/openclaw-sdk-api-design.md:27-89`
- `docs/gateway/protocol.md:418-442`

### Source

- `packages/sdk/src/client.ts:550-607`
- `packages/sdk/src/client.ts:617-642`
- `packages/sdk/src/client.ts:676-731`
- `packages/sdk/src/types.ts:197-218`
- `packages/sdk/src/types.ts:264-280`

### Integration tests

- `packages/sdk/src/index.e2e.test.ts:378-465`
- `packages/sdk/src/index.e2e.test.ts:566-718`

### Unit tests

- `packages/sdk/src/index.test.ts:64-105`
- `packages/sdk/src/index.test.ts:604-683`
- `packages/sdk/src/index.test.ts:1038-1060`

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

- Score source: `docs/kevinslin/maturity-scorecard/inventory/openclaw-app-sdk/scores.yaml`.
- Taxonomy metadata source: `.agents/skills/claw-score/taxonomy.yaml`.
- OpenClaw source ref: `openclaw@29dd7847fd`.
