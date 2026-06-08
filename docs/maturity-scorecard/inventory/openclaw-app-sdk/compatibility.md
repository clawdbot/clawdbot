---
title: "OpenClaw App SDK - Compatibility Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# OpenClaw App SDK - Compatibility Maturity Note

## Summary

Docs identify package/runtime compatibility and design expectations. Source has versioned package exports and transport compatibility handling. Tests cover package consumption and Gateway-backed SDK behavior.

## Category Scope

This category covers the taxonomy-defined Compatibility capability area for the OpenClaw App SDK surface.

## Features

- Generated client: Client generation from Gateway schemas.
- Ergonomic wrappers: Handwritten wrappers layered on generated transport contracts.
- Unsupported calls: Explicit errors for unsupported environment mutations and future per-run overrides.
- Schema alignment: SDK behavior stays aligned with Gateway schemas.
- Public package contract: Package publication and reusable-client expectations tracked explicitly.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Docs identify package/runtime compatibility and design expectations; Source has versioned package exports and transport compatibility handling; Tests cover package consumption and Gateway-backed SDK behavior.
- Negative signals: Generated client path is design-only; Missing companion packages and private package status lower completeness.
- Integration gaps: Generated client path is design-only; Missing companion packages and private package status lower completeness.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs identify package/runtime compatibility and design expectations; Source has versioned package exports and transport compatibility handling.
- Bad qualities: Generated client path is design-only; Missing companion packages and private package status lower completeness.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Alpha (62%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/openclaw-app-sdk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Generated client, Ergonomic wrappers, Unsupported calls, Schema alignment, Public package contract.
- Negative signals: Generated client path is design-only; Missing companion packages and private package status lower completeness.
- Missing capability branches: Generated client path is design-only; Missing companion packages and private package status lower completeness.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Generated client path is design-only.
- Missing companion packages and private package status lower completeness.

## Evidence

### Docs

- `docs/concepts/openclaw-sdk.md:24-45`
- `docs/concepts/openclaw-sdk.md:275-290`
- `docs/reference/openclaw-sdk-api-design.md:347-363`

### Source

- `packages/sdk/src/client.ts:162-200`
- `packages/sdk/src/client.ts:303-333`
- `packages/sdk/src/client.ts:846-866`
- `packages/sdk/src/transport.ts:69-148`
- `packages/sdk/package.json:1-23`

### Integration tests

- `packages/sdk/src/index.e2e.test.ts:378-425`
- `packages/sdk/src/index.e2e.test.ts:566-718`
- `packages/sdk/src/package.e2e.test.ts:208-273`

### Unit tests

- `packages/sdk/src/index.test.ts:326-359`
- `packages/sdk/src/index.test.ts:456-466`

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
