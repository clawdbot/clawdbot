---
summary: One placement model for sessions — the gateway, paired devices, and cloud boxes are all runners; clients attach to sessions, never to runners.
title: Runners plan
read_when:
  - Designing or reviewing where sessions run (gateway, device, cloud)
  - Changing the Where picker, device pairing, or worker dispatch surfaces
  - Naming anything around sessions, devices, or placement
---

## Status

Proposal, revision 1. Implementation in progress (autonomous build started
2026-08-08; this section tracks live status — update it in every PR that
advances a milestone).

| #   | Milestone                                            | Status      | PRs     |
| --- | ---------------------------------------------------- | ----------- | ------- |
| 0   | This plan                                            | landed      | —       |
| 1a  | Naming: session copy revert                          | landed      | #120667 |
| 1b  | Naming: devices consolidation                        | landed      | #120689 |
| 1c  | Cleanup: node-pairing → device-pairing merge         | not started | —       |
| 2   | `openclaw resume` + web Continue in terminal         | in progress | #120664 |
| 3   | `oc-pair://` one-paste pairing                       | not started | —       |
| 4   | Picker + enrichment + projects read model            | not started | —       |
| 5   | Device runners                                       | not started | —       |
| 6   | Stop-and-continue moves                              | not started | —       |
| 7   | Deletions (ssh sandbox, openshell, exec-host clones) | not started | —       |

Proposal history: direction agreed 2026-08-08 after a
code-evidence investigation (three deep-reads of the worker, exec, and node
stacks), an industry survey (Amp runners/orbs, Cursor 3 location picker,
Claude Code teleport, Codex cloud, VS Code tunnels, Tailscale auth keys), and
three adversarial reviews whose kill-verdicts are folded in below as explicit
non-goals. Builds directly on the shipped cloud-workers architecture
(`docs/plan/cloud-workers.md`, `docs/gateway/cloud-workers.md`); it does not
replace it.

## Problem

OpenClaw has three disconnected answers to "where does work run":

- **Nodes** receive forwarded `exec host=node` calls only; the turn loop never
  leaves the gateway. A user's always-on Mac Studio is less capable as a
  session host than a throwaway AWS lease.
- **Cloud workers** host full sessions, with a durable placement state
  machine, but only against ephemeral provider leases.
- **The ssh sandbox backend** is a third remote-execution path (gateway-held
  SSH credentials, per-tool remoting) that duplicates the shape cloud workers
  superseded.

The UI mirrors the fragmentation: placement is chosen once in the new-session
popover from a flat list mixing three ontologies (gateway, exec nodes, cloud
profiles), then becomes invisible and immutable. Placement config is spread
across `tools.exec.*`, `agents.entries.*.tools.exec.node`,
`agents.defaults.sandbox.*`, `gateway.nodes.*`, and `cloudWorkers.profiles`.
Vocabulary drifted: the Control UI says "thread" (July 2026 copy rename, PRs
110933/110973) while the CLI, protocol, stores, and docs say "session";
paired hardware is "nodes" in routes/i18n and "devices" in paths/labels.

## Model and vocabulary

```
Session   gateway-owned: transcript, identity, placement, managed worktree.
          Clients (web, TUI, macOS app, channels) attach to sessions,
          never to runners. One noun, everywhere: session.
Runner    anything that can host a session's turn loop:
            - the gateway itself (the runner you get for free)
            - a paired device (via a node-backed worker provider; see below)
            - a cloud box (existing crabbox worker provider)
Isolation a property OF the runner, not a place:
            cloud box       -> the machine is the boundary
            gateway/device  -> none | docker | podman (existing sandbox)
Device    paired hardware (today's "nodes"). Devices contribute
          capabilities (camera, canvas, exec) as peripherals; a device
          becomes a runner only through the worker admission path.
Project   repo identity: normalized remote.origin.url, with the existing
          16-char repo fingerprint as the no-remote fallback. Derived,
          never registered.
Checkout  project × runner = { runnerId, path } — where a project
          physically exists. Cloud runners have none; they materialize
          a fresh checkout per session.
Folder    the non-git escape hatch: a plain path on one runner
          (today's browse flow, unchanged).
Turn      one prompt-to-response work attempt inside a session
          (matches ACP and the worker protocol).
```

Naming rulings (operator-decided 2026-08-08):

- **session** is the only product noun for a conversation. The Control-UI
  "thread" copy is reverted (i18n + test literals; technical identifiers never
  changed). Industry: 9–2 for session among agent products; ACP says session;
  "thread" collides with Discord/Slack/Telegram sub-thread transport concepts.
- **devices** is the user-facing word for paired hardware; "nodes" remains
  protocol/internal vocabulary only. The route/i18n debt (`nodes` route id,
  `/settings/devices` path, `nodes.*` i18n keys) consolidates on devices.
- New CLI ergonomics ship as **verbs** (`openclaw resume`), never a second
  noun command next to `openclaw sessions`.
- "runner" is an internal/docs concept; UI copy says "Runs on …".

VISION.md gains one paragraph: the gateway is the coordinator and the default
runner; every other machine — yours or leased — can be a runner; clients
attach to sessions, so where a session runs never changes how you talk to it.

## What the adversarial reviews killed (now non-goals)

- **No Places registry.** `environments.list`
  (`src/gateway/server-methods/environments.ts:143-157`) already returns the
  merged read model: gateway entry, node catalog (paired + live presence),
  worker environments, cloud profiles. A persisted registry would duplicate
  presence facts; a renamed RPC is a second path. We enrich `EnvironmentSummary`
  additively instead.
- **No turn loops on the node role.** The node protocol was already rejected
  as a loop transport (cloud-workers.md §4): a connected node can emit
  arbitrary node events, so its capability ceiling is not an ingress boundary.
  Worker ingress stays a closed three-method allowlist
  (`packages/gateway-protocol/src/schema/worker-admission.ts:32-34`) with
  minted per-dispatch credentials and exact bundle-hash admission
  (`src/gateway/worker-environments/admission.ts:80-104`). Devices become
  runners only by running `openclaw worker` under that admission.
- **No dispatch into a live checkout.** Workspace sync requires exclusive
  ownership of the remote dir (wiped every sync,
  `workspace-sync-setup-script.ts:29`); reconcile treats divergence from the
  base manifest as worker output. Device runners use the same private
  per-session dir under `$HOME/.openclaw-worker/` that the qa-lab static-ssh
  provider proves today.
- **No folding of `exec host=node`.** Per-call exec routing is ~5k LOC of
  four-layer fail-closed approval machinery (gateway TOCTOU re-checks, node
  policy floor, `systemRunPlan` hash binding revalidated on the node,
  node-local re-evaluation). It serves a different product (one command in a
  different policy domain) and stays untouched.
- **No sandbox-as-a-place row.** Sandbox is per-agent isolation config with
  no per-session override surface; a picker row would silently do nothing for
  unconfigured agents.
- **No fake mobility verbs.** `sessions.dispatch` accepts `local|reclaimed`
  placements and cloud profiles only (`sessions-dispatch.ts:166-176`); there
  is no pause and no machine-to-machine move. The UI shows only what the
  backend does: display + reclaim now; move-as-stop-and-continue after device
  runners ship.
- **No exec pre-approval in pairing links.** The one-paste flow may
  pre-approve presence-only scopes; `system.run` and folder sync always pass
  the existing pending-approval or SSH-verify gate
  (`src/gateway/node-pairing-ssh-verify.ts`).
- **No live migration, no multi-gateway federation, no phones as runners.**

## Components

### 1. Session continuation ergonomics (independent, ships first)

Already true by construction: the transcript and placement live on the
gateway, inference originates from the gateway in every placement, and the
TUI is a full gateway client (`openclaw tui --session <key>`, Ctrl+P picker,
last-session resume — `src/tui/tui-last-session.ts`). Start a session on the
web running in the cloud; the TUI attaches and turns route to the worker.

Delta is ergonomics only:

- `openclaw resume [query]` — fuzzy-match recent sessions across agents by
  name/key; no query opens a picker; resolves to `tui --session <key>`.
- Web UI "Continue in terminal" on session rows: shows the exact command
  (`openclaw resume <key>`), mirroring the terminal-resume affordance the
  Codex/Claude session catalogs already have.
- No new protocol surface; `sessions.list` already carries what the resolver
  needs.

Follow-up: boundary-level resume test (gateway → session list → attach) needs a lightweight CLI-side gateway harness; the existing helper costs ~370s under the CLI vitest config.

### 2. One-paste device pairing (independent)

Reuse the shipped setup-code flow: `PairingSetupPayload = { url, urls?,
bootstrapToken }` base64url blob (`src/pairing/setup-code.ts:40-44,406-410`),
10-minute single-use bootstrap token, `bootstrapProfile: "node"`
(`src/shared/device-bootstrap-profile.ts:61-94`), minting RPC
`device.pair.setupCode` (`src/gateway/server-methods/device-pair-setup.ts`).

Gaps to close:

- `oc-pair://<setupCode>` scheme wrapper (payload unchanged).
- `openclaw node run --pair <code|url>` redeem path: decode blob, configure
  host/port/token, connect (today only `--host/--port/--tls-fingerprint`
  flags exist, `src/node-host/runner.ts:27-37`).
- Add the TLS fingerprint to `PairingSetupPayload` (node host already accepts
  a pin; the blob cannot carry it).
- Expose the `node` bootstrap profile in the Control UI pairing dialog
  (RPC-only today, `ui/src/lib/device-pair-setup.ts`).
- Tailscale-style key split, stated in docs: the pairing token is short-lived
  and one-shot; the resulting device credential is long-lived; revoking one
  never revokes the other.

Exec/scope escalation is unchanged: first `system.run` request lands in
pending approval or auto-approves via SSH-verify.

### 3. Device runners (the core)

A device runner is the existing worker stack pointed at a persistent machine.
Evidence that the stack is ready:

- Provider contract is tiny and SSH-generic
  (`src/plugins/capability-provider.types.ts:97-114`): `provision → {leaseId,
ssh}`, `inspect`, `destroy`. The qa-lab static-ssh provider
  (`extensions/qa-lab/src/static-ssh-worker-provider.ts:70-91`) already wraps
  a persistent host with a no-op destroy, and sync/reconcile work unmodified
  because the remote workspace is a private per-session mirror.
- Admission, placement state machine, SQLite stores, transcript CAS,
  inference proxy, and the `openclaw worker` runtime need essentially no
  changes; admission is credential-based, not transport-based.
- The seam is `WorkerTunnelHandle`
  (`src/gateway/worker-environments/tunnel-contract.ts:74`, 85 lines):
  workspace command execution + sync + quiesce behind one handle, currently
  SSH-only (`worker-turn-launcher.ts:337-344`, `workspace-sync-scripts.ts`).

Work items:

- **`device` worker provider**: `provision` maps a profile to an existing
  paired, connected device; `destroy` releases the logical lease. Config:
  `cloudWorkers.profiles.<id> = { provider: "device", settings: { device:
"<id-or-name>" } }` (bikeshed: rename the config block to
  `runners.profiles` with a doctor migration — decide at review).
- **Tunnel variant**: either (a) SSH to the device like any worker (device
  runs sshd; simplest, reuses everything), or (b) a `WorkerTunnelHandle`
  implementation that multiplexes workspace commands and the worker socket
  over the device's existing gateway connection. Ship (a) first; (b) is an
  optimization decided by review.
- **Pinned runtime with consent**: the gateway pushes its content-hashed
  bundle (existing bootstrap, `bootstrap.ts:26-104`) into
  `$HOME/.openclaw-worker/` on the device. Installing a runtime on a personal
  machine requires a one-time per-device operator approval, surfaced in the
  pairing/approval UI. Exact-version admission stays; version skew is solved
  by reinstalling the bundle, never by relaxing the check.
- **Offline/drain semantics** (the one genuinely new subsystem): personal
  machines sleep and cannot be destroyed. New placement handling for
  `runner-offline`: heartbeat loss marks the placement with a recorded,
  operator-visible reason (Product Doctrine: no silent non-outcome); staged
  results are preserved (existing fence machinery); the session offers
  "continue on gateway" (reclaim) or "wait for device". Reuse the wake-nudge
  subsystem (`src/gateway/node-wake-state.ts`) where the device has a wake
  channel.
- **Isolation on device runners**: optional worker-in-docker on the device,
  same sandbox axis as gateway-local sessions. Cloud runners keep
  full-permission-within-the-box (the machine is the boundary).

### 3b. Projects (derived read model)

OpenClaw already computes project identity twice without naming it: the
worktree service derives `originUrl` + a 16-char repo fingerprint
(`src/agents/worktrees/service.ts:199-205`), and the sessions catalog groups
Codex/Claude rows by project folder, folding `.claude/worktrees/<name>` into
its origin repo. This component promotes that to a first-class read model —
derived, never registered, same pattern as `environments.list`:

- **`projects.list` read model** (computed on demand, no new store): group
  known checkouts by repo fingerprint → `{ name, originUrl, checkouts:
[{runnerId, path}], lastUsedAt }`. Sources: session rows
  (`execCwd`/`execNode`), the managed-worktree registry, and
  device-advertised workdirs (below). "GitHub-ness" is just the originUrl
  host shown as a subtitle; no forge integration required to model it.
- **Device checkout advertisement**: the gateway cannot group cross-runner
  checkouts today because it never learns a device checkout's origin. Device
  runner enablement (component 3) adds `{path, originUrl}` pairs to the
  device handshake — the Amp host+workdir idea landing in the right seam.
  Small, additive, and only sent for paths the operator enabled.
- **Picker flow**: project first (chip ⌃J), then the Where chip narrows to
  "where does this project exist" — checkout paths as row subtitles; runners
  without a checkout are listed honestly ("no checkout · clones from origin
  on first session"); cloud is always eligible (fresh clone). Recents group
  by project instead of deduping raw `(folder, node)` pairs
  (`ui/src/pages/new-session/recent-places.ts`). "No project" keeps the
  existing per-runner folder browser as the escape hatch.
- **Forge integration is a later, separable phase**: repo lists from GitHub,
  clone-a-repo-you've-never-touched, PR status on session rows. The derived
  model needs none of it; registration-style project creation (the
  cloud-only-product pattern) is explicitly rejected — projects appear
  because you worked on them.

### 4. UI convergence

Design rule (operator-decided, 2026-08-08): **normal state is silent; only
exceptions speak.** No online dots, no persistent/disposable/peripheral
labels, no status pills — being listed in the picker already means usable,
and the operator knows what their own devices are. Status text appears only
for exceptions ("offline · 2h", the runner-offline banner) or facts the
operator cannot infer (provisioning time, "runs in docker"). Capability
chips stay: they are structured facts, not status. Placement on a running
session is quiet text ("on aws"), not a badged widget — the activity spinner
already carries liveness.

- **Enrich `EnvironmentSummary` additively** (protocol, no migration):
  `trust: "persistent" | "disposable"`, `sessionHost: boolean`, `platform`,
  and for profiles a provider-supplied `class` label. No pricing fields until
  a provider actually supplies prices.
- **Where picker regrouped** (`ui/src/pages/new-session/place-picker.ts`):
  sections "This gateway" / "Your devices" (session-capable, connected
  devices only — phones and offline devices stay hidden by gating) / "Cloud".
  Folder and destination stay orthogonal. Copy: "Runs on {place}".
- **Placement chip** on the session header: shows current placement and
  state; menu offers exactly reclaim ("Bring home") for cloud placements
  today, plus stop-and-continue moves once device runners ship. Reuses the
  placement subscription the sidebar badges already consume.
- **Devices page**: fold live-sessions-per-device into the existing
  `ui/src/pages/nodes/` surface (renamed to devices end-to-end). No new
  top-level nav item; the picker's "Connect a device…" foot links here.
- **Naming wave** (one PR, early, before new copy lands): revert thread →
  session in Control UI copy; consolidate nodes → devices in route id, i18n
  keys, and labels. Route aliases per the UI's existing alias mechanism.

### 5. Deletions and dedup (each gated on its replacement)

| Target                                                                                                                                                                                                    | Size       | Gate                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| ssh sandbox backend + remote-fs bridge (`src/agents/sandbox/ssh*.ts`)                                                                                                                                     | ~2.35k LOC | device runners cover the "tools on my server" case                 |
| openshell overlap (`extensions/openshell`)                                                                                                                                                                | ~3.4k LOC  | verify real usage first; same SSH-transport shape                  |
| exec-host structural clones (`bash-tools.exec-host-gateway.ts` vs `exec-host-node*.ts`: allowlist eval, auto-review, timeout-fallback, follow-up delivery; node host re-clones the analysis a third time) | ~3k of ~5k | extract one shared approval state machine; node plan-binding stays |
| `node-pairing.ts` facade over `device-pairing.ts` + migration shims                                                                                                                                       | medium     | finish the merge; one vocabulary                                   |
| UI placement watchers (`cloud-recovery-state.ts` + sessions-page reconcile loops)                                                                                                                         | medium     | one placement-watching controller                                  |

Net production LOC across the whole plan is targeted negative: components 1–2
are small additions; component 3 is mostly a provider plugin + one tunnel
variant against reused machinery; component 5 deletes more than 3 adds.

## Prior art (what we copy, what we skip)

- **Amp agents-anywhere**: runners as first-class picker entries; identity =
  host + workdir with optional pinned name → we key on device id and
  advertise workdirs. Amp leaves offline-runner behavior undocumented; our
  `runner-offline` recorded state is the deliberate improvement.
- **Tailscale auth keys**: one-shot short-lived pairing key vs long-lived
  device credential, separate revocation → copied in component 2.
- **Claude Code teleport**: continuation re-materializes state because their
  cloud session lives elsewhere; OpenClaw's gateway-owned sessions make
  continuation attach-only — simpler, no state movement. Their fork-not-move
  semantics inform our stop-and-continue framing.
- **Cursor 3 location picker**: Local/Worktree/Cloud/SSH in one dropdown
  validates the single-picker UX; their live cloud-handoff shipped buggy —
  we do not attempt live moves.
- **devcontainer.json**: if/when repo-owned environment setup lands for
  worker profiles, adopt the spec rather than inventing a format (Cursor's
  proprietary environment.json accrued debt; Gitpod migrated to the spec).

## Milestones

Independently mergeable PR series, roughly in order; 1–3 can interleave.

1. **Naming wave**: session copy revert + devices consolidation (UI/i18n/tests
   only; no protocol or CLI changes).
2. **Continuation ergonomics**: `openclaw resume`, web "Continue in
   terminal".
3. **Pairing**: `oc-pair://`, `node run --pair`, TLS pin in payload, node
   profile in the pairing UI.
4. **Picker + enrichment**: additive `EnvironmentSummary` fields, regrouped
   Where picker, placement chip (display + reclaim), `projects.list` read
   model + project-first picker flow (gateway-side checkouts only until 5
   adds device advertisement).
5. **Device runners**: device worker provider (SSH transport first), pinned
   bundle install with per-device consent, checkout advertisement
   (`{path, originUrl}` in the enablement handshake), `runner-offline`
   placement semantics with recorded reasons, optional worker-in-docker
   isolation.
   Fault-injection tests (device sleep mid-turn, gateway restart with
   offline device, credential expiry) gate exit — same bar cloud workers set.
6. **Stop-and-continue moves** (chip verb "Move to…"): drain + reclaim +
   re-dispatch to another runner, reusing the migration barrier.
7. **Deletions**: ssh sandbox backend, openshell overlap, exec-host clone
   extraction, node/device pairing merge — each in its own PR with proof the
   replacement covers it.

## Open questions

- Config naming: keep `cloudWorkers.profiles` (compat) or migrate to
  `runners.profiles` via doctor in milestone 5?
- Device-runner transport (a) sshd vs (b) multiplexed gateway connection:
  ship (a) first; is (b) worth the protocol surface at all?
- Should `openclaw resume` also start the gateway/TUI in local mode when no
  gateway is reachable, or fail with guidance?
- Repo-owned setup contract (devcontainer.json) for worker profiles: this
  plan or a follow-up?
- Forge integration (GitHub repo lists, clone-anywhere, PR status on session
  rows): explicitly out of this plan; follow-up once the derived project
  model has usage.
- Project naming collision: `openclaw fleet` and multi-tenant docs use
  "project" loosely in places — sweep during the naming wave to keep
  "project" exclusively for repo identity.
