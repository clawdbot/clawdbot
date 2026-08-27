---
summary: "Current ACP session ownership and ACPX process-lease migration status"
read_when:
  - Refactoring ACP session lifecycle or ACPX process cleanup
  - Debugging ACPX orphan processes, PID reuse, or multi-gateway cleanup safety
  - Changing sessions_list visibility for spawned ACP or subagent sessions
  - Designing ownership metadata for background tasks, ACP sessions, or process leases
title: "ACP lifecycle refactor"
sidebarTitle: "ACP lifecycle refactor"
---

ACP session ownership is now explicit in session rows, and generated ACPX
wrapper launches are lease-backed. The remaining process-cleanup heuristics are
not the target design: they are temporary coverage for launch paths that the
published `acpx` runtime does not yet expose to OpenClaw.

This page records the current boundary and the work that remains. It is not a
proposal for a second lifecycle controller.

## Invariants

- Lease-based cleanup signals a process only after current live evidence matches
  the lease id, Gateway instance id, and expected wrapper path.
- `cancel` stops the active turn without closing a reusable ACP session.
- `close` owns terminal session cleanup.
- Session visibility reads normalized ownership from session rows.
- Core remains independent of ACPX package and adapter details.

## Current ownership model

The ACPX plugin persists a stable Gateway instance id and version 1 process
leases in plugin SQLite state. The lease shape shipped in `v2026.7.2-beta.7` and
remains compatible:

```ts
type AcpxProcessLease = {
  leaseId: string;
  gatewayInstanceId: string;
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

Before entering an upstream launch that uses an OpenClaw-generated wrapper, the
plugin writes a pending lease with `rootPid: 0`. The wrapper command receives
the lease id and Gateway instance id as arguments:

```sh
--openclaw-acpx-lease-id <lease-id> \
--openclaw-gateway-instance-id <gateway-instance-id>
```

The ACPX session-store save promotes the pending lease with the wrapper PID.
Generated-wrapper availability and doctor probes use the same lease-first
ordering. Delegate fulfillment does not prove a probe wrapper exited: OpenClaw
checks the exact live lease identity and reaps a surviving tree, but retains the
lease even when the wrapper is absent. The wrapper strips lease arguments before
spawning its detached adapter, so wrapper absence cannot prove reparented
descendants are gone. The probe lease stays open until stable descendant identity
can prove the whole tree absent. If delegate entry throws, OpenClaw likewise
cannot distinguish a pre-spawn failure from a post-spawn failure.

Direct agent commands are different. Published `acpx` resolves and spawns those
processes internally and exposes neither a pre-spawn identity hook nor a
post-spawn ownership callback. OpenClaw does not duplicate that launch policy;
direct-agent sessions and direct-agent probes therefore remain outside complete
lease coverage.

## Startup recovery

Startup first lists open leases owned by the current Gateway instance.

- A lease with a recorded PID is reaped only when the live root command matches
  its lease id, Gateway instance id, and wrapper root.
- A pending `rootPid: 0` wrapper lease is recovered by enumerating live rows and
  requiring exactly one process with the exact wrapper path, lease id, and
  Gateway instance id. Foreign or missing matches are not signaled.
- Ambiguous matches, unavailable process evidence, invalid wrapper paths, and
  unsupported platforms leave the lease open for a later retry.
- Missing generated-probe wrappers also leave their lease open because detached
  descendants do not carry the lease identity.
- Aggregate marker scanning is separate from lease retirement. Its result never
  closes or loses a specific lease.

The legacy marker scan remains temporarily for unleased direct-agent processes
and reparented descendants. It keeps its existing narrow trigger: startup saw a
pending lease from an uncertain spawn. Lease-aware wrapper roots are excluded
from that scan and are handled only by exact lease recovery.

## Session visibility

Session rows carry lineage such as `spawnedBy`, `parentSessionKey`, and
`ownerSessionKey`. Visibility checks consume those row fields directly for
`self`, `tree`, `agent`, and `all`; they no longer perform a secondary
`sessions.list({ spawnedBy })` lookup per row. A requester-owned cross-agent ACP
child remains visible whenever the configured visibility includes the
requester's tree, and `all` is not less capable than `tree`.

## Migration status

| Phase                          | Status                          | Current result                                                                                                                                                                           |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Identity and leases         | Complete for generated wrappers | Stable Gateway identity, SQLite lease store, lease-first generated session/probe launch, and session-record lease identity are live. Direct upstream spawns are blocked on `acpx` hooks. |
| 2. Lease-first close cleanup   | Complete                        | Close loads the lease first and verifies current process evidence. Shipped legacy session records retain fail-closed PID/command cleanup.                                                |
| 3. Lease-first startup reaping | Partial                         | PID and `rootPid: 0` wrapper leases use exact live evidence. Process-group coverage, reparented descendants, direct agents, and Windows reaping remain blocked.                          |
| 4. Session ownership rows      | Complete                        | Writers persist lineage and visibility reads normalized row metadata without secondary list lookups.                                                                                     |
| 5. Remove legacy heuristics    | Blocked                         | Visibility fallbacks are gone. Command-marker reaping must remain until the process-ownership blockers below are closed and proven.                                                      |

## Remaining blockers

### Upstream launch ownership

`acpx` owns probe, initial session, reconnect, and control-operation process
creation. OpenClaw needs upstream pre-spawn identity injection plus a post-spawn
callback that reports the root PID or an equivalent launch primitive. Without
that contract, locally wrapping direct launches would duplicate `acpx` command
resolution and platform behavior.

### Stable descendant identity

Generated wrappers create a detached adapter process group on Unix, but the
group id is not reported back into the lease. The reaper currently discovers
descendants from PPID rows, so a reparented grandchild can escape the recorded
tree. Removing its marker fallback requires upstream or wrapper-owned reporting
of a stable process-group identity and reaper support that verifies that identity
against the lease.

### Windows cleanup

The ACPX reaper does not yet enumerate and terminate Windows process trees with
the same live command-line evidence used on Unix. Windows cleanup therefore
fails closed and leaves leases open. Marker removal requires a tested Windows
process-list and tree-termination implementation, not a platform skip.

## Compatibility

The lease schema is unchanged from the latest shipped release, so no doctor
migration is required for this work. Old session records without `leaseId` keep
the legacy fail-closed cleanup path:

- require a live root process
- require wrapper-root ownership for generated wrappers
- require stored/live command agreement for non-wrapper roots
- never signal from stale PID metadata alone

If a legacy record cannot be verified, cleanup leaves it alone.

## Proof expectations

Process lifecycle coverage must include:

- generated probe lease persistence before upstream entry
- completed probe exact-wrapper inspection and conservative lease retention
- PID reuse by an unrelated process or another Gateway instance
- exact `rootPid: 0` own-versus-foreign recovery
- ambiguous, unavailable, and Windows evidence failing closed
- adapter children reaped in child-first order
- a reparented descendant test before claiming marker removal

Session visibility coverage must retain the `self`, `tree`, `agent`, and `all`
matrix across same-agent, cross-agent, a2a-disabled, and requester-owned spawned
rows.

## Completion criteria

The refactor is complete only when upstream launch hooks cover every direct
spawn, leases carry stable process-tree identity across reparenting, Windows has
equivalent verified cleanup, and the marker scan plus its package/path literals
can be deleted without reducing orphan cleanup coverage.
