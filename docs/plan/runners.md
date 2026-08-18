---
summary: Everything is a node — one placement model where paired machines and cloud boxes host sessions through the worker admission path; clients attach to sessions, never to runners.
title: Runners plan
read_when:
  - Designing or reviewing where sessions run (gateway, device, cloud)
  - Changing the Where picker, device pairing, node onboarding, or worker dispatch surfaces
  - Naming anything around sessions, devices, nodes, or placement
---

## Status

Proposal, revision 2. Supersedes revision 1 in place (2026-08-11, operator
decision). Implementation in progress; update this table in every PR that
advances a milestone.

| #   | Milestone                                                  | Status      | PRs                                                                                                                                                                       |
| --- | ---------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | This plan (revision 2)                                     | landed      | #122454                                                                                                                                                                   |
| 1a  | Naming: session copy revert                                | landed      | #120667                                                                                                                                                                   |
| 1b  | Naming: devices consolidation                              | landed      | #120689                                                                                                                                                                   |
| 1c  | Cleanup: node-pairing → device-pairing merge               | landed      | #120726                                                                                                                                                                   |
| 2   | `openclaw resume` + web Continue in terminal               | in progress | #120664, #122870                                                                                                                                                          |
| 3   | `openclaw connect` one-paste onboarding + `/j/` join route | in progress | #120768, #122499                                                                                                                                                          |
| 4   | Picker: grouping, placement, liveness, enrichment          | in progress | #120804, #122531, #122635, #122774, #122923                                                                                                                               |
| F   | Real-wire session boundary harness                         | landed      | #121212                                                                                                                                                                   |
| 5   | Public worker ingress path                                 | landed      | #122578, #122643                                                                                                                                                          |
| 6   | Node worker provider (device runners)                      | in progress | #122683, #122769, #122829, #122939, #123013, #123033, #122966, #123157, #123280, #123612, #123641, #123665, #123673, #123700, #123696, #123785, #123859, #123889, #123901 |
| 7   | Bundle push consent + runner updates                       | in progress | #123985, #124037, #124356, #124590                                                                                                                                        |
| 8   | Stop-and-continue moves                                    | landed      | #125036                                                                                                                                                                   |
| 9   | Deletions (ssh sandbox, openshell, exec-host clones, …)    | in progress | #125503, #125524                                                                                                                                                          |
| 10  | Cloud convergence (provisioners run `openclaw connect`)    | landed      | #125288, #125384, #125465                                                                                                                                                 |

Revision history: revision 1 (2026-08-08) established the session/runner
vocabulary, the naming rulings, and the milestone skeleton after a
code-evidence investigation and three adversarial reviews. Revision 2
(2026-08-11) follows a second round of deep code reads (worker admission,
tunnel, sync, node channel, scope model), an industry survey (GitHub/GitLab/
Buildkite/CircleCI runners, Tailscale, VS Code tunnels, Coder, Gitpod Flex,
Amp, Cursor/Claude/Codex cloud), a static teardown of Amp's runner transport,
and a fresh adversarial review of this revision. The operator decisions that
changed the plan:

- **Nodes host sessions.** Revision 1's "no turn loops on the node role"
  non-goal is overridden as a conclusion while its facts stand: the node
  _connection_ is still not an authority boundary, so session-hosting
  authority lives in the dispatch layer (worker admission, per-dispatch
  credentials, turn claims, owner epochs) — relocated, not removed.
- **`openclaw worker` becomes a node-supervised child.** One machine concept:
  a paired node can run everything a cloud worker runs today.
- **SSH is not the device transport.** The gateway never dials devices; the
  device always dials out. Revision 1's "ship sshd first" for device runners
  is deleted — it cannot reach a NAT'd machine and no surveyed product uses
  SSH as control transport. SSH remains only as the legacy cloud-lease
  transport until milestone 10 retires it.

## Problem

Unchanged from revision 1 in substance: OpenClaw has disconnected answers to
"where does work run." Nodes receive forwarded `exec host=node` calls only; a
user's always-on workstation is less capable as a session host than a
throwaway cloud lease. Cloud workers host full sessions with a durable
placement state machine, but only against ephemeral SSH-provisioned leases.
The ssh sandbox backend is a third remote-execution path. Placement is chosen
once from a flat list mixing ontologies, then becomes invisible; onboarding a
new machine takes flags, env vars, and two manual approvals.

The bar, stated as product: an admin clicks "Connect a machine…" in the web
picker, pastes one command on any machine, and seconds later that machine is
visible in the picker for the whole team and can host full agent sessions.

## Model and vocabulary

```
Session   gateway-owned: transcript, identity, placement, managed worktree.
          Clients (web, TUI, macOS app, channels) attach to sessions,
          never to runners. One noun, everywhere: session.
Node      a paired machine holding an outbound connection to the gateway
          (Ed25519 device identity). Protocol/internal vocabulary; user-facing
          copy says "device". EVERY remote machine is a node — personal
          workstations, servers, cloud leases. Phones are nodes that never
          advertise session hosting.
Runner    anything that can host a session's turn loop: the gateway itself,
          or a session-capable node. "Runner" is internal/docs vocabulary;
          UI copy says "Runs on …".
Worker    the per-turn child process (`openclaw worker`) that hosts a
          session's loop under worker admission. On cloud leases it is
          launched over SSH today; on nodes it is a supervised child of the
          node host. Same admission, same protocol, either way.
Isolation a property OF the runner (none | docker | podman), not a place.
Project   repo identity: normalized remote.origin.url, with the existing
          16-char repo fingerprint as the no-remote fallback. Derived,
          never registered.
Checkout  project × runner = { runnerId, path }.
Turn      one prompt-to-response work attempt inside a session.
```

Naming rulings (operator-decided, carried from revision 1): **session** is the
only product noun for a conversation; **devices** is the user-facing word for
paired hardware; new CLI ergonomics ship as **verbs** (`openclaw resume`,
`openclaw connect`); "runner" never appears in UI copy. Milestone 1c (nodes →
devices route/i18n consolidation) lands before any new placement copy ships.

## Architecture

### The two-connection shape

Every surveyed production system (GitHub Actions runners, GitLab, Buildkite,
CircleCI, Tailscale, VS Code tunnels, Coder, Gitpod, Amp) uses outbound-only
connections from the machine to the control plane, and the mature ones split
a persistent presence/control channel from per-job work channels. OpenClaw
already has both halves; this plan connects them:

1. **Node connection** (exists): the outbound gateway WebSocket. Carries
   identity, presence, capability manifest, and bounded command invocation
   (`node.invoke`). This is the control channel: registration, liveness, and
   the transport for workspace operations.
2. **Worker connection** (exists): the per-dispatch WebSocket speaking the
   closed worker protocol (heartbeat, transcript CAS commits, resumable live
   events, gateway-proxied inference, gateway-side session tools). Admission
   is store-backed and transport-free: per-dispatch 32-byte credential
   (10-minute TTL, hashed at rest), environment binding, owner epochs, exact
   bundle hash, per-RPC identity revalidation. On a node runner the worker
   child dials the gateway's public TLS endpoint directly — a connected node
   proves the outbound path exists.

What is deliberately NOT the transport: `node.invoke` as a byte pipe for the
worker connection. Measured constraints (16 KiB string chunks, an awaited RPC
round-trip per chunk, no idempotency dedupe, reconnect kills in-flight
invokes, one-session-per-nodeId eviction, 50 MB buffer hard-close) make it
unsuitable for hours-long streams. It stays what it is: a bounded command
channel.

### Worker ingress on the public endpoint (milestone 5)

Worker admission is exposed only on a path-tagged upgrade route on the public TLS endpoint (`connectionKind = "worker"` is forced by the route). Node-hosted worker children dial that endpoint directly. The former loopback listener and SSH reverse-forward carrier were removed after Crabbox converged onto node-backed worker turns; SSH remains only for `remote-exec` workspace transport and separately owned desktop tunnels.

Hardening that ships with the exposure, not after it:

- Admission failures collapse into one opaque reason. The current
  `invalid-credential` vs `environment-mismatch` distinction is an
  environment-id enumeration oracle and must not be publicly observable.
- The worker path shares the gateway's preauth budgets and rate limits;
  a pre-credential connection gets the same cheap rejection as any other
  unauthenticated client.
- Credential strength is already sufficient (32 random bytes, constant-time
  hashed compare, 10-minute TTL, single environment binding).

### Node worker provider (milestone 6)

`WorkerLease` grows a union: `{ ssh: … } | { node: { deviceId } }`. The
admission/placement machinery (environment store, credential broker,
placement state machine, turn claims, transcript/live-event/inference
protocols) is reused unchanged — that is the hard-won part. What is net-new,
stated honestly (revision 1 undersold this):

- **Node tunnel handle.** A second `WorkerTunnelHandle` implementation:
  `runWorkspaceCommand` maps to a bounded node command (argv + stdin →
  SpawnResult; the remote-side sync/manifest/quiesce scripts already ship in
  the bundle and are transport-agnostic). `remoteSocketPath` is replaced by
  the descriptor carrying the gateway worker URL.
- **Durable launch.** In the SSH flow the launch exec stream _is_ the worker
  lifetime and its death destroys the environment. On a node, launch is a
  supervised node-host command: the node host spawns the worker child
  decoupled from the invoke lifetime, persists the one-line result, and the
  gateway re-collects it idempotently. A node WS blip must not kill a turn.
- **Credential delivery.** The launch descriptor (including the per-turn
  credential) travels over the authenticated node channel instead of SSH
  stdin. Same trust domain: the node host is the machine-side agent either
  way.
- **Workspace sync without rsync.** Manifest-driven delta blob transfer over
  authenticated HTTPS against the gateway (the manifest machinery already
  computes exact changed-blob lists; rsync was only the carrier), with
  git-mode base fetch from origin when the project has one. Existing bounds
  (inventory entries, manifest bytes, reconcile caps) carry over. Nodes with
  an advertised local checkout skip gateway push entirely (the Amp model:
  runner identity = host + workdir + repo).
- **Persistent-machine lifecycle.** `destroy` = logical lease release.
  Provider `inspect` is tri-state against pairing + presence: _present_,
  _dormant_ (paired but offline, within the config-free 14-day dormancy
  ceiling — must NOT be driven to `orphaned` by the reconcile sweep), _gone_
  (unpaired or ceiling
  elapsed → normal orphan/reap path). A device-environment reaper keyed on
  unpair/dormancy — not on provider teardown proof — cleans rows,
  credentials, and staged refs. Explicit device removal, node-role removal, and
  silent superseded-pairing pruning share one client-invalidation, credential,
  environment, and placement reconciliation flow. Explicit RPCs wait for the
  credential fence before success returns; periodic reconciliation retries
  failed provider or placement cleanup. Placement startup, identity-mutation,
  and periodic reconciliation also compare each durable placement with the
  canonical session entry: confirmed absence force-fences live environments
  and exact-CAS retires safe terminal rows, while unreadable session evidence
  retains the placement. Unreferenced terminal environment rows retain
  seven days of operator diagnostics, then prune in bounded post-reconcile
  batches; any surviving placement keeps its environment provenance.
  Device-side GC of per-session workspace dirs and superseded bundles is a
  milestone exit gate, not an open question:
  persistent machines otherwise leak the user's own disk.
- **Placement `runner-offline`.** Pre-dispatch device loss waits up to 10
  seconds, then returns an operator-visible coordination error without failing
  the active placement or consuming model fallbacks. Idle active device
  placements survive Gateway restart and validate their reconnect-scoped
  tunnel lazily on the next turn. Durable status projection and the explicit
  "continue on gateway" / "wait for device" actions remain milestone work.
- **Dispatch target union.** `sessions.dispatch` accepts
  `{ profileId } | { deviceId }`; the device → environment mapping resolves
  server-side. Devices are not smuggled through synthesized
  `cloudWorkers.profiles` entries.
- **Concurrency slots.** The node supervisor admits two physical worker
  processes by default. Durable `pending` and `running` launches consume those
  slots atomically; same-launch replay consumes no additional slot. When full,
  the node withdraws `workerRuns` from its live inventory while retaining the
  supervisor dialect, restores it after a durable terminal commit, and gives a
  third launch up to 10 seconds to acquire capacity before failing visibly.
  Public inventory does not expose machine counters. Terminal node launch
  receipts retain a 24-hour replay window and prune in bounded batches;
  `pending` and `running` capacity reservations never age out.
- **Multi-gateway safety.** The worker install/workspace root on a node is
  namespaced by gateway identity so two gateways pairing one machine cannot
  corrupt each other's state.

Isolation on node runners: optional worker-in-docker/podman, same sandbox
axis as gateway-local sessions. Cloud leases keep full-permission-within-the-
box (the machine is the boundary).

Milestone 6 now has the public worker ingress, transport-neutral launch
descriptor, durable node-host supervisor, private launch/status/cancel dialect,
bounded terminal receipts, and the Gateway launch replay/poll/cancel adapter.
A node publishes one atomic, reconnect-scoped private runner inventory with the
supervisor dialect, explicit local consent, and current capacity. Milestone 7
removes the temporary local-package scanner and connect-time build claim; the
durable Gateway bundle receipt is the sole execution authority. Public node and
environment projections expose `sessionHost` plus a redacted installed/missing
bundle status; a read-scoped topology invalidation makes clients refetch without
exposing hashes, paths, or receipt details. Status and cancellation reacquire the current
supervisor proof and use the durable launch identity so an upgrade cannot strand
an existing worker. Node-local opt-in advertises capacity; default nodes remain
non-hosts. The supervisor owns two atomic durable capacity slots, bounded
10-second admission, restart reconciliation, and full/free inventory edges.
Device dormancy expiry and terminal launch/environment retention bound durable
rows. Node workspace cleanup waits for a full reconnect-scoped Gateway retain
snapshot, unions that authority with node-local launch and operation ownership,
and then removes retired generations, transfer siblings, unreachable manifests,
and empty workspace parents in bounded passes. The Gateway bundle producer
also prunes unreferenced local tarballs only after a successful current build,
while preserving hashes named by durable environments and placements. Isolation,
checkout ownership, and durable offline recovery actions remain milestone 6
work.

### Trust model (operator-decided, v1)

Cloud workers run full-permission because the box is disposable and
credential-free. A paired personal machine is neither. The v1 resolution:

- **Only admins pair nodes** (already enforced: `role: node` device approval
  requires `operator.admin`; the join-code mint is admin-scoped). Pairing a
  node is the admin declaring it **shared team infrastructure** — a server,
  a build box, a dedicated workstation. That is the consent boundary for
  "everyone on the gateway may dispatch to it and session content lands on
  it."
- **Personal-device runners are out of scope for v1.** They arrive together
  with per-person node ownership (visibility + dispatch policy keyed on a
  recorded owner), not before. Approver identity is recorded at pairing time
  from day one as **provenance, never authorization** (additive nullable
  column), so the later policy has data to stand on.
- **Phones and low-trust devices never advertise session hosting.**
  Capability gating, not ontology: the picker never offers them.
- Non-interactive approval side doors (trusted-CIDR, SSH-verify,
  trusted-proxy browser auto-approve) remain scoped to their current
  presence-level grants and are reviewed for the hosted-gateway class; none
  may mint a session-capable node without an admin.
- Inference stays gateway-proxied; provider keys never reach nodes. If nodes
  ever fetch private repos from origin directly, the gateway mints
  short-lived scoped git credentials per dispatch; no standing PATs on nodes.

### Onboarding (milestone 3)

Copying the industry-standard split (short-lived enrollment secret →
long-lived device identity; GitLab deprecated reusable registration tokens to
get here, Tailscale's key/device revocation split is the documented model):

- Admin mints a **single-use, ~10-minute join code** (≥128-bit entropy) from
  the picker's "Connect a machine…" foot or `openclaw devices` CLI. The
  existing `device.pair.setupCode` RPC and `node` bootstrap profile are the
  substrate; the code pre-approves exactly the node role with zero operator
  scopes.
- The pasted one-liner is `npx openclaw connect <url-or-code>` (top-level
  verb; `openclaw node run` stays as the plumbing command). It accepts the
  full `oc-pair://` payload (offline form, carries gateway URL + bootstrap
  token + optional TLS pin for self-signed gateways) or an
  `https://<gateway-host>/j/<shortcode>` URL whose payload is fetched over
  TLS. `--service` installs the OS service instead of running foreground.
  A curl installer wrapper on the public website installs the CLI and execs
  the same verb; the public site never sees tokens.
- The gateway serves `/j/<shortcode>` (reserved prefix in Control UI routing,
  single-use burn, strict per-IP rate limiting).
- Revocation split, documented: revoking a join code never unpairs nodes;
  removing/banning a node is a first-class devices-page action that also
  fences in-flight placements. Node auto-cleanup after a long dead period
  mirrors runner-industry practice.

### Bundle and updates (milestone 7)

Exact-hash admission stays. The pinned, content-hashed bundle is pushed to
the node over the already-authenticated paired channel. Consent is split so
it cannot rot into approval fatigue or silent surprise:

- **Consent to be a runner**: one-time, per-device, at pairing/enablement.
- **Consent to run a build**: satisfied by the channel — bundles arrive only
  from the gateway this admin paired, and updates on dispatch are the normal
  managed-runner behavior (GitHub runners self-update the same way). The
  devices page shows the installed runner version; the gateway refuses
  dispatch to stale nodes with a doctor-style hint instead of failing
  silently.

The first milestone 7 slice (#123985) adds the private paired-channel install
command, one-use Gateway download capability, bounded archive validation, and
atomic namespaced publication. The cutover slice (#124037) packages the complete
worker JavaScript dependency closure into one dedicated, hash-covered executable,
installs that exact Gateway artifact before device environments become ready,
requires its durable receipt across attach, admission, placement, tunnel, and
launch, retires stale environments for idempotent reprovisioning, and removes
local-package execution. The cleanup that follows separates inventory consent and
capacity from installed bundle state and deletes the obsolete local build scan.
The retention slice (#124590) reuses the authoritative maintenance snapshot to
prune superseded node bundles in bounded generation-acknowledged passes. The
installed-status slice validates one retained hash on the node, keeps that fact
reconnect-scoped and proof-bound in the Gateway, and shows the Gateway-owned
version quietly on Devices or a remediation warning when the bundle is missing.

### Projects read model (milestone 4 foundation)

OpenClaw already computes project identity twice without naming it: the
worktree service derives `originUrl` + a 16-char repo fingerprint
(`src/agents/worktrees/service.ts:199-205`), and the sessions catalog groups
Codex/Claude rows by project folder, folding `.claude/worktrees/<name>` into
its origin repo. This component promotes that to a first-class observed read
model alongside the registered projects already returned by `projects.list`,
following the same computed pattern as `environments.list`:

- **`projects.list.observedProjects` read model** (computed for
  write-capable callers, no new store): group known checkouts by repo fingerprint → `{ name, originUrl, checkouts:
[{runnerId, path}], lastUsedAt }`. Sources: session rows
  (`execCwd`/`execNode`) and the managed-worktree registry. The observed
  paths and sanitized origins are returned only to `operator.write` callers;
  read-only callers keep the registered project catalog and project-only
  recents. Device-advertised checkouts remain milestone 6 work.

### UI (milestone 4)

Revision 1's design rule stands: normal state is silent; only exceptions
speak. Additions:

- **Use the existing environment type discriminant** for picker grouping:
  local gateway, execution-capable nodes, worker environments, and the
  separate cloud profiles list. Device-runner inventory adds `sessionHost`
  without creating another place ontology.
- **Where picker regrouped** (`ui/src/pages/new-session/place-picker-sections.ts`):
  sections "This gateway" / "Devices" / "Cloud". Device rows intersect the
  environment catalog with execution-capable paired nodes; connected rows are
  selectable, while remembered offline rows stay visible but disabled. Cloud
  profiles remain their separate list. Folder and destination stay
  orthogonal.
- **Node connection history is server-owned.** Successful node hello records
  `lastConnectedAtMs`; retiring that exact pairing generation and connection
  records `lastDisconnectedAtMs` in the existing node surface. `node.list` and
  `environments.list/status` project those facts. The picker uses the existing
  topology refresh events and distinguishes "Never connected", "Offline for
  …", and the legacy/unclean-exit fallback "Last seen …". Connected rows stay
  silent. This adds no config, event, or SQLite schema-version surface.
- **Placement chip** on the session header: shows quiet current placement;
  active cloud placements reclaim through `sessions.reclaim` with "Bring
  home". Stop-and-continue moves arrive with milestone 8.
- **Remaining milestone work**: the admin-gated "Connect a machine…" foot,
  busy/slot state, and durable `runner-offline` recovery actions. Pre-dispatch
  offline attempts already fail visibly after a 10-second grace without
  terminalizing the placement.

### Cloud convergence (milestone 10)

The bundled Crabbox provider now boots the box and runs
`openclaw connect <setup code> --ephemeral` in an isolated per-lease state
directory. The Gateway persists one replay-safe setup identity, atomically
binds the authenticated device identity to the worker environment, pushes the
current bundle through the node channel, and removes the node role after
provider teardown. `destroy` = release lease plus pairing cleanup. Codex
remote-exec fails before allocation because it still requires an SSH-backed
provider. The remaining milestone work is soak proof and deletion of the
replaced reverse-tunnel/rsync cloud carrier; distinct SSH sandbox contracts
stay until their own replacements are proved.

## What the adversarial reviews killed or reshaped

Carried forward from revision 1 (still true): no Places registry
(`environments.list` stays the read model, enriched additively); no dispatch
into a live checkout without exclusive ownership; `exec host=node` stays
untouched (different product, different policy domain); no sandbox-as-a-place
picker row; no fake mobility verbs; no live migration; no multi-gateway
federation; no phones as runners.

Revised or new in revision 2:

- Revision 1's "device runners are the existing worker stack with essentially
  no changes" was **overstated**: admission, placement, claims, stores, and
  the worker protocols are reused; transport, credential delivery, sync
  carrier, and launch durability are net-new. Scope milestone 6 accordingly.
- Revision 1's "ship sshd first" transport is **deleted** (unreachable target
  machines; industry-divergent).
- "Everyone dispatches" is **bounded by the trust model above** — shared
  infrastructure only, until per-person ownership ships.
- The `node.invoke` byte-pipe idea (this revision's own first draft) was
  killed by measured protocol constraints; the direct-dial worker connection
  replaced it.

## Prior art (what we copy, what we skip)

- **Amp** (verified by static CLI teardown + manual): outbound WSS only via
  actor framework; per-user control channel carries registration, heartbeat,
  presence, and dispatch intents in heartbeat responses; per-thread WS for
  live sessions; agent loop local on the runner in an existing checkout (no
  file sync; identity = host + workdir + repo URL); inference centralized
  server-side; per-workdir PID claim prevents double-serving. We copy the
  two-channel shape, dispatch-over-control-channel, and checkout
  advertisement; we keep inference gateway-proxied (their centralization is
  a billing choice, not architecture); we scope enrollment tighter than
  their single long-lived API key.
- **GitHub Actions runners**: registration token → device keypair; JIT/
  ephemeral single-job runners; self-update with a staleness ceiling and
  dispatch refusal; blunt security docs about persistent runners running
  untrusted code. All copied in spirit above.
- **Tailscale**: auth-key vs node-key split and the revocation split warning.
  Copied, documented.
- **VS Code tunnels**: the gold-standard enrollment UX (run one command,
  browser confirms); device-code-style confirmation is a candidate
  alternative to pasted codes later. Their 10-tunnel account cap validates
  bounded per-gateway node counts.
- **Coder / Gitpod Flex**: control/data plane split with customer-side
  execution and orchestration-only control plane — the closest analog to
  "inference on gateway, execution on node," validating it as a coherent
  residency story. Gitpod's ~30s registration renewal is the liveness-lease
  reference if presence needs tightening.
- **Cursor / Claude Code / Codex cloud**: managed-VM-only execution with
  git-based handoff; Claude Code's proxy-minted scoped git credentials
  inform the scoped-git-token rule above; teleport-style continuation
  validates attach-only sessions (which OpenClaw gets for free).

## Milestones

Independently mergeable PR series; 3–5 can interleave after 1c.

1. **1c naming cleanup**: finish nodes → devices in route ids, i18n keys,
   labels; `node-pairing.ts` facade merge. Before any new placement copy.
2. **Continuation ergonomics** (in progress): `openclaw resume` plus the web
   **Continue in terminal…** session action. The browser copies one
   credential-free command with one bounded, versioned, URL-safe handoff
   argument that encodes the exact qualified session key and selected Gateway
   WebSocket URL without shell-specific quoting. The key is agent-qualified and
   bounded to 512 user-perceived characters. Query-routed Gateway URLs are
   intentionally excluded because authentication and stored device scope are
   not query-aware; the UI never strips or copies the query and instead directs
   operators to a manually authenticated target or queryless configured URL. It
   never executes the CLI or delegates first-use authentication. Before attach,
   Resume asks the Gateway to resolve the key, uses only the returned canonical
   key, and rejects a missing or ambiguous handoff without starting another
   session. Resume may reuse only the current
   profile's auth, SecretRefs, and exact-origin device auth when the handoff URL
   byte-for-byte matches a target owned by the configured mode: local + Control
   UI base path or public origin + base path in local mode, and only the remote
   URL in remote mode. TLS pin reuse is limited to direct-local and
   configured remote identities; public origins inherit no local-listener pin.
   Ambient Gateway auth env fallback is suppressed for handoffs. Mismatches fail
   closed, terminal auth remains independent, and session ACLs stay
   authoritative.
3. **`openclaw connect`**: verb + `oc-pair://` decoder + TLS pin in payload +
   `/j/<shortcode>` join route (reserved prefix, single-use, rate-limited) +
   shortcode mint + curl wrapper on the public site. Exit: a fresh machine
   pairs against a remote gateway with one pasted command and one admin
   click, no manual approval steps.
4. **Picker** (in progress): regrouped sections, quiet placement + reclaim,
   and the observed projects read model land first; live presence subscription,
   the admin-gated "Connect a machine…" foot, additive `EnvironmentSummary`
   enrichment, and never-connected vs lost states complete the milestone.
5. **Public worker ingress**: path-tagged worker upgrade on the main TLS
   endpoint; opaque admission failure; shared preauth budgets. Exit: a worker
   process on any internet host with a valid dispatch credential completes
   admission; invalid attempts are cheap and unenumerable.
6. **Node worker provider**: lease union, dispatch target union, node tunnel
   handle, durable supervised launch, HTTPS delta sync + origin fetch,
   tri-state inspect + reaper + GC, concurrency slots, `runner-offline`
   placement semantics, gateway-namespaced install root, approver-provenance
   column. Fault-injection tests gate exit: device sleep mid-turn, node WS
   blip mid-turn (turn survives), gateway restart with offline device,
   credential expiry, slot saturation, dispatch-with-no-live-runner timeout.
   The local-install route lands as three PRs: **A** enables node session-host
   advertisement and completes receipt/credential provisioning; **B** wires
   supervised worker launch with a clean, published HTTP(S) origin-clone
   fallback and unchanged-workspace verification; **C** replaces that typed
   `workspace-transport-pending` boundary with authenticated workspace
   transfer and full reconciliation. Part C carries clean, dirty, unpublished,
   plain-directory, submodule, and Git LFS workspaces through a closure-bound
   HTTPS capability; clean published origins remain an optional fast path.
   Milestone 7 then upgrades this paired-machine claim to Gateway-pinned bundle
   bytes.
7. **Bundle push + updates**: consent split, push over paired channel,
   version surfacing, stale-node dispatch refusal.
8. **Stop-and-continue moves**: drain + reclaim + re-dispatch to another
   runner, reusing the migration barrier.
9. **Deletions**: ssh sandbox backend + remote-fs bridge (~2.35k LOC),
   openshell overlap (~3.4k LOC, verify usage first), exec-host structural
   clones (~3k of ~5k LOC), one-shot `agent.cli.claude.run` node path
   (superseded by full session hosting), node/device pairing merge remainder.
   Each gated on its replacement, each its own PR with proof.
10. **Cloud convergence**: `--ephemeral` enrollment, provisioners run
    `openclaw connect`, then delete the SSH tunnel/rsync transport stack.

Net production LOC across the plan is targeted negative: milestones 3–5 are
small additions, 6–7 are mostly a provider + one transport implementation
against reused machinery, and 9–10 delete more than everything before them
adds.

## Open questions

- Dormancy ceiling default (how long a sleeping device stays `dormant`
  before its environments reap) — proposal: 14 days, config-free, revisit
  with usage.
- Slot count default for node runners — proposal: 2 for interactive-class
  devices, higher for server-class; needs a capability signal or a connect
  flag.
- Device-code-style browser confirmation (VS Code model) as an alternative
  to pasted codes — later, once `/j/` exists.
- Repo-owned environment setup (devcontainer.json) for worker profiles —
  unchanged from revision 1: adopt the spec if/when it lands, separate plan.
- Forge integration (repo lists, clone-anywhere, PR status) — explicitly out,
  follow-up once the derived project model has usage.
