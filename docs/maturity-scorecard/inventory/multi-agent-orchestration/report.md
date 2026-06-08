---
title: "Multi-agent orchestration Maturity Report"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Multi-agent orchestration Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (72%)`
- Quality: `Beta (78%)`
- Completeness: `Beta (78%)`
- LTS Features: `0/6`

## Summary

Multi-agent orchestration is Beta overall. Setup, isolation, routing, account routing, and specialist lanes have strong docs/source/test coverage; the surface stays below Stable because full live multi-channel e2e proof is limited and delegate identity remains more policy/runbook-shaped than an enforced product workflow.

This report was scored from `source_ref=openclaw@29dd7847fd` with one subagent dedicated to this surface. Global archive freshness checks passed before scoring: `gitcrawl doctor --json` and `discrawl status --json`.

## Matrix

| Category                                        | LTS | Coverage             | Quality        | Completeness   | Features to evaluate                                                                             |
| ----------------------------------------------- | --- | -------------------- | -------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| [Agent Setup](agent-setup.md)                   | ❌  | `Beta (74%)`         | `Stable (82%)` | `Stable (84%)` | Add agents, Agent list and delete, Identity files, Non-interactive setup, Single-agent default   |
| [Agent Isolation](agent-isolation.md)           | ❌  | `Stable (82%)`       | `Beta (78%)`   | `Beta (76%)`   | Workspace separation, State separation, Auth separation, Session separation, Tool profiles       |
| [Conversation Routing](conversation-routing.md) | ❌  | `Beta (76%)`         | `Stable (84%)` | `Stable (86%)` | Agent selection, Route precedence, Default fallback, Peer overrides, Cross-channel examples      |
| [Account Routing](account-routing.md)           | ❌  | `Beta (78%)`         | `Stable (84%)` | `Stable (82%)` | Multi-account setup, Account selection, Default accounts, Account credentials, Delivery targets  |
| [Specialist Lanes](specialist-lanes.md)         | ❌  | `Beta (78%)`         | `Beta (74%)`   | `Beta (76%)`   | Lane contracts, Background handoff, Concurrency controls, Priority controls, Coordinator handoff |
| [Delegate Identities](delegate-identities.md)   | ❌  | `Experimental (45%)` | `Alpha (68%)`  | `Alpha (62%)`  | Named delegates, Authority model, Delegate tiers, Identity delegation, Organizational assistants |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.
