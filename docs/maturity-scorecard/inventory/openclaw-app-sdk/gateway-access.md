---
title: "OpenClaw App SDK - Gateway Access Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# OpenClaw App SDK - Gateway Access Maturity Note

## Summary

Docs cover Gateway URL/auth setup, protocol connection expectations, and endpoint behavior. Transport source includes WebSocket setup and request handling. E2E tests exercise Gateway-backed SDK behavior and connection failures.

## Category Scope

This category covers the taxonomy-defined Gateway Access capability area for the OpenClaw App SDK surface.

## Features

- Gateway connect: SDK construction for explicit Gateway connections.
- URL and token config: URL, token, and auth inputs for external clients.
- Auto gateway: Automatic Gateway discovery behavior for supported environments.
- Custom transport: Transport injection for non-default client environments.
- Scopes and redaction: Token scopes, secret-forwarding defaults, and redaction boundaries.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Docs cover Gateway URL/auth setup, protocol connection expectations, and endpoint behavior; Transport source includes WebSocket setup and request handling; E2E tests exercise Gateway-backed SDK behavior and connection failures.
- Negative signals: `gateway: "auto"` remains incomplete; Access ergonomics and discovery are thinner than the underlying transport.
- Integration gaps: `gateway: "auto"` remains incomplete; Access ergonomics and discovery are thinner than the underlying transport.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs cover Gateway URL/auth setup, protocol connection expectations, and endpoint behavior; Transport source includes WebSocket setup and request handling.
- Bad qualities: `gateway: "auto"` remains incomplete; Access ergonomics and discovery are thinner than the underlying transport.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/openclaw-app-sdk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Gateway connect, URL and token config, Auto gateway, Custom transport, Scopes and redaction.
- Negative signals: `gateway: "auto"` remains incomplete; Access ergonomics and discovery are thinner than the underlying transport.
- Missing capability branches: `gateway: "auto"` remains incomplete; Access ergonomics and discovery are thinner than the underlying transport.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- `gateway: "auto"` remains incomplete.
- Access ergonomics and discovery are thinner than the underlying transport.

## Evidence

### Docs

- `docs/concepts/openclaw-sdk.md:60-93`
- `docs/reference/openclaw-sdk-api-design.md:282-311`
- `docs/gateway/protocol.md:45-90`
- `docs/gateway/protocol.md:223-245`

### Source

- `packages/sdk/src/client.ts:35-52`
- `packages/sdk/src/client.ts:323-331`
- `packages/sdk/src/transport.ts:21-55`
- `packages/sdk/src/transport.ts:69-148`

### Integration tests

- `packages/sdk/src/index.e2e.test.ts:378-385`
- `packages/sdk/src/index.e2e.test.ts:569-629`
- `packages/sdk/src/index.e2e.test.ts:662-718`
- `packages/gateway-client/src/client.watchdog.test.ts:482`

### Unit tests

- None identified in this scoring slice.

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
