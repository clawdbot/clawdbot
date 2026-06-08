---
title: "OpenClaw App SDK - Events and Approvals Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# OpenClaw App SDK - Events and Approvals Maturity Note

## Summary

Docs and types include event and approval concepts. Client source normalizes events and exposes wait/listen helpers. Tests cover event normalization, e2e event receipt, and method scopes.

## Category Scope

This category covers the taxonomy-defined Events and Approvals capability area for the OpenClaw App SDK surface.

## Features

- Event stream: SDK stream subscription for app-wide and per-run events.
- Event envelope: Stable event envelope for external clients.
- Replay cursors: Replayable event families with stable cursors.
- Approval callbacks: First-class approval handling for external apps.
- Questions: Question handling alongside approval flows.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Docs and types include event and approval concepts; Client source normalizes events and exposes wait/listen helpers; Tests cover event normalization, e2e event receipt, and method scopes.
- Negative signals: Approval callbacks and questions remain mostly design-level rather than fully ergonomic SDK flows; Completeness is limited by gaps between low-level protocol events and first-class app developer APIs.
- Integration gaps: Approval callbacks and questions remain mostly design-level rather than fully ergonomic SDK flows; Completeness is limited by gaps between low-level protocol events and first-class app developer APIs.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (73%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs and types include event and approval concepts; Client source normalizes events and exposes wait/listen helpers.
- Bad qualities: Approval callbacks and questions remain mostly design-level rather than fully ergonomic SDK flows; Completeness is limited by gaps between low-level protocol events and first-class app developer APIs.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Alpha (58%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/openclaw-app-sdk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Event stream, Event envelope, Replay cursors, Approval callbacks, Questions.
- Negative signals: Approval callbacks and questions remain mostly design-level rather than fully ergonomic SDK flows; Completeness is limited by gaps between low-level protocol events and first-class app developer APIs.
- Missing capability branches: Approval callbacks and questions remain mostly design-level rather than fully ergonomic SDK flows; Completeness is limited by gaps between low-level protocol events and first-class app developer APIs.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Approval callbacks and questions remain mostly design-level rather than fully ergonomic SDK flows.
- Completeness is limited by gaps between low-level protocol events and first-class app developer APIs.

## Evidence

### Docs

- `docs/concepts/openclaw-sdk.md:153-212`
- `docs/concepts/openclaw-sdk.md:253-258`
- `docs/reference/openclaw-sdk-api-design.md:91-112`
- `docs/reference/openclaw-sdk-api-design.md:187-215`
- `docs/gateway/protocol.md:469-475`
- `docs/gateway/protocol.md:631-640`

### Source

- `packages/sdk/src/types.ts:220-262`
- `packages/sdk/src/client.ts:373-473`
- `packages/sdk/src/client.ts:518-540`
- `packages/sdk/src/normalize.ts:67-153`
- `packages/sdk/src/client.ts:833-842`

### Integration tests

- `packages/sdk/src/index.e2e.test.ts:380-415`
- `packages/sdk/src/index.e2e.test.ts:503-508`
- `src/gateway/method-scopes.test.ts:293-304`

### Unit tests

- `packages/sdk/src/index.test.ts:650-682`
- `packages/sdk/src/index.test.ts:775-780`
- `packages/sdk/src/index.test.ts:984-1035`

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
