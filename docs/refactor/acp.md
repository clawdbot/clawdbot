---
summary: "Migration plan for making ACP session and ACPX process ownership explicit"
read_when:
  - Refactoring ACP session lifecycle or ACPX process cleanup
  - Debugging ACPX orphan processes, PID reuse, or multi-gateway cleanup safety
  - Changing sessions_list visibility for spawned ACP or subagent sessions
  - Designing ownership metadata for background tasks, ACP sessions, or process leases
title: "ACP lifecycle refactor"
sidebarTitle: "ACP lifecycle refactor"
---

ACP lifecycle currently works, but too much of it is inferred after the fact.
Process cleanup reconstructs ownership from PIDs, command strings, wrapper
paths, and the live process table. Session visibility reconstructs ownership
from session-key strings plus secondary `sessions.list({ spawnedBy })` lookups.
That makes narrow fixes possible, but it also makes edge cases easy to miss:
PID reuse, quoted commands, adapter grandchildren, multi-gateway state roots,
`cancel` versus `close`, and `tree` versus `all` visibility all become separate
places to rediscover the same ownership rules.

This refactor makes ownership first-class. The goal is not a new ACP product
surface; it is a safer internal contract for the existing ACP and ACPX behavior.

## Goals

- Cleanup never signals a process unless current live evidence matches an
  OpenClaw-owned lease.
- `cancel`, `close`, and startup reaping have distinct lifecycle intents.
- `sessions_list`, `sessions_history`, `sessions_send`, and status checks use
  the same requester-owned session model.
- Multi-gateway installs cannot reap each other's ACPX wrappers.
- Old ACPX session records keep working during migration.
- The runtime remains plugin-owned; core does not learn ACPX package details.

## Non-goals

- Replacing ACPX or changing the public `/acp` command surface.
- Moving vendor-specific ACP adapter behavior into core.
- Requiring users to manually clean state before upgrading.
- Making `cancel` close reusable ACP sessions.

## Target Model

### Gateway Instance Identity

Each Gateway process should have a stable runtime instance id:

```ts
type GatewayInstanceId = string;
```

It can be generated on Gateway startup and persisted in state for the life of
that install. It is not a security secret; it is an ownership discriminator used
to avoid confusing one Gateway's ACP processes with another Gateway's processes.

### ACP Session Ownership

Every spawned ACP session should have normalized ownership metadata:

```ts
type AcpSessionOwner = {
  sessionKey: string;
  spawnedBy?: string;
  parentSessionKey?: string;
  ownerSessionKey: string;
  agentId: string;
  backend: "acpx";
  gatewayInstanceId: GatewayInstanceId;
  createdAt: number;
};
```

The Gateway should return these fields on session rows where they are known.
Visibility filtering should be a pure check over row metadata:

```ts
canSeeSessionRow({
  row,
  requesterSessionKey,
  visibility,
  a2aPolicy,
});
```

That removes hidden secondary `sessions.list({ spawnedBy })` calls from
visibility checks. A spawned cross-agent ACP child is requester-owned because
the row says so, not because a second query happens to find it.

### ACPX Process Leases

Every generated wrapper launch should create a lease record:

```ts
type AcpxProcessLease = {
  leaseId: string;
  gatewayInstanceId: GatewayInstanceId;
  sessionKey: string;
  wrapperRoot: string;
  wrapperPath: string;
  rootPid: number;
  processGroupId?: number;
  commandHash: string;
  startedAt: number;
  state: "open" | "closing" | "closed" | "lost";
};
```

The wrapper process should receive the lease id and gateway instance id in its
environment:

```sh
OPENCLAW_ACPX_LEASE_ID=...
OPENCLAW_GATEWAY_INSTANCE_ID=...
```

When the platform allows it, verification should prefer live process metadata
that cannot be confused by command quoting:

- root PID still exists
- live wrapper path is under `wrapperRoot`
- process group matches the lease when available
- environment contains the expected lease id when readable
- command hash or executable path matches the lease

If the live process cannot be verified, cleanup fails closed.

## Lifecycle Controller

Introduce one ACPX lifecycle controller that owns process leases and cleanup
policy:

```ts
interface AcpxLifecycleController {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  cancelTurn(handle: AcpRuntimeHandle): Promise<void>;
  closeSession(input: {
    handle: AcpRuntimeHandle;
    discardPersistentState?: boolean;
    reason?: string;
  }): Promise<void>;
  reapStartupOrphans(): Promise<void>;
  verifyOwnedTree(lease: AcpxProcessLease): Promise<OwnedProcessTree | null>;
}
```

`cancelTurn` requests turn cancellation only. It must not reap reusable wrapper
or adapter processes.

`closeSession` is allowed to reap, but only after loading the session record,
loading the lease, and verifying the live process tree still belongs to that
lease.

`reapStartupOrphans` starts from open leases in state. It may use the process
table to find descendants, but it should not scan arbitrary ACP-looking
commands first and then decide they are probably ours.

## Wrapper Contract

Generated wrappers should stay small. They should:

- start the adapter in a process group where supported
- forward normal termination signals to the process group
- detect parent death
- on parent death, send SIGTERM, then keep the wrapper alive until the SIGKILL
  fallback runs
- report root PID and process group id back to the lifecycle controller when
  that is available

Wrappers should not decide session policy. They only enforce local process-tree
cleanup for their own adapter group.

## Session Visibility Contract

Visibility should use normalized row ownership:

```ts
type SessionVisibilityInput = {
  requesterSessionKey: string;
  row: {
    key: string;
    agentId: string;
    ownerSessionKey?: string;
    spawnedBy?: string;
    parentSessionKey?: string;
  };
  visibility: "self" | "tree" | "agent" | "all";
  a2aPolicy: AgentToAgentPolicy;
};
```

Rules:

- `self`: only the requester session.
- `tree`: requester session plus rows owned by or spawned from the requester.
- `all`: all same-agent rows, a2a-allowed cross-agent rows, and requester-owned
  spawned cross-agent rows even when general a2a is disabled.
- `agent`: same agent only, unless an explicit owner relationship says the row
  belongs to the requester.

This makes `tree` and `all` monotonic: `all` must not hide an owned child that
`tree` would show.

## Migration Plan

### Phase 1: Add Identity And Leases

- Add `gatewayInstanceId` to Gateway state.
- Add an ACPX lease store under the ACPX state directory.
- Write a lease before spawning a generated wrapper.
- Store `leaseId` on new ACPX session records.
- Keep existing PID and command fields for old records.

### Phase 2: Lease-First Cleanup

- Change close cleanup to load `leaseId` first.
- Verify live process ownership against the lease before signaling.
- Keep the current root PID and wrapper-root fallback only for legacy records.
- Mark leases `closed` after verified cleanup.
- Mark leases `lost` when the process is gone before cleanup.

### Phase 3: Lease-First Startup Reaping

- Startup reaping scans open leases.
- For each lease, verify the root process and collect descendants.
- Reap verified trees children-first.
- Expire old `closed` and `lost` leases with a bounded retention window.
- Keep command-marker scanning only as a temporary legacy fallback, guarded by
  wrapper root and Gateway instance where possible.

### Phase 4: Session Ownership Rows

- Add ownership metadata to Gateway session rows.
- Teach ACPX, subagent, background-task, and session-store writers to populate
  `ownerSessionKey` or `spawnedBy`.
- Convert session visibility checks to use row metadata.
- Remove visibility-time secondary `sessions.list({ spawnedBy })` lookups.

### Phase 5: Remove Legacy Heuristics

After one release window:

- stop relying on stored root command strings for non-legacy ACPX cleanup
- remove command-marker startup scans
- remove visibility fallback list lookups
- keep defensive fail-closed behavior for missing or unverifiable leases

## Tests

Add two table-driven suites.

Process lifecycle simulator:

- PID reused by unrelated process
- PID reused by another Gateway's wrapper root
- stored wrapper command is shell-quoted, live `ps` command is not
- adapter child exits, grandchild remains in the process group
- parent death SIGTERM fallback reaches SIGKILL
- process listing unavailable
- stale lease with missing process
- startup orphan with wrapper, adapter child, and grandchild

Session visibility matrix:

- `self`, `tree`, `agent`, `all`
- a2a enabled and disabled
- same-agent row
- cross-agent row
- requester-owned spawned cross-agent ACP row
- sandboxed requester clamped to `tree`
- list, history, send, and status actions

The important invariant: a requester-owned spawned child is visible wherever
the configured visibility includes the requester session tree, and `all` is not
less capable than `tree`.

## Compatibility Notes

Old session records may not have `leaseId`. They should use the legacy
fail-closed cleanup path:

- require a live root process
- require wrapper-root ownership when a generated wrapper is expected
- require command agreement for non-wrapper roots
- never signal based only on stale stored PID metadata

If a legacy record cannot be verified, leave it alone. Startup lease cleanup and
the next release window should eventually retire the fallback.

## Success Criteria

- Closing an old or stale ACPX session cannot kill another Gateway's process.
- Parent death does not leave stubborn adapter grandchildren running.
- `cancel` aborts the active turn without closing reusable sessions.
- `sessions_list` can show requester-owned cross-agent ACP children under both
  `tree` and `all`.
- Startup cleanup is driven by leases, not broad command-string scans.
- The focused process and visibility matrix tests cover every edge case that
  previously required one-off review fixes.
