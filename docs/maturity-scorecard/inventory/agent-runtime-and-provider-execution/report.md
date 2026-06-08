---
title: "Agent Runtime Maturity Report"
version: 3
last_refreshed: 2026-05-31
last_refreshed_by: codex
---

# Agent Runtime Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Stable (80%)`
- Quality: `Alpha (69%)`
- Completeness: `Stable (80%)`
- LTS Features: `6/9`

## Summary

This report promotes the archived `agent-runtime-and-provider-execution` maturity evidence from `/Users/kevinlin/tmp/maturity/agent-runtime-and-provider-execution` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                              | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | --- | -------------- | ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Agent Turn Execution](agent-turn-orchestration-and-runtime-lifecycle.md)             | ✅  | `Stable (82%)` | `Beta (74%)`  | `Stable (82%)` | Turn startup and runtime choice, Session and run coordination, Abort and terminal outcomes                                                                                                                                                                                                 |
| [External Runtimes and Subagents](cli-harnesses-external-runtimes-and-subagents.md)   | ❌  | `Beta (78%)`   | `Alpha (66%)` | `Beta (78%)`   | External harness selection, CLI runtime aliases, Subagent turns, Runtime recovery                                                                                                                                                                                                          |
| [Hosted Provider Execution](hosted-provider-adapters-and-payload-compatibility.md)    | ✅  | `Beta (76%)`   | `Beta (70%)`  | `Beta (76%)`   | Hosted provider turns, Provider-specific model options, Hosted tool use, Reasoning and cache controls, Hosted streaming and replies                                                                                                                                                        |
| [Local and Self-hosted Providers](local-and-self-hosted-provider-execution.md)        | ❌  | `Beta (70%)`   | `Alpha (60%)` | `Beta (70%)`   | Local provider profiles, Tool-capability flags, Timeouts and context windows, Local smoke checks, Local failure handling                                                                                                                                                                   |
| [Model and Runtime Selection](model-selection-provider-routing-and-runtime-policy.md) | ✅  | `Stable (84%)` | `Beta (72%)`  | `Stable (84%)` | Model reference selection, Provider and runtime overrides, Thinking and context settings, Invalid route recovery                                                                                                                                                                           |
| [Provider Auth](provider-auth-profiles-and-credential-health.md)                      | ✅  | `Stable (80%)` | `Alpha (66%)` | `Stable (80%)` | Login and API-key setup, Auth profile selection, Credential health checks, Auth failover, Provider fallback recovery, Rate-limit and capacity recovery, Missing-key and OAuth guidance, Restart and stale-route recovery, Structured provider diagnostics, Subagent credential propagation |
| [Streaming and Progress](streaming-progress-and-preview-visibility.md)                | ❌  | `Stable (84%)` | `Beta (70%)`  | `Stable (84%)` | Streaming replies, Progress visibility                                                                                                                                                                                                                                                     |
| [Tool Calls and Response Handling](streaming-tool-call-and-response-normalization.md) | ✅  | `Stable (80%)` | `Alpha (66%)` | `Stable (80%)` | Tool-call handling, Usage and response reporting, Failure recovery                                                                                                                                                                                                                         |
| [Tool Execution Controls](tool-execution-approvals-and-sandbox-policy.md)             | ✅  | `Stable (86%)` | `Beta (74%)`  | `Stable (86%)` | Tool availability rules, Sandboxed exec behavior, Approval flow, Elevated execution, Tool safety controls, Delegated tool access                                                                                                                                                           |

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

## Detailed feature inventory

### 1. Agent Turn Execution

Search anchors: agent RPC shape and event stream, runAgentTurnWithFallback, agent.wait timeout and terminal outcomes.

Category note: [Agent Turn Execution](agent-turn-orchestration-and-runtime-lifecycle.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (74%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Turn startup and runtime choice: Starting an agent turn and choosing gateway versus embedded runtime execution.
- Session and run coordination: Establishing session and run ids, queue locks, and related execution coordination.
- Abort and terminal outcomes: Honoring aborts, timing provider/model work, and emitting terminal outcomes.

Primary docs:

- `docs/concepts/agent-loop.md`
- `docs/cli/agent.md`
- `docs/concepts/agent-runtimes.md`

### 2. External Runtimes and Subagents

Search anchors: agent runtimes, subagent turns, CLI runtime aliases.

Category note: [External Runtimes and Subagents](cli-harnesses-external-runtimes-and-subagents.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- External harness selection: Choosing Codex app-server, ACP, and other external runtime harnesses.
- CLI runtime aliases: Runtime aliases and CLI-based execution paths such as Claude CLI and Gemini CLI.
- Subagent turns: Spawning, delivering, and announcing subagent work outside the default embedded path.
- Runtime recovery: Cleanup, timeout, and liveness behavior for external runtimes and subagents.

Primary docs:

- `docs/concepts/agent-runtimes.md`
- `docs/providers/anthropic.md`
- `docs/providers/google.md`
- `docs/tools/subagents.md`

### 3. Hosted Provider Execution

Search anchors: hosted provider turns, provider-specific model options, streaming reply normalization.

Category note: [Hosted Provider Execution](hosted-provider-adapters-and-payload-compatibility.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ✅

Features:

- Hosted provider turns: Running agent turns against hosted providers such as OpenAI, Anthropic, and Google.
- Provider-specific model options: Provider-specific model parameters and runtime request settings exposed to users or operators.
- Hosted tool use: Tool use behavior when the active runtime is a hosted provider.
- Reasoning and cache controls: Provider-specific reasoning, thinking, and cache-related controls during hosted execution.
- Hosted streaming and replies: Operator-visible streaming and reply behavior while hosted adapters normalize payload differences.

Primary docs:

- `docs/providers/openai.md`
- `docs/providers/anthropic.md`
- `docs/providers/google.md`
- `docs/concepts/models.md`

### 4. Local and Self-hosted Providers

Search anchors: Ollama local provider profiles, OpenAI-compatible local servers, local smoke checks.

Category note: [Local and Self-hosted Providers](local-and-self-hosted-provider-execution.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Alpha (60%)`
- Completeness: `Beta (70%)`
- LTS: ❌

Features:

- Local provider profiles: Local model profile configuration for Ollama and OpenAI-compatible local servers.
- Tool-capability flags: Local provider capability flags and behavior for tool use.
- Timeouts and context windows: Local provider timeout and context-window configuration.
- Local smoke checks: Local image and model smoke checks visible to operators.
- Local failure handling: Operator-facing failure handling for local and self-hosted providers.

Primary docs:

- `docs/providers/ollama.md`
- `docs/concepts/models.md`
- `docs/cli/agent.md`

### 5. Model and Runtime Selection

Search anchors: model reference selection, runtime overrides, thinking and context settings.

Category note: [Model and Runtime Selection](model-selection-provider-routing-and-runtime-policy.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Beta (72%)`
- Completeness: `Stable (84%)`
- LTS: ✅

Features:

- Model reference selection: Selecting the model reference for an agent turn from user or configured defaults.
- Provider and runtime overrides: Handling provider selection and runtime overrides for a turn.
- Thinking and context settings: Resolving thinking and context settings as part of model selection.
- Invalid route recovery: Preserving or clearing invalid route state when selections drift or fail.

Primary docs:

- `docs/concepts/models.md`
- `docs/cli/models.md`
- `docs/providers/openai.md`
- `docs/concepts/agent-runtimes.md`

### 6. Provider Auth

Search anchors: login and API-key setup, auth profile selection, provider fallback recovery.

Category note: [Provider Auth](provider-auth-profiles-and-credential-health.md)

Score decisions:

- Coverage: `Stable (80%)`
- Quality: `Alpha (66%)`
- Completeness: `Stable (80%)`
- LTS: ✅

Features:

- Login and API-key setup: Login, OAuth, and paste-key flows for provider access.
- Auth profile selection: Selecting and validating provider auth profiles.
- Credential health checks: Doctor, status, and related credential health checks and repair signals.
- Auth failover: Same-provider and cross-profile auth fallback behavior.
- Provider fallback recovery: Provider and auth-profile fallback behavior when execution fails.
- Rate-limit and capacity recovery: Recovery paths for quota, capacity, and rate-limit failures.
- Missing-key and OAuth guidance: Operator guidance for missing keys, expired OAuth state, and related auth failures.
- Restart and stale-route recovery: Recovery from stale route state, restart requirements, and related provider drift.
- Structured provider diagnostics: Structured provider errors and diagnostics delivered into logs or agent replies.
- Subagent credential propagation: Propagating provider credentials into subagent and delegated runtime flows.

Primary docs:

- `docs/concepts/models.md`
- `docs/cli/agent.md`
- `docs/cli/models.md`
- `docs/providers/openai.md`
- `docs/providers/anthropic.md`
- `docs/providers/google.md`
- `docs/tools/subagents.md`

### 7. Streaming and Progress

Search anchors: streaming replies, progress visibility, event delivery.

Category note: [Streaming and Progress](streaming-progress-and-preview-visibility.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Beta (70%)`
- Completeness: `Stable (84%)`
- LTS: ❌

Features:

- Streaming replies: Streaming block updates and partial assistant output before final delivery.
- Progress visibility: Progress preview events and item lifecycle updates surfaced during execution.

Primary docs:

- `docs/concepts/streaming.md`
- `docs/concepts/agent-loop.md`

### 8. Tool Calls and Response Handling

Search anchors: tool-call handling, usage reporting, failure recovery.

Category note: [Tool Calls and Response Handling](streaming-tool-call-and-response-normalization.md)

Score decisions:

- Coverage: `Stable (80%)`
- Quality: `Alpha (66%)`
- Completeness: `Stable (80%)`
- LTS: ✅

Features:

- Tool-call handling: Reliable tool-call behavior across providers, including malformed or provider-specific payload differences.
- Usage and response reporting: Response ids and usage accounting normalized into operator-visible runtime behavior.
- Failure recovery: Failure-stream finalization and cleanup when provider output is malformed or incomplete.

Primary docs:

- `docs/concepts/agent-loop.md`
- `docs/providers/ollama.md`

### 9. Tool Execution Controls

Search anchors: tool availability rules, sandboxed exec behavior, approval flow.

Category note: [Tool Execution Controls](tool-execution-approvals-and-sandbox-policy.md)

Score decisions:

- Coverage: `Stable (86%)`
- Quality: `Beta (74%)`
- Completeness: `Stable (86%)`
- LTS: ✅

Features:

- Tool availability rules: Which tools are available during a turn after policy resolution and provider-based suppression.
- Sandboxed exec behavior: Exec behavior, sandbox roots, and workspace constraints visible to operators.
- Approval flow: Operator approval gates for tool execution.
- Elevated execution: Elevated host execution rules and related controls.
- Tool safety controls: Before-tool-call hooks and related guardrails that shape operator-visible tool behavior.
- Delegated tool access: Inherited or narrowed tool policy for subagents and delegated execution.

Primary docs:

- `docs/gateway/sandbox-vs-tool-policy-vs-elevated.md`
- `docs/concepts/agent-loop.md`
- `docs/tools/subagents.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/agent-runtime-and-provider-execution/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/agent-runtime-and-provider-execution`.
