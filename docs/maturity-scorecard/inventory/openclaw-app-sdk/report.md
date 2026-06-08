---
title: "OpenClaw App SDK Maturity Report"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# OpenClaw App SDK Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (75%)`
- Quality: `Beta (75%)`
- Completeness: `Alpha (69%)`
- LTS Features: `0/6`

## Summary

OpenClaw App SDK has a real implemented `@openclaw/sdk` package with docs, typed exports, WebSocket e2e coverage, real Gateway event e2e coverage, package-consumer e2e coverage, and env-gated live Gateway proof. Main limiters are private/0.0.0-private packaging, missing `sdk-react` and `sdk-testing`, incomplete `gateway: "auto"` and high-level scope knobs, design-only generated client, design-only approval callbacks/questions, and thin live/runtime coverage for helpers.

This report was scored from `source_ref=openclaw@29dd7847fd` with one subagent dedicated to this surface. Global archive freshness checks passed before scoring: `gitcrawl doctor --json` and `discrawl status --json`.

## Matrix

| Category                                        | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                               |
| ----------------------------------------------- | --- | -------------- | -------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| [Client API](client-api.md)                     | ❌  | `Stable (86%)` | `Stable (82%)` | `Beta (78%)`   | SDK entrypoints, Namespace layout, Package split, App/plugin boundary                              |
| [Gateway Access](gateway-access.md)             | ❌  | `Beta (78%)`   | `Beta (74%)`   | `Alpha (64%)`  | Gateway connect, URL and token config, Auto gateway, Custom transport, Scopes and redaction        |
| [Agent Conversations](agent-conversations.md)   | ❌  | `Beta (78%)`   | `Stable (80%)` | `Stable (84%)` | Agent handles, Agent runs, Run results, Session creation, Session send, Session controls           |
| [Events and Approvals](events-and-approvals.md) | ❌  | `Beta (74%)`   | `Beta (73%)`   | `Alpha (58%)`  | Event stream, Event envelope, Replay cursors, Approval callbacks, Questions                        |
| [Resource Helpers](resource-helpers.md)         | ❌  | `Alpha (58%)`  | `Beta (72%)`   | `Beta (70%)`   | Models, ToolSpace, Artifacts, Tasks, Environments                                                  |
| [Compatibility](compatibility.md)               | ❌  | `Beta (76%)`   | `Beta (70%)`   | `Alpha (62%)`  | Generated client, Ergonomic wrappers, Unsupported calls, Schema alignment, Public package contract |

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
