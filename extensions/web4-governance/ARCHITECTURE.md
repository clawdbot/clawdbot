# Web4 Governance Plugin — Architecture & Cross-Project Context

## What This Is

The `web4-governance` plugin is a **Tier 1 (Observational)** implementation of the
Web4 R6 framework, running inside the moltbot agent runtime. It creates verifiable
audit trails for every tool call an agent makes, without blocking or requiring
approval.

This is the first live integration of Web4 governance into an agent runtime that
actually executes tools — not a simulation or demo.

## Where It Sits in the Web4 Stack

```
┌─────────────────────────────────────────────────────────────┐
│                   Hardbound (Tier 2)                        │
│   Full Policy │ Trust Tensors │ ATP │ Hardware Binding       │
│   hardbound-core/src/policy.rs                              │
│   hardbound/src/policy.ts                                   │
└───────────────────────────┬─────────────────────────────────┘
                            │ upgrade path
┌───────────────────────────┴─────────────────────────────────┐
│          web4-governance (Tier 1 + 1.5) ← YOU ARE HERE      │
│   R6 Audit │ Soft LCT │ Hash Chain │ Policy Engine │ CLI    │
│   moltbot/extensions/web4-governance/                       │
└───────────────────────────┬─────────────────────────────────┘
                            │ hooks into
┌───────────────────────────┴─────────────────────────────────┐
│                  Moltbot Agent Runtime                       │
│   pi-tools.hooks.ts (before_tool_call / after_tool_call)    │
│   moltbot/src/agents/pi-tools.ts                            │
└─────────────────────────────────────────────────────────────┘
```

### R6 Implementation Tiers (from web4-standard/core-spec/r6-implementation-guide.md)

| Tier | Project | R6 Scope | Trust Model | Enforcement |
|------|---------|----------|-------------|-------------|
| **1 — Observational** | web4-governance (this plugin) | Lite: audit_level, session token, tool/category/target/hash, chain position | None (relying party decides) | Record-only |
| **1.5 — Policy** | web4-governance (this plugin) | Lite + configurable policy rules, allow/deny/warn, glob/regex matching | Rule-based (first-match-wins) | Block or warn (with dry-run mode) |
| **2 — Authorization** | hardbound-core (Rust) | Full: policy rules, actor LCT, team context, ATP, trust delta | T3 tensor (competence, reliability, integrity) | Approve/Reject/Escalate |
| **3 — Training** | HRM/SAGE | Training: exercise type, mode detection, meta-cognitive | T3 with developmental trajectory | Include/Exclude/Review |

## What Was Built (PRs #1 and #2)

### PR #1: Tool Call Hooks (`src/agents/pi-tools.hooks.ts`)
- Wired `before_tool_call` / `after_tool_call` typed plugin hooks into moltbot's tool execution pipeline
- `before_tool_call` can modify params or block execution (returns `{ block: true, blockReason }`)
- `after_tool_call` fires post-execution with result, error, and duration (fire-and-forget)
- This is the hook surface that enables both observation (Tier 1) and enforcement (Tier 2)

### PR #2: Web4 Governance Plugin (`extensions/web4-governance/`)
- **R6 framework** (`src/r6.ts`): Creates structured R6 requests from tool calls. Classifies tools into categories (file_read, file_write, command, network, delegation, state). Hashes inputs and extracts targets.
- **Audit chain** (`src/audit.ts`): Hash-linked JSONL append log. Each record's `prevRecordHash` is the SHA-256 prefix of the previous line. Verifiable integrity.
- **Session state** (`src/session-state.ts`): Tracks action index, tool/category counts, last R6 ID per session.
- **Soft LCT** (`src/soft-lct.ts`): Software-bound identity token from `hostname:username` hash. Not hardware-bound — that's the Hardbound upgrade path.

## Relationship to Hardbound

### What's shared (protocol-compatible)
- R6 request structure (Tier 1 is a subset of Tier 2)
- Audit record format (Tier 1 records can be imported into Tier 2)
- Tool categories map to Hardbound `ActionType` enum
- Hash-linked provenance chain
- Session identity concept (Soft LCT → Hardware LCT upgrade path)

### What Hardbound adds (Tier 2, proprietary)
- **PolicyEngine** (`policy.rs`): Evaluates R6 requests against rules, roles, trust thresholds, ATP balance. Returns Approve/Reject/Escalate/AutoApprove.
- **T3 Trust Tensors**: competence, reliability, integrity scoring with context weights
- **Coherence Metrics**: score + delta tracking with attestation
- **ATP Economics**: Resource allocation, daily limits, transfer caps
- **Hardware Binding**: TPM/SE-based LCT (P0 blocker, not yet implemented)
- **Governance Rules**: Role-based (developer, lead, admin, viewer, guest), action-type scoped, with prohibited requirements and auto-approve thresholds

### The upgrade path
The R6 implementation guide documents a progressive adoption model:
1. **Start**: Install web4-governance plugin (observational audit trail)
2. **Grow**: Add policy evaluation in `before_tool_call` (this is the next step)
3. **Extend**: Connect to Hardbound for full T3/ATP/hardware-bound governance

## Tier 1.5: Policy Engine (Implemented)

The policy engine uses the `before_tool_call` hook to evaluate configurable rules
before each tool call. Rules match by tool name, category, and target pattern
(glob or regex). Decisions are allow, deny, or warn. Deny decisions block tool
execution when `enforce: true`; in dry-run mode (`enforce: false`), denials are
logged but not enforced.

### What was built
- **Policy types** (`src/policy-types.ts`): `PolicyRule`, `PolicyMatch`, `PolicyConfig`, `PolicyEvaluation`, `PolicyDecision`
- **Matchers** (`src/matchers.ts`): Glob-to-regex conversion, list matching, target pattern matching, composite AND-logic rule matching
- **PolicyEngine** (`src/policy.ts`): Loads rules, sorts by priority (ascending), first-match-wins evaluation, `shouldBlock()` for enforcement
- **Integration** (`index.ts`): `before_tool_call` hook evaluates policy and blocks if deny + enforce; `after_tool_call` picks up stashed evaluation and writes constraints to R6 `rules.constraints`
- **CLI** (`index.ts`): `moltbot policy status`, `moltbot policy rules`, `moltbot policy test <tool> [target]`

### Deferred to Phase 2
- Rate limiting (needs windowed counters in session state)
- Config hot-reload
- T3/ATP integration (that's Tier 2 / Hardbound)

### What this enables for Hardbound
The upgrade to Tier 2 is:
- Replace rule evaluation with PolicyEngine from hardbound-core
- Add T3 tensor snapshots to audit records
- Add coherence metrics
- Replace Soft LCT with hardware-bound LCT
- Add ATP tracking

The plugin interface stays the same — just the policy evaluation gets richer.

## Storage Layout

```
~/.moltbot/extensions/web4-governance/
├── audit/
│   └── <sessionId>.jsonl     # Hash-linked audit records (append-only)
└── sessions/
    └── <sessionId>.json      # Session metadata (overwritten on each action)
```

## Cross-Project References

| File | Project | Relevance |
|------|---------|-----------|
| `web4-standard/core-spec/r6-implementation-guide.md` | web4 | Tier definitions, ID formats, upgrade path |
| `web4-standard/core-spec/r6-security-analysis.md` | web4 | Attack vectors and mitigations |
| `hardbound-core/src/policy.rs` | hardbound | Full policy engine (Rust) |
| `hardbound/src/policy.ts` | hardbound | TypeScript policy with rule builder |
| `hardbound/tests/policy.test.ts` | hardbound | Policy test patterns |
| `hardbound-core/src/r6.rs` | hardbound | Full R6 request (Rust) |
| `hardbound/MVP_IMPLEMENTATION.md` | hardbound | MVP status, bundle schema, lessons |
| `src/agents/pi-tools.hooks.ts` | moltbot | Hook wrapper (our PR #1) |
| `src/plugins/hooks.ts` | moltbot | Hook runner (runBeforeToolCall/runAfterToolCall) |
