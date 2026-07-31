# Swarms — agent fan-out and orchestration in code mode

Status: Shipped — superseded by `docs/tools/swarm.md`. This document remains as
the implementation design record.

## 1. What and why

A **swarm** is many subagents orchestrated deterministically from a code-mode
script: fan out N readers, verify findings adversarially, synthesize through a
stateful prioritizer, loop on decision gates. Control flow (`Promise.all`,
`while`, `if`) _is_ the orchestration — there is deliberately **no graph DSL,
no new mode, no new top-level tool surface**.

OpenClaw code mode (QuickJS-WASI, snapshot/resume, bridge requests) is the
substrate. A parked bridge call survives VM snapshot, gateway restart, and
resumes exactly where it stopped — stronger than journal-replay designs, with
no determinism constraints on scripts.

Naming: product/docs name is **Swarm**. Code identifiers stay literal:
`agents.*` guest API, `tools.swarm` config, `swarm` group columns.

## 2. Decisions (maintainer, 2026-07-17)

- Cost: enforced config caps; per-swarm token budget optional. No mandatory budget.
- Approvals: children run **fail-closed / non-interactive**. Approval-requiring
  actions are denied; the denial is reported in the child result; the script
  decides. No operator prompt spam from fan-out.
- v1 is model-written ad-hoc scripts only. Saved/named workflows, CLI/cron
  entry: later (headless code mode already exists for cron).
- Child identity: dedicated worker agent by default via `tools.swarm.defaultAgentId`
  config (validated against existing subagent target allowlist); per-spawn
  `agentId` override. Core ships no bundled agent id; docs recommend a lean
  `worker` agent config.
- No Codex source changes. Codex harness uses the spawn/wait idiom (§8).

## 3. Architecture overview

```
code-mode script (QuickJS VM, gateway)          Codex V8 script (codex process)
  agents.run(...) ── parked bridge call           tools.sessions_spawn / tools.agents_wait
        │                                                │ item/tool/call RPC (≤600s each)
        ▼                                                ▼
             CORE (harness-agnostic, this repo)
  sessions_spawn {collect:true, outputSchema, fastMode, groupId}
  agents_wait {ids, timeoutSeconds}
        │
  subagent registry (SQLite): collector completion records, swarm group id
        │
  children = ordinary subagent sessions (lane-capped, fail-closed approvals)
        │
  sessions.changed SSE ──► Control UI dots / sidebar / channel status message
```

One canonical owner of spawn/complete/settle semantics (core tools + registry).
Two await transports: QuickJS parks a bridge call indefinitely (snapshot);
Codex polls `agents_wait` in bounded RPCs.

## 4. Config gate (v1)

New `tools.swarm` (global + per-agent override, same merge pattern as
`tools.codeMode`):

```jsonc
"tools": {
  "swarm": {
    "enabled": false,            // master gate, default OFF
    "maxConcurrent": 8,          // children running at once (swarm lane cap)
    "maxChildrenPerGroup": 50,   // live children per swarm group
    "maxTotalPerGroup": 200,     // lifetime spawn count per group (runaway backstop)
    "waitTimeoutSecondsMax": 600,
    "defaultAgentId": ""         // optional; child agent id when spawn omits agentId
  }
}
```

- Zod: union `boolean | strict object` like `CodeModeSchema`
  (`src/config/zod-schema.agent-runtime.ts`); `swarm: true` → `{enabled: true}`.
- Types in `src/config/types.tools.ts` (both per-agent and top-level `tools`),
  labels in `schema.labels.ts`, help in `schema.help.runtime.ts`.
- Resolution helper `resolveSwarmConfig(cfg, agentId)` mirroring
  `resolveCodeModeConfig` (`src/agents/code-mode.ts:215`), clamping all numbers.
- Gate effects when disabled: `agents_wait` tool absent from catalogs;
  `collect`/`outputSchema`/`fastMode`/`groupId` params on `sessions_spawn`
  rejected with a clear error naming the config key. No other behavior change.
- `defaultAgentId` is validated through `resolveSubagentAllowedTargetIds`
  (`src/agents/subagent-target-policy.ts`); unknown id → spawn error, not fallback.

## 5. Core: collector-mode spawn + `agents_wait` (v1)

### 5.1 `sessions_spawn` additions (all gated on swarm enabled)

- `collect: boolean` — when true, the child run is registered with
  `expectsCompletionMessage: false` and a **collector completion record**
  instead of announce/steering delivery. Tool returns `{ runId, sessionKey }`
  immediately. No channel/thread binding.
- `outputSchema: object` — JSON Schema. Child gets a synthetic
  `structured_output` tool appended to its tool surface; system-prompt addendum
  instructs it to call it exactly once with its final result. On validation
  failure the child gets one nudge retry; after that the completion record
  carries `structured: undefined` plus the raw text and a `schemaError`.
- `fastMode: true | "auto" | false` — threaded into the child session patch
  alongside model/thinking via `resolveSubagentModelAndThinkingPlan`
  (`src/agents/subagent-spawn-plan.ts`), using the existing `FastMode` axis
  (`src/shared/fast-mode.ts`). Omitted = inherit.
- `groupId: string` — swarm group stamp. Defaults to
  `swarm:<requesterSessionKey>:<runId-of-requesting-run>`. Persisted on the
  registry record and the child session row. Used for caps, listing, batch
  archive, and the dots.
- `label: string` already exists — surfaces in dots and `subagents list`.
- Child agent id: `params.agentId` → else `tools.swarm.defaultAgentId` → else
  requester agent (existing behavior).

### 5.2 Approvals fail-closed

Collector children run with a non-interactive approval context: any tool call
that would require operator approval resolves as a structured denial
(`approval_required`) visible to the child, which is expected to report the
blockage in its result. Implementation: reuse the existing exec/tool approval
policy plumbing with a forced `deny` resolver for collector-mode child runs.
No approval events are emitted to operator surfaces from collector children.

### 5.3 `agents_wait` tool (new, gated)

```
agents_wait({ ids: string[], timeoutSeconds?: number })
→ {
    completed: [{ runId, status: "done"|"failed"|"killed"|"timeout",
                  result: string, structured?: unknown, schemaError?: string,
                  sessionKey, label?, usage?: {inputTokens, outputTokens} }],
    pending: string[]
  }
```

- Returns as soon as **at least one** id completes (first-completion / race
  semantics, enables pipelines), or on timeout with `completed: []`.
- `timeoutSeconds` default 30, clamped to `waitTimeoutSecondsMax`.
- Idempotent: already-completed ids return their records again (records are
  kept until group archive). Unknown id → per-id error entry, not a throw.
- Ownership: only the session that spawned a run (or its parent chain) may wait
  on it — same ownership rule as `wait` in code mode (`code-mode.ts:1684`).
- Registry: completion records live in the existing subagent registry SQLite
  store (`subagent-registry.store.sqlite.ts`) — new fields, no new store, no
  schema-version bump (additive columns only; see §9 constraint).

### 5.4 Caps enforcement

- `maxConcurrent`: collector children run on the existing subagent lane but
  counted per swarm group; spawns beyond the cap queue FIFO (host-side, in the
  spawn path — return runId immediately, run starts when a slot frees).
- `maxChildrenPerGroup` / `maxTotalPerGroup`: spawn rejects with a typed error
  once exceeded; the error text names the config key.
- Depth: collector children keep `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH` semantics
  (children are leaves unless nesting explicitly configured).

## 6. Testing contract (v1, lane A)

- Unit: config resolution/clamping; gate rejections when disabled; groupId
  defaulting; cap enforcement (queue + reject); wait race semantics; wait
  idempotency; ownership denial; structured-output validation + nudge retry +
  schemaError path; fastMode plumbing into session patch; defaultAgentId
  validation.
- Integration (vitest, mock model runtime): spawn 3 collector children, wait
  in a loop, assert first-completion ordering and final drain; gateway-restart
  simulation: registry reload → wait resolves from persisted completion.
- All tests colocated `*.test.ts`; no live model calls.

## 7. QuickJS guest surface (lane B, after core)

- Guest globals installed in `CONTROLLER_SOURCE`
  (`src/agents/code-mode.worker.ts:190-374`), reserved names added in
  `code-mode-namespaces.ts`:
  - `agents.run(prompt, opts) → Promise<result|structured>` — sugar:
    collector spawn + parked await on a dedicated bridge method (`agentWait`)
    that the host settles on completion (no polling; snapshot-safe).
  - `agents.session(system, opts) → Promise<handle>`;
    `handle.send(input, opts) → Promise<...>`; `handle.close()`. (v1.1 —
    ships after run(); uses `mode:"session"` + per-turn collector records.)
  - `phase(title)`, `log(message)` — fire-and-forget bridge notifications →
    swarm progress events.
- Bridge methods added to `CodeModeBridgeMethod` (`code-mode.ts:91`):
  `agentSpawn`, `agentWait`, `swarmNote`. `agentSpawn`/`agentWait` are
  replay-safe **by construction**: idempotency key `(codeModeRunId, bridgeId)`
  stored on the registry record; restart re-settles from persisted completions
  and never double-spawns.
- Pending `agentWait` bridge calls extend the run's snapshot TTL (pending
  agent set is the signal; no flag).
- `API.read("agents.d.ts")` virtual file documents the typed surface + the
  fan-out / gate / cycle idioms (`createCodeModeApiVirtualFiles`,
  `code-mode-namespaces.ts:876`).

## 8. Codex harness projection (later lane)

- `sessions_spawn` (with new params) and `agents_wait` flow through the
  existing dynamic-tool bridge; inside Codex code-mode scripts they appear as
  `tools.*` automatically (verified: `codex-rs/code-mode/src/runtime/globals.rs:14-65`,
  `codex-rs/core/src/tools/spec_plan.rs:448-507`).
- `agents_wait` gets the long dynamic-tool timeout class (600s cap;
  `extensions/codex/src/app-server/dynamic-tool-execution.ts:37-39`) and is
  marked timeout/replay-safe.
- Group key for Codex parents: `swarm:<parentSessionKey>:<turnId>`.
- Codex-native `spawn_agent` subagents coexist; their task-mirror rows feed
  the same progress surface.

## 9. Persistence and retention

- No new stores. Registry records extend the existing subagent registry
  SQLite tables; children are ordinary `sessions` rows. Additive columns only
  — **any change requiring a SQLite schema-version bump needs explicit
  maintainer sign-off first** (repo policy).
- Swarm group id on registry record + child session metadata.
- Retention: completed collector records survive until **group archive**:
  when the parent run finishes (or TTL expires), the group's children archive
  as a batch (extend the existing `DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES`
  sweep to operate per group).

## 10. Progress surface ("the dots") — later lane

- Implicit, harness-driven. Derived from existing `sessions.changed` SSE +
  registry; `phase`/`log` notes add semantics. No agent-driven rendering.
- Control UI: `swarm` renderer in the workspace widget family
  (`ui/src/lib/workspace/widgets/`) — dot grid grouped by phase, narrator
  line, per-dot status/label/model; sidebar child-tree unchanged.
- Channels: one throttled edited status message per group (follow
  `docs/concepts/streaming.md`; never per-child messages).

## 11. Labs page (Control UI, independent lane)

Settings → **Labs**: experimental feature toggles, first entries **Code Mode**
and **Swarm**. Each row: name, one-line description, docs link, toggle wired
via the existing `config.patch` RPC (RFC 7396 merge-patch — set
`tools.codeMode.enabled` / `tools.swarm.enabled`), plus a "restart required"
hint when applicable. Discoverable, but copy makes the experimental status
clear. i18n: all strings through the normal `en.ts` + sync pipeline.

## 12. Placement (later)

- `placement` opt on spawn: `"local"` (default) | `"cloud:<profile>"` via
  existing worker-environment dispatch (`sessions.dispatch`); pooled placement
  later if shared-box SSH-sandbox children prove insufficient.
- Orchestrator VM always stays on the gateway; settle/dots/budget are
  placement-blind.

## 13. Non-goals

- No graph DSL — control flow is the graph (deliberate, documented).
- No Codex source changes; no reuse of Codex Code Mode internals.
- No saved/named workflows in v1; no CLI entry point.
- No per-child operator approval bubbling.
- No 1:1 cloud provisioning at fan-out scale.
- No steady-state runtime compat shims; swarm is new surface, gated.

## 14. Build phases / PR slicing

1. **Lane A (core)**: §4 config + §5 spawn/wait/caps/approvals + §6 tests.
2. **Lane C (Labs page)**: §11 — independent, can land first.
3. **Lane B (QuickJS surface)**: §7 — after A contracts land.
4. Dots renderer (§10), Codex projection (§8), `agents.session` (§7 v1.1),
   placement (§12), user docs rewrite — follow-up PRs in that order.

Each PR: green CI, `$autoreview` clean, gated off by default, main shippable.
