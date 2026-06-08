---
title: "Multi-agent orchestration - Conversation Routing Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Multi-agent orchestration - Conversation Routing Maturity Note

## Summary

Docs and source cover channel route resolution, configured matches, and delivery behavior. Tests include routing unit tests, Matrix bind integration, and live Gateway bind coverage.

## Category Scope

This category covers the taxonomy-defined Conversation Routing capability area for the Multi-agent orchestration surface.

## Features

- Agent selection: Resolve inbound messages to the correct agent.
- Route precedence: Apply deterministic match order and tie-breaking.
- Default fallback: Fall back to the configured default agent.
- Peer overrides: Route specific peers or groups to a chosen agent.
- Cross-channel examples: Reuse routing patterns across Discord, Telegram, WhatsApp, and similar channels.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Docs and source cover channel route resolution, configured matches, and delivery behavior; Tests include routing unit tests, Matrix bind integration, and live Gateway bind coverage.
- Negative signals: Full live multi-channel routing proof remains limited.
- Integration gaps: Full live multi-channel routing proof remains limited.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Stable (84%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs and source cover channel route resolution, configured matches, and delivery behavior.
- Bad qualities: No implementation-quality-specific weakness was identified separately from other gap classes in this scoring slice.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Stable (86%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/multi-agent-orchestration.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Agent selection, Route precedence, Default fallback, Peer overrides, Cross-channel examples.
- Negative signals: Full live multi-channel routing proof remains limited.
- Missing capability branches: Full live multi-channel routing proof remains limited.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Full live multi-channel routing proof remains limited.

## Evidence

### Docs

- `docs/concepts/multi-agent.md:210`
- `docs/channels/channel-routing.md:75`
- `docs/cli/agents.md:34`

### Source

- `src/routing/resolve-route.ts:610`
- `src/channels/plugins/configured-binding-match.ts:17`
- `src/channels/plugins/binding-routing.ts:69`

### Integration tests

- `src/commands/agents.bind.matrix.integration.test.ts:21`
- `src/gateway/gateway-codex-bind.live.test.ts:466`

### Unit tests

- `src/routing/resolve-route.test.ts:101`

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
