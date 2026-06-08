---
title: "OpenClaw App SDK - Resource Helpers Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# OpenClaw App SDK - Resource Helpers Maturity Note

## Summary

Docs and source include typed resource helper concepts and basic helper implementation. Unit and e2e tests cover selected helper methods.

## Category Scope

This category covers the taxonomy-defined Resource Helpers capability area for the OpenClaw App SDK surface.

## Features

- Models: Typed model discovery helpers.
- ToolSpace: Tool discovery and invocation abstraction for external apps.
- Artifacts: Artifact summaries, retention metadata, and download behavior.
- Tasks: SDK helpers around Gateway task APIs.
- Environments: Managed environment provider lifecycle and metadata.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (58%)`
- Positive signals: Docs and source include typed resource helper concepts and basic helper implementation; Unit and e2e tests cover selected helper methods.
- Negative signals: Live/runtime coverage for helper workflows is thin; Helper breadth is not yet at the same maturity as client and conversation APIs.
- Integration gaps: Live/runtime coverage for helper workflows is thin; Helper breadth is not yet at the same maturity as client and conversation APIs.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs and source include typed resource helper concepts and basic helper implementation.
- Bad qualities: Helper breadth is not yet at the same maturity as client and conversation APIs.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/openclaw-app-sdk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Models, ToolSpace, Artifacts, Tasks, Environments.
- Negative signals: Live/runtime coverage for helper workflows is thin; Helper breadth is not yet at the same maturity as client and conversation APIs.
- Missing capability branches: Live/runtime coverage for helper workflows is thin; Helper breadth is not yet at the same maturity as client and conversation APIs.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Live/runtime coverage for helper workflows is thin.
- Helper breadth is not yet at the same maturity as client and conversation APIs.

## Evidence

### Docs

- `docs/concepts/openclaw-sdk.md:214-290`
- `docs/reference/openclaw-sdk-api-design.md:217-280`
- `docs/reference/openclaw-sdk-api-design.md:313-345`

### Source

- `packages/sdk/src/client.ts:749-866`
- `packages/sdk/src/client.ts:214-226`
- `packages/sdk/src/types.ts:43-53`
- `packages/sdk/src/types.ts:74-171`

### Integration tests

- `packages/sdk/src/index.e2e.test.ts:467-534`
- `packages/sdk/src/index.e2e.test.ts:662-681`

### Unit tests

- `packages/sdk/src/index.test.ts:392-602`

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
