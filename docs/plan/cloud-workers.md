---
summary: Run agent sessions on ephemeral SSH-reachable machines with gateway-proxied inference and live sidebar streaming.
title: Cloud workers plan
read_when:
  - Designing or implementing cloud worker provisioning, worker mode, or session handoff
  - Changing environments.*, the worker protocol, transcript ingestion, or inference proxy RPCs
  - Reviewing security posture of remote agent execution
---

## Status

Proposal, revision 3. Not implemented. Direction agreed 2026-07; revision 2 incorporated adversarial review findings (dedicated worker protocol, placement/environment state machines, git-aware inbound sync, one-way v1 handoff, controlled-egress security wording). Revision 3 settles the sync ownership model (worker authors commits, gateway adopts and publishes), adds a no-git plain sync mode, fixes worker exec at full-within-box, moves internet policy to provision time, and restores agent dispatch to milestone 3.

## Problem

OpenClaw agent sessions run their loop, tools, and inference inside the gateway process on one machine. Compute is capped by that machine, long tasks occupy it, and parallel work competes for it. Hosted products (Cursor cloud agents, Claude Code on the web, Codex cloud) solve this with ephemeral per-task cloud sandboxes, but they require vendor infrastructure and vendor trust.

Operators who already own spare machines (or can lease them cheaply) have no way to say: run this session over there, show it in my sidebar like any other session, and throw the machine away afterwards.

## Goals

- Run a full agent session (loop + tools) on an ephemeral remote machine ("cloud worker") while the session appears and streams in the Control UI exactly like a local session.
- No standing credentials on the worker (no provider auth, no forge tokens) and no direct network egress; the box only needs a reachable sshd.
- Provision, sync, run, collect, destroy — fully automated, provider-pluggable (first provider: Crabbox-style lease CLIs).
- Dispatch running work from the gateway to a worker at a turn boundary without losing transcript, session identity, or (when request bytes stay equivalent) provider cache affinity; pull results back safely.
- Both humans (UI) and agents (tool) can dispatch work to a cloud worker.
- Support days-long sessions; lifetime is policy, not a hard-coded cap.

## Non-goals (v1)

- No external coding harnesses (Claude Code, Codex CLI) on workers. Worker sessions run OpenClaw's embedded runner only. Harness support is a v2 opt-in because harnesses do their own inference with their own credentials.
- No best-of-N / parallel attempt fan-out.
- No VPN/tailnet dependency. Transport is SSH only.
- No new sandbox runtime. The worker machine is the isolation boundary; in-box OS sandboxing can layer on later.
- No symmetric live migration in v1: dispatch is local → worker; worker → local requires a stopped session plus completed workspace reconciliation. Live two-way handoff builds on the same barrier machinery later.
- No JSON side-state on the gateway; environment, placement, cursor, and grant state live in SQLite.

## Prior art (what we copy, what we invert)

- Cursor cloud agents: agent loop runs in their cloud; the VM is a tool-execution target; append-only conversation store streamed to all clients; snapshot-after-install warm start; self-hosted workers are outbound-only worker processes. We copy the "conversation source of truth stays on the orchestrator" and streaming model; we invert loop placement (see decision below).
- Codex cloud: two-phase runtime — networked setup phase, then offline agent phase with secrets stripped; container-state cache for fast follow-ups. We copy the phase split as our egress posture and the cache idea for v2 warm images.
- Claude Code on the web: per-session VM; credential-isolating git proxy (real tokens never enter the sandbox, push restricted to the session branch); filesystem snapshot after setup; teleport handoff = pushed branch + replayed history. We copy credential isolation and the handoff framing, but outbound sync is rsync from the gateway so dirty working trees work and no forge token exists anywhere near the box.
- Copilot coding agent: default-deny egress with package-registry allowlist. Our steady-state default is stronger (no direct egress at all) because inference and websearch arrive through the SSH tunnel — but see Security for why this is "controlled egress", not "zero egress".

## Architecture decision: loop on the worker, inference through the gateway

Three placements were considered:

1. Loop stays on the gateway, worker executes tools (Cursor model). Safest failure domain (transcript, inference, approvals, restart recovery all stay local) and a reviewer-preferred first milestone. Rejected as the product architecture: OpenClaw's non-exec tools are in-process filesystem operations, so every file read/edit/grep becomes a network round trip or a large tool-surface refactor into coarse workspace RPCs; runtime behavior is chatty and latency-bound. We reuse its spirit where it is already built (exec offload to nodes) but do not build the tool-remoting layer.
2. Loop and inference both on the worker. Simplest failure domain, but model credentials (including OAuth profiles) must ship to throwaway machines, the gateway loses policy/routing/audit control, and migration switches the provider-calling identity, invalidating provider caches.
3. Loop + tools on the worker, model calls proxied through the gateway. Chosen. One round trip per model turn instead of per tool call; tools run next to the code; the gateway remains the single owner of auth profiles, provider routing, and policy; the worker holds no secrets.

The cost of option 3 is a synchronous gateway dependency during each model turn, so its durability rules are part of the decision, not an afterthought:

- Gateway loss mid-turn fails the active provider call. The turn is marked failed and is retried as a new turn after reconnect; there is no transparent replay of an in-flight provider stream (double-billing/double-tool-call risk).
- Every worker↔gateway operation carries durable identity (see Worker protocol) so reconnects resume or fetch cached terminal results instead of dangling.
- The gateway is a capacity-managed component: concurrent-worker limits, flow control, and load shedding are in scope for v1 (see Capacity).

Because the gateway both stores the transcript and originates all provider traffic, the session is location-independent: moving the loop between gateway and worker changes nothing on the provider side and nothing in the UI data path. That is what makes dispatch and pull-back cheap.

## Components

### 1. Environment state machine + provider contract

`environments.*` in the gateway protocol is currently a status-only projection. The durable core is a SQLite-owned environment record and state machine, designed before RPC shapes:

`requested → provisioning → bootstrapping → ready → (attached|idle) → draining → destroying → destroyed | failed | orphaned`

- Provisioning is crash-safe: the intent row is persisted before the provider call, with a deterministic operation id, so a gateway restart can adopt an in-flight lease instead of double-provisioning or orphaning a paid machine.
- Restart reconciliation and an orphan sweeper (provider `inspect` vs. local records) are v1 requirements, not hardening.

Provider contract (plugin-implemented; no provider names or policy in core):

```ts
type WorkerProvider = {
  id: string;
  provision(profile: WorkerProfile, opId: string): Promise<WorkerLease>; // → ssh host/port/user/key material
  inspect(lease: { leaseId: string; profile: WorkerProfile }): Promise<LeaseStatus>; // adopt/health/orphan sweep
  renew?(leaseId: string): Promise<void>; // long-lived sessions vs provider TTLs
  destroy(lease: { leaseId: string; profile: WorkerProfile }): Promise<void>; // idempotent, returns only on proof of teardown
};
```

RPCs: `environments.create`, `environments.destroy`, extended `environments.list/status` (provider, lease id, state, age, idle time, attached sessions). First providers: a Crabbox-shape lease CLI wrapper (product path) and a static-SSH-host provider marked development-only — a worker on a shared host can read unrelated host data, so static hosts are for feature development, not the default posture.

### 2. Worker bootstrap: install OpenClaw on the box

No bespoke worker artifact, and no dependence on npm availability:

- Canonical install for all modes: a gateway-produced, content-hashed worker bundle (the gateway's own build output packed as a tarball), pushed over SSH and installed on the box. This covers dev builds and unreleased commits by construction.
- `npm i -g openclaw@<exact gateway version>` is an optimization when the gateway runs a released version; never `latest`.
- Bootstrap is idempotent; a warm lease with a matching bundle hash skips install. Raw machines may need a networked toolchain phase (Node runtime) — part of the setup phase, closed afterwards.
- Handshake verifies worker build hash, protocol feature set, and runtime compatibility. The existing gateway version/protocol checks are insufficient for this (SSH-tunneled nodes are exempted from exact-version rejection), so worker admission does its own exact-build check.

Worker mode (`openclaw worker`) is an entry point, not a fork: connection handling plus the embedded agent runner, with session persistence and model calls backed by gateway RPCs. It must not start gateway surfaces: no channels, no plugin auto-start beyond the session toolset, throwaway state dir, no local auth profiles.

### 3. Transport: everything over SSH

The gateway owns connectivity; the worker requires nothing but sshd:

- Gateway opens SSH to the worker (credentials from the provider lease, host key pinned from provisioning output — no `StrictHostKeyChecking=no`) and establishes a reverse tunnel forwarding a worker-local socket to the gateway's WS endpoint.
- Control/model traffic and workspace transfer use separate SSH connections with the same pinned trust material so rsync cannot head-of-line-block token streams.
- Tunnel lifecycle (keepalive, reconnect with backoff) is owned by the environment runtime on the gateway. A tunnel blip is invisible at the session level: durable protocol state (below) lets the worker re-attach and resume.

### 4. Worker protocol (dedicated; not the node protocol)

Adversarial review against the current node seams ruled out plain reuse: pending node invokes are process-local promises that die with the connection, node idempotency keys are parsed but not deduplicated, and — decisive — a connected node can emit ordinary node events (including agent-run requests), so "node kind + capability ceiling" is not an ingress security boundary. Workers therefore get an authenticated `worker` role with a closed, versioned RPC/event allowlist; worker connections cannot reach any legacy node event handler.

Identity and credentials: provisioning mints a short-lived worker credential bound to environment id, worker key, bundle hash, the single allowed session, the allowed RPC set, and an expiry. SSH-verified pairing still applies (we provisioned the box and hold the key), but authorization comes from the minted credential, not from the declared node surface.

Durable operation semantics (shape borrowed from the existing ACP runtime and its event ledger — stable handles, per-session serialization, durable `(session, seq)` replay):

- Every operation is scoped `(sessionId, lifecycleRevision, runId, ownerEpoch, streamKind, seq)`.
- Ownership epochs fence stale workers: a replacement worker advances the epoch; late results from the old epoch are rejected deterministically.
- At-least-once delivery with persisted ACK cursors and cached terminal results in SQLite; dedupe is deterministic. No exactly-once promises.
- Explicit frames for cancel, close, resume, and terminal results; credit/window-based flow control on streams.
- Protocol feature negotiation is independent of the general node protocol version.

### 5. Session backend RPCs

Two distinct contracts — the current codebase separates durable transcript mutations (session-manager owned, JSONL tree with parent/leaf state) from process-local live events (streaming deltas, tool lifecycle, approvals), and the worker protocol must preserve that split:

- Durable transcript commits: the worker submits semantic append batches with `runEpoch` + base-leaf compare-and-swap; the gateway session manager generates entry ids and parent ids. The worker can never supply trusted transcript rows, entry ids, parent ids, or foreign session ids.
- Replayable live events: a typed event union with worker sequence numbers, gateway ACKs, bounded retention, and late-event fencing, feeding the existing agent-event fanout so chat view, tool rows, and unread/status logic behave identically to local sessions.

Inference proxy: reuse the event vocabulary of the existing runtime proxy stream client (`src/agents/runtime/proxy.ts`) but move the trust boundary. The worker sends only session/run identity, an approved model reference, context, and constrained generation options; the gateway resolves provider, endpoint, auth, headers, routing, and cost policy from its own catalog. A worker-supplied model object (e.g. attacker-controlled `baseUrl`) is rejected. Request-size limits, cancellation, audit, and terminal-result replay apply. Gateway-resident tools (websearch) execute on the gateway and return results over the same channel.

### 6. Workspace sync

The sync anchor is a gateway-local workspace with exclusive placement ownership: for git workspaces, a dedicated managed worktree (existing managed-worktree metadata — branch, base, snapshot ownership — is the foundation); for non-git workspaces, a gateway-owned target directory. Never the user's live checkout. Exclusive ownership while the session is placed remotely is what makes inbound sync conflict-free by construction.

Ownership split — commit vs. publish:

- The worker-side agent authors commits normally in its copy (`git commit` is a local, credential-free operation; author identity is projected from gateway config). Those commits are inert objects until the gateway adopts them.
- The gateway does everything that requires trust: verifying inbound commits build on the recorded base, fast-forwarding the local worktree, push, PR creation, and optional signing/re-signing — all with gateway-local credentials. The worker never holds git or forge credentials and never touches a remote.

Two sync modes, selected by whether the workspace is a git repository:

- Git mode. Outbound: rsync the worktree (uncommitted and eligible untracked files included; crabbox-style include/exclude, `.worktreeinclude` respected) over the tunnel's SSH identity, recorded as an immutable base manifest (content hashes + base commit). Inbound: new commits return as a git bundle or temporary ref against the recorded base; untracked artifacts return via an explicit manifest with size/type/symlink-containment checks. Adoption verifies base ancestry and stops on divergence — nothing silently overwrites either side. Deletes, renames, submodules, and symlink escapes are handled by the manifest rules, not rsync heuristics.
- Plain mode (no git — e.g. building a project from scratch on the box). Outbound is the same rsync + base manifest. Inbound is a manifest-diffed mirror back into the gateway-owned target directory with delete propagation. Safe for the same reason git mode is: exclusive ownership means no concurrent local edits exist to conflict with; the base manifest still detects unexpected local drift and stops instead of overwriting.

Checkpointing protects days-long sessions from lease loss: periodic inbound checkpoints (session-branch commits in git mode, manifest snapshots in plain mode); cadence is profile policy (turn-based default).

### 7. Placement state machine, sessions, and UI

Runtime placement is a SQLite-owned state machine keyed to the session, not a pair of loose row fields:

`local → requested → provisioning → syncing → starting → active(worker) → draining → reconciling → local | reclaimed | failed`

It persists environment id, transition generation, active owner epoch, workspace base manifest, worker bundle hash, and last ACK cursors. Turn admission atomically claims placement before either loop starts a turn, so a local message admitted against a stale snapshot can never race a worker turn — exactly one loop owns the session at any time.

UI:

- A worker session is an ordinary session row plus placement metadata. It lives in the normal store, lists via `sessions.list`, streams via existing subscriptions — sidebar and chat need no new data path, only presentation: a worker badge and placement/environment status (`provisioning / syncing / running / idle / reconciling / reclaimed`).
- Creation UX: the session target bar (sessions sidebar redesign) gains a cloud worker destination alongside gateway and node. Requires a configured provider profile; the feature is invisible until configured.
- Agent dispatch: a session tool lets an agent hand work to a cloud worker the way a human does (worker-backed sub-session, subagent-style). Ships in the same milestone as human dispatch, gated by the same opt-in provider config. Recursion is bounded structurally (worker sessions cannot themselves dispatch workers in v1); spend control is per-environment accounting/audit, not quota machinery.

## Dispatch and handoff

v1 is deliberately asymmetric:

- Local → worker (dispatch): pass the migration barrier below, provision or reuse a worker, sync, flip placement, next turn executes remotely.
- Worker → local (pull-back): stop the session (drain the worker per the same barrier), complete inbound reconciliation, flip placement to local. Not a live migration.
- Symmetric live handoff (moving an actively-working session both directions without stopping) reuses the same barrier and reconciliation machinery and ships after fault-injection tests prove the barrier.

Migration barrier ("turn boundary" alone is insufficient — approvals, background processes, and released-lock transcript merges can straddle it):

1. Stop new turn admission (placement claim).
2. Cancel or drain active runs.
3. Revoke pending exec approvals and execution grants.
4. Drain transcript side-writes and live-event ACKs.
5. Terminate worker child processes.
6. Fence the old owner by advancing the owner epoch.
7. Reconcile workspace (inbound, conflict-aware).
8. Activate the new owner.

Cache affinity: because provider requests originate from the gateway in both placements, cache affinity is preserved when the serialized provider request stays equivalent — same tool order, system instructions, provider wrappers, and cache metadata (which stay gateway-side). This is a testable property, not an assumption: byte-equivalence tests across local/worker placement per supported provider transport are part of the milestone that introduces the worker loop.

## Security model

Precisely stated: the worker has no direct network egress and no standing provider/forge credentials. It is not "zero egress" — inference and gateway-executed tools are controlled egress channels (a prompt-injected worker can still put workspace bytes into model context or websearch queries). Accordingly:

- Controlled-egress accounting: per-environment audit and operator-visible accounting on the inference proxy and gateway tools. Rate/byte limits exist as protocol flow control (capacity), not as spend-quota machinery.
- Worker ingress to the gateway is the closed worker-protocol allowlist; transcript writes are structurally constrained (gateway-generated ids, single bound session).
- Worker exec is full-permission within the box. The box is disposable and credential-free, so per-command approval adds friction without protecting anything; the guarded boundary is inbound reconciliation and audit. Exec never traverses the gateway node-approval path.
- Internet policy is a provision-time provider decision: the environment profile decides at box creation (firewall/security group/no-egress network), optionally with a networked setup phase that the provider closes before the agent phase. Core does not implement a runtime network toggle.
- Box hygiene at provision time: cloud metadata endpoint blocked or verified absent, no instance profile, no inherited SSH agent, no Docker socket, clean env/home. SSH host keys pinned from provisioning output.
- Approvals and policy for anything gateway-side (push, PR, provider calls) continue to run on the gateway.

Blast radius of a compromised worker session: the synced workspace copy plus what the audited proxy channels allow — no credentials, no direct network, no gateway surface beyond the allowlist.

## Capacity

The gateway relays every prompt and token stream for N workers, so v1 states a capacity model instead of discovering it in production: concurrent-worker limits per gateway, per-stream credit windows (the current event stream queue is unbounded and the node socket buffer ceiling force-closes slow consumers — both unsuitable unmodified), bounded disk spooling for bursts, and load shedding with visible backpressure states in the UI. Workspace transfer stays on its own SSH channel.

## Lifecycle

- Idle auto-stop and TTL are provider-profile policy, not fixed constants. Defaults are generous with explicit keep-alive; days-long work is first-class (provider `renew` exists for lease-based backends); a session with an in-flight turn or recent activity is never reclaimed.
- On worker death or reclaim: placement moves to `reclaimed`, the session row remains, the next message provisions a fresh worker and re-syncs from the last checkpoint. Conversation is never lost (gateway-side store); workspace changes since the last checkpoint are lost and the UI says so.
- Warm-lease reuse from day one (providers that support it); image snapshot after bootstrap is the v2 fast-start path.

## Configuration surface

Minimal and opt-in: a provider profile block (provider id, credentials/CLI reference, sync rules, lifetime policy, budgets, optional setup phase) plus per-session placement selection. No new environment variables. Unconfigured installs see nothing.

## Milestones

Implementation lands as small, independently mergeable PRs; each milestone below is a PR series, not one change.

1. Foundations: environment state machine + provider contract + crabbox-shape provider (static-SSH as dev harness), worker bundle bootstrap + admission handshake, SSH tunnel + host-key pinning, managed-worktree snapshot + outbound sync (git + plain modes). Orphan sweep + restart adoption.
2. Worker protocol + worker loop: authenticated worker role, durable ops/epochs/ACK cursors, transcript commit + live event contracts, inference proxy with gateway-resolved models, flow control. One provider, human dispatch of new sessions only, no handoff. Fault-injection tests (tunnel partition, gateway restart, worker death) gate exit.
3. Dispatch + pull-back + agent dispatch: migration barrier, placement state machine wired to UI target bar, inbound reconciliation + checkpoints, per-environment audit, capacity limits, agent dispatch tool (worker sessions cannot recurse). Prompt-cache byte-equivalence tests.
4. Symmetric live handoff, after milestone-3 fault-injection proof.

Later: ACP harnesses on workers as per-environment credential-hydration opt-in; snapshot/warm-image fast start; fan-out (N leases, same prompt); in-box OS sandboxing; richer artifact capture via the artifacts schema.

## Open questions

- Plugin/skill availability on workers: repo-carried skills sync with the workspace for free; gateway-configured agent skills/plugins need an explicit sync or exclusion decision (tool/plugin manifest is part of the admission handshake either way).
- Checkpoint cadence default: turn-based vs. time-based for very chatty sessions.
- How environment profiles interact with multi-agent routing (per-agent default profiles vs. per-session selection only).
