---
summary: "Dispatch session work to throwaway cloud machines with OpenClaw worker turns or Codex remote execution"
title: "Cloud Workers"
sidebarTitle: "Cloud Workers"
read_when: "You want agent session work to run on ephemeral cloud machines, or you are configuring cloudWorkers profiles."
status: active
doc-schema-version: 1
---

Cloud workers move a session's coding work onto a throwaway cloud machine while the session stays visible in the sidebar and its transcript remains owned by the Gateway. OpenClaw runtime sessions hand the turn loop to a restricted `openclaw worker` process on the box. Codex runtime sessions keep the Codex app-server and turn loop on the Gateway, then send command, filesystem, and HTTP work to the box through an SSH-backed Codex sandbox exec-server.

Both modes use the same provisioning lifecycle: the Gateway leases a box, runs setup, installs and verifies the pinned OpenClaw bundle, records the bootstrap receipt, establishes the tunnel, and syncs the managed workspace. Remote-exec changes per-turn execution only; it does not skip or replace worker bootstrap.

When the work is done (or the box dies), the machine is discarded. The durable state — transcript, last-reconciled workspace files, and placement records — lives with the Gateway.

<Note>
Cloud workers are opt-in. Until you configure a profile, clients hide the Cloud destination and the Gateway does not advertise `sessions.dispatch`. The `cloudWorkers` config schema and the read-only `environments.list` and `environments.status` methods remain available for configuration and environment discovery.
</Note>

## What runs where

| Concern                            | OpenClaw `worker-turn` mode                             | Codex `remote-exec` mode                                               |
| ---------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Agent runtime and turn loop        | Cloud box (`openclaw worker`)                           | Gateway (Codex app-server)                                             |
| Command, filesystem, and HTTP work | Cloud box                                               | Cloud box through the SSH-backed Codex sandbox exec-server             |
| Model inference and provider auth  | Gateway, proxied by `{provider, model}` reference       | Gateway, including ChatGPT subscription or API-key auth                |
| Transcript and live session state  | Gateway, fed by the worker's replayable event stream    | Gateway through the normal local harness path                          |
| Workspace file state               | Changed on the box; reconciled and owned by the Gateway | Changed in the same synced remote workspace; reconciled by the Gateway |

Remote-exec installs no Codex binary on the box and sends no Codex auth material there. The local app-server selects the placement's sandbox exec-server and exact remote workspace; the Gateway retains auth and inference ownership.

The box needs no inbound ports except `sshd`: the Gateway connects out via pinned SSH, and a reverse tunnel carries the worker's WebSocket back. The bundled Crabbox provider forces the public SSH route and disables managed Tailscale enrollment. Outbound internet access is provider policy; the default AWS profile can reach the internet unless you restrict its network or security group.

## Requirements

- A worker provider plugin. The bundled `crabbox` plugin drives the [Crabbox](https://github.com/openclaw/crabbox) CLI, which brokers leases across cloud backends (AWS, Hetzner, and others). Install Crabbox 0.41.1 or newer for the operating-system user that runs the Gateway and put it on that user's `PATH`, or set `settings.binary` to its absolute path. Keeping placed workers alive also requires a release that includes `crabbox heartbeat` (added after v0.43.0). Versions through 0.43.0 can allocate fixed-ID worker leases but lack heartbeat support; OpenClaw continues operating with one warning, and the coordinator may reap a placed worker after its `idleTimeout`.
- For Crabbox AWS workers, the effective `aws.instanceProfile` must be empty. The provider checks `crabbox config show --json` before allocation, then requires `crabbox inspect --json` to report `providerMetadata.instanceProfileAttached: false` from EC2 `DescribeInstances`. Leases with an instance role or without authoritative metadata are stopped and rejected.
- Node.js on the leased machine. Bare cloud images usually lack it — install it in the profile's `setup` command.
- A live, registry-owned session managed worktree (create one with `worktree: true`). Cloud dispatch does not accept an arbitrary plain directory. After dispatch admission, the workspace transport may use manifest mirroring if Git metadata later becomes unavailable; this transport behavior does not make plain directories dispatchable.

### Coordinator-backed Crabbox

In managed mode, the Crabbox coordinator owns the cloud-provider credentials and provisions AWS on the Gateway user's behalf. Local AWS keys are not required. Authenticate interactively, then verify the stored coordinator and provider state:

Crabbox normally discovers the Gateway host's outbound IPv4 when a lease is requested and sends that `/32` as the effective SSH ingress policy. This discovered value is request-scoped, so `crabbox config show --json` can legitimately continue to show an empty `aws.sshCIDRs` list.

For a fixed ingress policy, determine the outbound IPv4 yourself:

```bash
curl -fsS https://checkip.amazonaws.com
```

Then add that address as a `/32` to Crabbox's own configuration. For example, if the command prints `203.0.113.10`:

```yaml
aws:
  sshCIDRs:
    - 203.0.113.10/32
```

Direct SSH originates from the Gateway host, while the coordinator API may see a reverse-proxy or request-source address. Explicit pinning is useful when outbound detection is unavailable or a fixed policy is required.

```bash
crabbox login --url <coordinator-url> --provider aws
crabbox config show --json
crabbox whoami --json
crabbox doctor --provider aws --json
```

Before provisioning, review `crabbox doctor --provider aws --json` for provider-readiness failures. If `aws.sshCIDRs` is explicitly configured, also confirm `crabbox config show --json` reports the expected `/32`; an empty list is valid when using request-time discovery. `doctor` is non-mutating: it checks the coordinator, broker identity, local tools, and read-only AWS control-plane access without creating or changing a lease. It cannot prove mutating IAM permissions such as key-pair import, instance launch, tagging, or termination; a direct-provider report containing `mutation=false` is not a write-access attestation. Trusted automation can pipe an approved coordinator token through stdin instead of placing it on the command line:

```bash
printf '%s' "$CRABBOX_COORDINATOR_TOKEN" | crabbox login \
  --url <coordinator-url> \
  --provider aws \
  --token-stdin
```

Keep the token out of repository config and shell arguments.

## Configuration

Add a profile under `cloudWorkers.profiles` in `openclaw.json`:

```json
{
  "cloudWorkers": {
    "profiles": {
      "aws": {
        "provider": "crabbox",
        "install": "bundle",
        "settings": {
          "provider": "aws",
          "class": "standard",
          "ttl": "8h",
          "idleTimeout": "45m",
          "setup": "test -x /usr/bin/node || (curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs)"
        }
      }
    }
  }
}
```

Profile fields:

| Key        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` | Worker provider id registered by a plugin (`crabbox` for the bundled plugin).                                                                                                                                                                                                                                                                                                                                                               |
| `install`  | `bundle` (default) ships the running Gateway's worker executable; `npm` derives the same executable from the exact released Gateway package with pinned integrity. `npm` requires the Gateway to run from a packaged release.                                                                                                                                                                                                               |
| `settings` | Provider-owned JSON. For crabbox: `provider` (backend), `class` (machine class), `ttl`, `idleTimeout` (Go durations), optional `setup`, optional `desktop` (boolean), and absolute `binary` path. While a session remains placed, OpenClaw heartbeats its lease at a safe fraction of `idleTimeout`; teardown stops the heartbeat before releasing the machine. OpenClaw forces public SSH and disables managed Tailscale for these leases. |

Crabbox inspect reports a primary SSH port and may advertise ordered fallback ports. OpenClaw persists that order across Gateway restarts. Before first dispatch, workspace commands boundedly await a same-owner tunnel reconnect. Its shared pinned SSH transport rotates candidates only for replay-safe operations: idempotent probes, content-addressed transfers, receipt/lock-guarded artifact installation, convergent managed-worktree mirroring, and tunnel reconnects. Ambiguous unguarded stateful commands fail closed on their current candidate and are not replayed on another port. OpenClaw never invents an unadvertised port. If your network policy pins SSH ingress, allow at least one advertised Crabbox candidate.

OpenClaw derives one canonical `cbx_...` lease ID from the durable provision operation and passes it to `crabbox warmup --lease-id`; the deterministic slug is display metadata only. If warmup commits but its response is lost, Gateway reconciliation repeats the same fixed-ID operation and Crabbox returns or adopts only the exactly attested lease. Intent drift, terminal ID reuse, and ambiguous unverified resources fail closed without allocating a replacement. A legacy dispatch interrupted before OpenClaw recorded a lease ID cannot be identified safely and fails visibly instead of falling back to slug adoption.

### The setup command

`settings.setup` runs on the leased box after it is SSH-ready and before OpenClaw is installed. After setup succeeds, OpenClaw performs a fresh Crabbox inspect and waits for SSH readiness again before bootstrap, because setup may restart SSH. It runs on **every** provision attempt (including replays after an interrupted dispatch), so it must be idempotent — guard installs with a `command -v`/`test -x` check as in the example. If setup fails, the provider stops the lease and the dispatch fails closed; no half-configured box is left running.

### Install channels

- **`bundle`** ships one dedicated worker executable whose complete JavaScript dependency closure is bundled and content-hashed by the Gateway. It does not ship the normal OpenClaw package manifest or a dependency-install recipe. The box verifies and publishes those exact bytes without installing packages or running lifecycle scripts. This is how you run a dev build on a worker.
- **`npm`** proves the release exists on the public registry, pins its SHA-512 integrity, and extracts the same dedicated worker executable from `openclaw@<version>` without materializing the package's dependency tree.

### Verify the profile

Validate before restarting the Gateway:

```bash
openclaw config validate --json
openclaw plugins inspect crabbox --runtime --json
```

Changes under `cloudWorkers.profiles` require a Gateway restart. The default `gateway.reload.mode: "hybrid"` watches the config and performs that restart automatically; with reload watching disabled, run `openclaw gateway restart`.

After the Gateway is back, prove the profile is advertised and compare it with Crabbox's read-only lease inventory:

```bash
openclaw gateway call environments.list --params '{}'
crabbox list --provider aws --json
```

The `environments.list` response must include the configured id under `profiles`. `crabbox list` is non-mutating. By contrast, `crabbox warmup` provisions a lease, and `crabbox stop` or `crabbox release` tears one down; use those mutating commands only when you intend to create or destroy cloud resources.

## Dispatching a session

In the Control UI, open **New Session** and use the unified **Place** picker to choose both the working folder and a **Cloud · profile** destination. A cloud destination appears only when all four eligibility gates pass:

1. The connected operator has `operator.admin` scope.
2. `environments.list` advertises at least one configured profile.
3. The selected Gateway folder is a Git checkout that can use a managed worktree.
4. The selected agent runtime advertises cloud placement support.

Cloud selection enables that worktree automatically. The Gateway creates the session, finishes dispatch, and only then sends the first turn. The server badge in the session sidebar shows the durable placement state.

While a placement is active, OpenClaw automatically samples available space on the remote workspace volume. Low-space warnings appear in the selected chat and on the session's cloud badge. They are advisory, clear automatically after space recovers, and do not stop or reclaim the worker.

### Runtime support

- **OpenClaw** uses `worker-turn` placement. The restricted `openclaw worker` process runs each turn on the leased box and proxies inference through the Gateway.
- **Codex** uses `remote-exec` placement. The Codex app-server, model calls, and all prepared auth stay on the Gateway. Its command, filesystem, and HTTP operations run against the placement's synced workspace through the SSH-backed sandbox exec-server.

Other runtimes remain unavailable unless their harness explicitly declares a cloud placement mode. Cloud targets are not offered for external CLI session catalogs. Remote-exec fails closed if the placement sandbox or exec-server is unavailable; it never falls back to running the operation on the Gateway host.

The equivalent RPC flow is:

Create a session with a managed worktree, then dispatch it. The RPC requires `operator.admin` and is advertised only while at least one worker profile is configured:

```bash
openclaw gateway call sessions.create \
  --params '{"key":"agent:main:big-refactor","worktree":true,"cwd":"/path/to/repo","worktreeName":"big-refactor"}'

openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","profileId":"aws"}'
```

`sessions.dispatch` closes local turn admission, drains active work, validates the eligible Git workspace inventory, provisions the lease, runs setup, bootstraps OpenClaw, syncs the workspace, and returns once the placement reaches `active` ownership. Inventory validation happens before provider allocation and reports an invalid request with an actionable size or entry limit when the workspace cannot be dispatched. Budget several minutes for the first dispatch; leases and installs are cached where the provider supports it. After that, talk to the session as usual. OpenClaw turns route to the worker process; Codex turns use the local harness with the active placement's remote-exec sandbox.

Completed cloud turns reconcile eligible, size-bounded workspace files back into the session's managed worktree before the turn claim is released. Worker-turn uses its terminal worker event to create the durable pending-result fence. Remote-exec waits for workspace quiescence and enters the same reconciliation flow after the local Codex attempt. Before applying the result, the Gateway stages complete authenticated base/current manifests plus each changed resulting blob as a Git ref under `refs/openclaw/worker-results/`; deletions are represented by the manifests and need no blob. This keeps the cloud delta recoverable even if the Gateway stops during the apply without duplicating unchanged baseline content. Workspace results use Git file semantics: regular files, executable bits, symlinks, additions, changes, and deletions are retained, while empty directories and other directory modes are not. The resulting file changes remain in the managed worktree for normal review and commit.

Apply uses the dispatch-time manifest as the merge base. Cloud-only changes are applied, local-only changes stay in place, and paths changed on both sides use a three-way keep-local policy. A conflicted turn still finishes: the transcript reports the bounded path summary and staged result ref, the placement exposes the same conflict for the Control UI, and non-conflicting cloud changes remain applied. The notice includes `git show <ref>:<path>` to inspect a present cloud file and a top-level literal-pathspec `git checkout <ref> -- <path>` command to take it from any workspace directory. Run the commands in Bash or zsh (Git Bash on Windows). If inspect says the path does not exist, the cloud result deleted it; verify and remove the retained local path manually. If checkout reports a file/directory obstruction, move or remove the blocking local path and retry. If the staged ref itself is gone, treat the notice as stale and do not change the local path. Conflicted staged refs remain available after the normal turn fence is released; a later clean result clears the notice and retires the old ref, while explicit fence removal is the final cleanup boundary.

While a fenced result is still reconciling, a new turn waits up to 15 seconds for the prior claim to release. If it is still busy, the turn fails with an actionable “previous cloud turn's workspace result is still reconciling” message and can be retried shortly. On restart, recovery discovers pending and staged results before stale-claim cleanup, completes or retries their local apply, and reclaims dead environments only after preserving the result. The bounded SQLite rollback journal makes an interrupted filesystem apply recoverable without replaying already accepted mutations.

When the work is complete and no turn is running, open the session menu and choose **Stop cloud worker…**. The Gateway performs one final workspace reconciliation before it destroys the environment. A placement already in `draining` or `reconciling` is finishing teardown; wait for its badge to become `reclaimed` before deleting the session.

Archiving a non-main cloud-worker session with an active placement also performs this safe stop and reclaim before the Gateway records it as archived. If the placement is still transitioning or failed without proof that its environment is gone, the session remains unarchived; wait for the placement to settle, then retry. Restoring the session retains the reclaimed placement metadata so the next turn can dispatch a fresh worker with the same workspace profile.

For a broken or runaway cloud environment, an operator can call `environments.destroy` with `{ "force": true }` as a last resort. Forced teardown durably marks the placement failed and abandons any unreconciled remote result before destroying the environment.

The equivalent administrative RPC is:

```bash
openclaw gateway call sessions.reclaim \
  --timeout 600000 \
  --params '{"key":"agent:main:big-refactor"}'
```

The result placement is `reclaimed` after an active worker is safely stopped. If an earlier failure already proved that the environment is gone, reclaim clears the failed placement and returns `local` instead. No other placement states are successful reclaim results.

Placement moves through a durable state machine (`local → requested → provisioning → syncing → starting → active`), so a Gateway restart mid-dispatch reconciles instead of leaking machines. A failed model turn keeps the active placement available for a retry. Workspace path conflicts keep the local version, apply the rest of the cloud result, and preserve the staged cloud ref for inspection; other reconciliation or lifecycle failures retain their durable recovery fence and diagnostic tail until recovery can safely retry or reclaim the environment.

## What survives a dead machine

The Gateway owns the canonical session transcript in both modes. Worker-turn commits each complete user, assistant, and tool-result message before the worker's session write settles; remote-exec uses the normal local harness transcript path because the Codex app-server stays on the Gateway. If the machine disappears mid-message, durable history ends at the last committed message. Partial text or tool progress already shown by the live stream may disappear; the failed turn remains visible, and the failed placement records a bounded terminal reason above the composer.

Workspace state has a wider loss window. A completed turn reconciles cloud files before releasing its claim, and **Stop cloud worker…** performs one final reconciliation before destroying the machine. Changes made between reconciliations exist only on the box and can be lost. Session deletion does not synchronize an active placement: it must first be stopped or archived. Deletion then snapshots the already-reconciled managed worktree under `refs/openclaw/snapshots/` before removing it.

After a failed placement, redispatch the session and retry the turn. A reclaimed placement redispatches automatically on the next turn. The next turn rebuilds model context from the Gateway transcript, so it continues from the messages that crossed the durability boundary.

## Desktop (interactive)

Cloud Worker Desktop is an experimental Labs feature and is off by default. Enable **Cloud Worker Desktop** in **Settings → Agents & Tools → Labs**, or set `cloudWorkers.desktop: true`, then restart the Gateway for the Desktop panel to appear.

Set `"desktop": true` in a crabbox profile's `settings` to lease worker boxes with a branded XFCE desktop, Browser, and Terminal. Crabbox provisions TigerVNC on the box loopback with a per-lease password and reports the closed set of installed apps to the Gateway. The Labs gate enables the desktop RPCs and panel; the profile setting gives newly leased workers the desktop capability. Desktop is a warm-time capability: it cannot be added to an already-provisioned environment, so enable it on the profile before dispatching.

Operators with `operator.admin` access watch and control the desktop from the Control UI **Desktop** panel (also in the command palette). The panel lists desktop-capable environments from `environments.list`, shows only apps the provider advertised, and launches those apps through `worker.desktop.launch`. It connects through the Gateway, which forwards the box's loopback VNC over the same pinned SSH transport used for worker traffic — the desktop is never exposed on the box's network, and the VNC password is delivered only inside the authenticated `worker.desktop.observe` RPC result, never stored by the Gateway.

Connections start view-only. Clicking the desktop takes control (an input-capable connection); only one controller is active at a time, and taking control disconnects the previous controller (they are downgraded to view-only). Up to 8 observers can watch one environment. The desktop forward starts on first observe and shuts down about a minute after the last observer disconnects; stopping or reclaiming the environment tears it down immediately.

The Browser launcher starts one visible Chrome or Chromium process on the worker display with raw CDP bound to `127.0.0.1` and a fresh lease-scoped user-data directory. It does not import cookies, attach the Chrome extension relay, or use Chrome MCP. The operator toolbar and cloud-worker agent share this process. A worker turn receives the normal `browser` tool only when the lease advertises Browser, the bundled Browser plugin is active, and normal tool policy allows `browser`; workers without that capability keep the existing coding-tool catalog. Generic desktop `computer` control is not part of this Labs surface.

Desktop observe and app launch are not supported when the Gateway itself runs on Windows.

## Security model

- **Closed worker ingress.** In worker-turn mode, workers speak a dedicated protocol on the tunneled socket with a closed method allowlist — a worker cannot call operator RPCs.
- **Gateway-owned tool authority.** In worker-turn mode, the Gateway projects current profile, provider, agent, group, sender, sandbox, delegation, inherited, and runtime-cap policy over the worker's fixed coding-tool catalog before every turn. The launch envelope carries only that final closed-vocabulary subset. Explicitly capped scheduled turns reuse their trusted owner-group context without sending that identity to the box or reapplying a fresh sender overlay. Tools outside the worker catalog remain unavailable; an empty result runs with no tools.
- **Minted credentials, hashed at rest.** Each dispatch mints a worker credential; the Gateway stores only its hash. Credential rotation and owner-epoch fencing guarantee at most one live owner per session — a stale worker that reconnects is fenced, never merged.
- **Host-key pinning.** The provider must surface the box's SSH host key at provision time; bootstrap connects with strict pinning and fails closed without it.
- **No standing model, forge, or cloud credentials on the box.** OpenClaw worker turns proxy inference by `{provider, model}` reference. Codex remote-exec keeps the app-server plus ChatGPT subscription or API-key auth on the Gateway and sends only sandbox operations to the box. Remote-exec requires prepared auth and rejects ambient auth fallback. Workspace git commits are authored without forge credentials, and Crabbox AWS lease metadata is checked authoritatively for an instance role before setup. Keep setup commands credential-free too.
- **Provider-owned egress.** The reverse tunnel removes any OpenClaw need for direct model access, but OpenClaw does not rewrite provider firewalls. Restrict outbound traffic in the worker provider when the task requires it.
- **Durable, exactly-once worker transcripts.** In worker-turn mode, the worker commits transcript batches through a compare-and-swap protocol against the session's leaf; a stale base fail-stops the run instead of duplicating or rebasing paid output. Remote-exec writes through the Gateway's normal local harness path.

## Troubleshooting

- **No cloud profile is advertised** — run `openclaw gateway call environments.list --params '{}'` as an admin. If the response has no `profiles`, validate `cloudWorkers.profiles`, inspect the provider plugin, and restart the Gateway. This is a configuration or provider-activation problem, not an authorization result.
- **Cloud destinations are hidden or an RPC is denied** — the connected operator lacks `operator.admin`. Reconnect with admin scope; configuring a profile does not grant that scope.
- **The selected runtime lacks cloud placement support** — choose a model whose advertised runtime supports cloud placement. The bundled OpenClaw and Codex runtimes are supported; undeclared runtimes remain local-only.
- **"Worker bootstrap requires Node.js on the leased host"** — add a Node install to `settings.setup` (see above).
- **AWS instance-role attestation fails** — clear `aws.instanceProfile` (and `CRABBOX_AWS_INSTANCE_PROFILE`, if set). Install Crabbox 0.41.1 or newer; older binaries do not satisfy the fixed-ID and authoritative `providerMetadata.instanceProfileAttached` contracts required for AWS admission.
- **Dispatch or workspace recovery fails** — inspect `environments.list` and `sessions.describe`. A failed environment exposes its bounded environment error. A failed placement exposes `recoveryError` plus its durable per-session `terminalReason`; the selected Control UI chat shows that terminal reason above the composer. When deeper diagnosis is necessary, an operator on the Gateway host can inspect the durable worker state read-only. Do not edit the state database to bypass lifecycle fencing.
- **No SSH candidate is reachable** — compare the Gateway host's current outbound IPv4 with an explicitly configured `aws.sshCIDRs` policy in `crabbox config show --json`. If the matching `/32` is absent, correct Crabbox's configuration and rerun `crabbox doctor --provider aws --json` before retrying. An empty configured list is valid because Crabbox normally discovers and injects the caller's `/32` when requesting the lease; if reachability still fails, pin the `/32` explicitly. Then ensure the Gateway's outbound route and the worker ingress policy permit at least one advertised candidate. OpenClaw rotates the ordered ports with the same identity and pinned host key only for idempotent probes, content-addressed transfers, receipt/lock-guarded artifact installation, convergent managed-worktree mirroring, and tunnel reconnects. Ambiguous unguarded stateful commands fail closed and are not replayed on the next port.
- **Client timeout while dispatching** — `openclaw gateway call` defaults to a 10s timeout; pass `--timeout` generously. Dispatch keeps running server-side either way, and an identical retry on the same Gateway joins that in-flight operation instead of provisioning another worker. A retry with a different profile or session identity is rejected.
- **Direct AWS authorization fails after `doctor` passes** — `doctor` proves read-only AWS access, not the complete mutation policy. Inspect the named denied action and grant only Crabbox's required provisioning/cleanup actions, or configure coordinator-backed Crabbox instead. A fresh direct AWS lease normally needs key-pair import before `RunInstances`; an authorization failure there creates no instance.
- **Worker reclaimed after upgrading from a 2026.7.2 beta** — those betas used the older worker launch contract. On restart, OpenClaw destroys an idle incompatible worker, keeps the session and workspace, marks the placement reclaimed, and provisions a current worker on the next dispatch or turn. A beta worker interrupted while still starting is marked failed after cleanup; retry the dispatch to provision it with the current contract.
- **Cloud workspace conflict notice** — the turn completed and kept the local version of each listed path. Use the staged-ref commands in the notice to inspect or take the cloud version; no retry is required for the non-conflicting changes, which are already applied.
- **Cloud session disk-space warning** — delete unneeded files from the remote workspace or stop the cloud worker before large writes. The warning clears automatically after the next successful sample shows enough free space; a failed sample leaves the last successful warning visible and does not affect the session lifecycle.
- **“The previous cloud turn's workspace result is still reconciling”** — the Gateway waited briefly for the prior result's durable fence and could not acquire the session claim. Wait for reconciliation to finish, then retry the turn; restarting the Gateway is safe because recovery preserves staged results before reclaiming a dead worker.
- **Lease housekeeping** — `crabbox list --provider <backend> --json` is a read-only inventory. `crabbox stop --provider <backend> --id <lease>` and `crabbox release --provider <backend> --id <lease>` are destructive and release a lease manually. OpenClaw keeps the lease alive while its session is placed, then stops heartbeating during teardown so genuinely idle leases expire on the profile's `idleTimeout`. Crabbox 0.43.0 and older do not expose the heartbeat command; OpenClaw warns once per environment and cannot prevent coordinator-idle reaping on those binaries.

## Related

- [Sandboxing](/gateway/sandboxing) — reducing blast radius for local tool execution
- [Sessions CLI](/cli/sessions) — inspecting stored sessions
- [Configuration reference](/gateway/configuration-reference)
