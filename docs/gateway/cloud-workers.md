---
summary: "Dispatch session work to throwaway cloud machines with OpenClaw worker turns or Codex remote execution"
title: "Cloud Workers"
sidebarTitle: "Cloud Workers"
read_when: "You want agent session work to run on ephemeral cloud machines, or you are configuring cloudWorkers profiles."
status: active
doc-schema-version: 1
---

Cloud workers move a session's coding work onto a throwaway cloud machine while the session stays visible in the sidebar and its transcript remains owned by the Gateway. The bundled Crabbox provider boots the box, runs profile setup, and starts `openclaw connect --ephemeral`. In OpenClaw `worker-turn` mode, the enrolled node receives the Gateway's pinned worker bundle and hosts a restricted `openclaw worker` child. Eligible paired devices can instead carry Codex `remote-exec` without launching an OpenClaw worker child.

Enrollment is environment-owned and replay-safe. The Gateway persists one setup identity before provider allocation, binds the first authenticated device identity to that exact environment, and reuses the durable device token when provisioning resumes. Initial enrollment and replay both enable worker hosting only for that node process; they do not change durable worker-host configuration. Reclaim or destroy releases the cloud lease and removes the environment-owned node pairing.

When the work is done (or the box dies), the machine is discarded. The durable state — transcript, last-reconciled workspace files, and placement records — lives with the Gateway.

<Note>
Cloud workers are opt-in. Until you configure a profile, clients hide the Cloud destination and profile dispatch is unavailable. `sessions.dispatch` may still be advertised for eligible paired-device targets. The `cloudWorkers` config schema and the read-only `environments.list` and `environments.status` methods remain available for configuration and environment discovery.
</Note>

## What runs where

| Concern                            | OpenClaw `worker-turn` mode                          | Codex `remote-exec` mode                                |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Agent runtime and turn loop        | Cloud box (`openclaw worker`)                        | Gateway (Codex app-server)                              |
| Command, filesystem, and HTTP work | Cloud box                                            | Paired device or SSH-backed provider sandbox            |
| Model inference and provider auth  | Gateway, proxied by `{provider, model}` reference    | Gateway, including ChatGPT subscription or API-key auth |
| Transcript and live session state  | Gateway, fed by the worker's replayable event stream | Gateway through the normal local harness path           |
| Workspace file state               | Changed on the box; reconciled by the Gateway        | Changed remotely; reconciled by the Gateway             |

The bundled Crabbox cloud provider supports `worker-turn` through the node transport. Codex `remote-exec` supports an explicitly authorized paired device through that device's authenticated duplex node channel, or a cloud provider that explicitly advertises an SSH-backed execution carrier. A Crabbox cloud profile still does not advertise Codex `remote-exec`.

After Crabbox setup, the cloud node dials the Gateway's public TLS endpoint over outbound WebSocket. Worker control and workspace transfer use the authenticated node and worker channels, not a Gateway-created reverse tunnel or rsync. Crabbox itself may still require SSH reachability while its CLI runs the provider-owned setup command. Outbound internet access is provider policy; the default AWS profile can reach the internet unless you restrict its network or security group.

For a loopback Gateway behind public HTTPS ingress, set `gateway.publicOrigin` to the proxy's bare origin. Node enrollment uses it as the default external pairing endpoint; `plugins.entries.device-pair.config.publicUrl` remains the pairing-specific override. If either URL is behind a reverse proxy, including cloudflared, nginx, or externally managed Tailscale Serve, `gateway.trustedProxies` must include the proxy's source address (typically loopback for a same-host proxy). Otherwise, forwarded client headers cause node enrollment to fail with `proxy_attribution_required`.

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

Crabbox setup transport originates from the Gateway host, while the coordinator API may see a reverse-proxy or request-source address. Explicit pinning is useful when outbound detection is unavailable or a fixed policy is required.

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

Manage profiles in the Control UI under **Settings → Connections → Cloud workers**, or edit `cloudWorkers.profiles` directly in `openclaw.json` — both write the same config keys. The settings page lists each profile's backend, class, lifetime, and idle-stop in plain language, and shows whether it is advertised to `environments.list` or waiting on a Gateway restart. With no profiles configured it explains the feature, links back to this page, and starts the add flow.

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

| Key        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` | Worker provider id registered by a plugin (`crabbox` for the bundled plugin).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `install`  | Installation preference for SSH-backed providers. The bundled Crabbox provider always installs the current Gateway bundle through the authenticated node channel.                                                                                                                                                                                                                                                                                                                 |
| `settings` | Provider-owned JSON. For crabbox: `provider` (backend), `class` (machine class), `ttl`, `idleTimeout` (Go durations), optional idempotent `setup`, optional `desktop`, and absolute `binary` path. While a session remains placed, OpenClaw heartbeats its lease at a safe fraction of `idleTimeout`; teardown stops the heartbeat before releasing the machine. `desktop: true` asks Crabbox to warm the lease with its browser and loopback RFB desktop before node enrollment. |

### Per-project default profiles

Use `cloudWorkers.projectProfiles` to select a default profile from a managed session worktree's `origin` remote. Keys use the normalized lowercase repository identity `host/owner/repo`, without a trailing `.git`:

```json5 validate=false
{
  cloudWorkers: {
    projectProfiles: {
      "github.com/acme/app": "aws",
    },
  },
}
```

An explicit `profileId` or `deviceId` in `sessions.dispatch` always wins. A target-less project-profile lookup requires `operator.admin`. If a configured mapping names a profile that is not present in `cloudWorkers.profiles`, dispatch fails closed and names both the repository key and missing profile. A worktree with no `origin` or no matching mapping returns a typed `INVALID_REQUEST` without provisioning or falling back to another target.

The enrolled node stores its identity, durable device token, endpoint, worker bundles, and workspaces under an isolated per-lease state directory on the disposable box. Provision replay first adopts the fixed Crabbox lease, then either resumes that node state or reuses the still-pending setup credential. It never mints a second environment identity for the same operation.

OpenClaw derives one canonical `cbx_...` lease ID from the durable provision operation and passes it to `crabbox warmup --lease-id`; the deterministic slug is display metadata only. If warmup commits but its response is lost, Gateway reconciliation repeats the same fixed-ID operation and Crabbox returns or adopts only the exactly attested lease. Intent drift, terminal ID reuse, and ambiguous unverified resources fail closed without allocating a replacement. A legacy dispatch interrupted before OpenClaw recorded a lease ID cannot be identified safely and fails visibly instead of falling back to slug adoption.

### The setup command

`settings.setup` runs on the leased box after Crabbox reports it ready and before ephemeral node enrollment. It runs on **every** provision attempt, including replay after an interrupted dispatch, so it must be idempotent — guard installs with a `command -v`/`test -x` check as in the example. At minimum, the resulting machine needs Node.js and `npx`. If setup or enrollment fails, the provider stops the lease and the dispatch fails closed; no half-configured paid box is hidden behind terminal state.

### Bundle installation

The setup bootstrap first reuses an installed `openclaw` binary when its version exactly matches the Gateway, then tries the exact `openclaw@<version>` registry package. For an unreleased source build, install a locally packed candidate with the same version in `settings.setup`; the provider will select it before touching the registry. After the node connects and publishes its session-host inventory, the Gateway pushes one content-addressed worker bundle through the paired channel. The node verifies and publishes those exact bytes without installing the normal OpenClaw package dependency tree. A stale Gateway build retires the environment and reprovisions against the current bundle rather than downgrading the execution-context protocol.

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

Administrators can run an authorized managed-worktree session on a configured cloud profile. Session ownership and participation checks are revalidated before placement lifecycle changes commit.

In the Control UI, open **New Session** and use the unified **Place** picker to choose both the working folder and a **Cloud · profile** destination. A cloud destination appears only when all four eligibility gates pass:

1. The connected operator has `operator.admin` scope.
2. `environments.list` advertises at least one configured profile.
3. The selected Gateway folder is a Git checkout that can use a managed worktree.
4. The selected agent runtime advertises cloud placement support.

Cloud selection enables that worktree automatically. The Gateway creates the session, finishes dispatch, and only then sends the first turn. The server badge in the session sidebar shows the durable placement state.

While a placement is active, OpenClaw automatically samples available space on the remote workspace volume. Low-space warnings appear in the selected chat and on the session's cloud badge. They are advisory, clear automatically after space recovers, and do not stop or reclaim the worker.

### Runtime support

- **OpenClaw** uses `worker-turn` placement. The restricted `openclaw worker` process runs each turn on the leased node and proxies inference through the Gateway.
- **Codex** uses `remote-exec` placement on an eligible paired device, or with a cloud provider that advertises an SSH-backed execution carrier. The bundled Crabbox cloud profile supports only `worker-turn`, so selecting that profile for Codex still fails before allocation.

The Control UI disables cloud destinations whose advertised mode does not match
the selected runtime, including when moving an existing session. An
incompatible move is rejected before the active source starts draining or
changes its durable placement.

Other runtimes remain unavailable unless their harness explicitly declares a cloud placement mode. Cloud targets are not offered for external CLI session catalogs. Remote-exec fails closed if the selected provider or placement sandbox is unavailable; it never falls back to running the operation on the Gateway host.

### Codex on a paired device

Paired-device Codex placement requires the `codex` plugin to be installed and
enabled in both the Gateway's configuration and the node's own local
configuration. Include `codex` in `plugins.allow` on either machine when that
machine uses a plugin allowlist. It also requires a connected session-capable
node that advertises `codex.exec-server`, and an explicit
`gateway.nodes.commands.allow` entry for `codex.exec-server.stdio.v1`. Approve
the node's updated pairing surface if needed. Before each exec-server launch,
OpenClaw also requires the normal node invocation approval; denying that
request does not start a process.

Codex launches its exec-server directly, so paired-device placement does not
consume an OpenClaw worker slot and remains eligible when those slots are full.
OpenClaw `worker-turn` placement still requires an available worker slot.

Approval permits process execution and filesystem access anywhere the node's
operating system account allows. The exact placement workspace controls the
starting directory and reconciled changes, not OS-level confinement. Trust the
paired device, and use a separate least-privilege OS account when isolation is
required.

Choose the device in the Control UI **Place** picker or dispatch a
managed-worktree session with an authorized operator connection:

```bash
openclaw gateway call sessions.dispatch \
  --params '{"key":"agent:main:device-work","deviceId":"<paired-device-id>"}'
```

The Codex app-server, model connection, provider credentials, and transcript
remain on the Gateway. The paired node runs the managed Codex exec-server in
the transferred workspace and receives only sanitized process, filesystem,
capability-discovery, and HTTP operations over the existing node channel. It
does not launch an OpenClaw worker child. Credential-bearing HTTP requests are
rejected before they reach the paired device; run authenticated requests on the
Gateway or use an intentionally credential-free endpoint. Normal Codex turns
are supported, but `/btw` side questions are not yet placement-bound and fail
visibly. Completed changes return through the same placement workspace
reconciliation as worker turns. See
[Run Codex on a paired device](/plugins/codex-harness#run-codex-on-a-paired-device)
for the exact allowlist configuration and lifecycle.

For cloud-profile placement, the equivalent RPC flow is:

Create a session with a managed worktree, then dispatch it. Profile dispatch requires `operator.admin` and is available only while at least one worker profile is configured:

```bash
openclaw gateway call sessions.create \
  --params '{"key":"agent:main:big-refactor","worktree":true,"cwd":"/path/to/repo","worktreeName":"big-refactor"}'

openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","profileId":"aws"}'
```

### Choose a machine class per session

A worker profile's `settings.class` remains its default. In the Control UI, selecting a **Cloud · profile** destination in the Place picker reveals a machine section listing the profile's advertised classes, with reported vCPU and RAM when available and the default marked; picking one updates the place chip (for example `hetzner · Fast`) and carries the choice into dispatch. To choose a different size for one new placement over RPC instead, pass `machineClass` with `profileId`:

```bash
openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","profileId":"aws","machineClass":"large"}'
```

The bundled Crabbox provider advertises whatever machine classes the configured Crabbox binary reports for the selected backend, preserving Crabbox's size order. For example, a catalog containing `tiny`, `small`, `standard`, `fast`, `large`, and `beast` produces those six picker rows in that order; if Crabbox reports `standard` as 32 vCPU · 64 GB, that shape appears beside the class. Older binaries that publish no matching class catalog retain the label-only `standard`, `fast`, `large`, and `beast` fallback. You can also pass a provider-native server or instance type such as `c7a.24xlarge`; Crabbox treats any other non-empty class as that exact type. The selected value is fixed for that placement and reused by safe provisioning retries. `machineClass` is valid only with `profileId`, not `deviceId`.

`sessions.dispatch` closes local turn admission, drains active work, validates the eligible Git workspace inventory, provisions the lease, runs setup, enrolls the node, pushes the Gateway bundle when worker hosting requires it, syncs the workspace, and returns once the placement reaches `active` ownership. Inventory validation happens before provider allocation and reports an invalid request with an actionable size or entry limit when the workspace cannot be dispatched. Budget several minutes for the first cloud dispatch; leases and content-addressed bundles are reused where safe. After that, talk to the session as usual. OpenClaw turns route to the worker process; Codex native operations run on the authorized paired device or supported SSH-backed provider.

Completed cloud turns reconcile eligible, size-bounded workspace files back into the session's managed worktree before the turn claim is released. Worker-turn uses its terminal worker event to create the durable pending-result fence. Remote-exec waits for workspace quiescence and enters the same reconciliation flow after the local Codex attempt. Before applying the result, the Gateway stages complete authenticated base/current manifests plus each changed resulting blob as a Git ref under `refs/openclaw/worker-results/`; deletions are represented by the manifests and need no blob. This keeps the cloud delta recoverable even if the Gateway stops during the apply without duplicating unchanged baseline content. Workspace results use Git file semantics: regular files, executable bits, symlinks, additions, changes, and deletions are retained, while empty directories and other directory modes are not. The resulting file changes remain in the managed worktree for normal review and commit.

To publish the finished work, the agent calls `github_publish` as its final action and then completes the turn. The call records only a single-line title, body, and idempotency key. After reconciliation is durably accepted, but before the exact turn claim is released, the Gateway re-resolves the session-owned managed worktree and effective GitHub identity. It uses the title as the commit subject, appends deterministic verified participant trailers, pushes the authoritative branch through an exact HTTPS path, and creates or reuses a draft pull request. The terminal transcript entry contains either the pull request URL or a typed failure with the next action. A restart resumes from the accepted workspace-result fence and remote branch or pull-request evidence; it never gives the recovered worker new forge authority.

Apply uses the dispatch-time manifest as the merge base. Cloud-only changes are applied, local-only changes stay in place, and paths changed on both sides use a three-way keep-local policy. A conflicted turn still finishes: the transcript reports the bounded path summary and staged result ref, the placement exposes the same conflict for the Control UI, and non-conflicting cloud changes remain applied. The notice includes `git show <ref>:<path>` to inspect a present cloud file and a top-level literal-pathspec `git checkout <ref> -- <path>` command to take it from any workspace directory. Run the commands in Bash or zsh (Git Bash on Windows). If inspect says the path does not exist, the cloud result deleted it; verify and remove the retained local path manually. If checkout reports a file/directory obstruction, move or remove the blocking local path and retry. If the staged ref itself is gone, treat the notice as stale and do not change the local path. Conflicted staged refs remain available after the normal turn fence is released; a later clean result clears the notice and retires the old ref, while explicit fence removal is the final cleanup boundary.

While a fenced result is still reconciling, a new turn waits up to 15 seconds for the prior claim to release. If it is still busy, the turn fails with an actionable “previous cloud turn's workspace result is still reconciling” message and can be retried shortly. On restart, recovery discovers pending and staged results before stale-claim cleanup, completes or retries their local apply, and reclaims dead environments only after preserving the result. The bounded SQLite rollback journal makes an interrupted filesystem apply recoverable without replaying already accepted mutations.

To continue the same session somewhere else, open the **Runs on Cloud** chip and choose **Move session…**. An operator with `operator.write` can select the Gateway or an eligible paired device; selecting a configured cloud profile requires `operator.admin`. Profiles may also offer a machine class. Moving to the current profile with a different class resizes the session by replacing its worker. The Gateway closes new admission, interrupts any active turn, reconciles the source workspace, destroys the old environment, and then activates the destination. An interrupted turn is never replayed: partial output may disappear, and you send the next turn again after the move. The exact target, including a machine override, and bounded errors are durable, so the Control UI shows **Moving to…** or the recovery error after a reconnect. If the Gateway restarts before the destination becomes active, request-bound authority is lost: recovery finishes safe source cleanup, marks the placement failed with a retry message, and does not provision the destination. Reconnect, then choose **Move session…** again.

An active paired-device placement stays `active` when its runner disconnects.
Control UI shows **Device offline** and **Waiting for device to reconnect; retry
after it returns**. Waiting is the default and keeps the remote owner and
workspace intact. Any in-flight Codex `remote-exec` attempt fails visibly, its
node exec-server and child processes are terminated, and reconnecting the same
paired device allows a fresh attempt only; the disconnected stdio session is
never resumed. **Continue on Gateway…** is explicitly destructive: after a
data-loss confirmation, it abandons the exact offline device owner and resumes
from the last Gateway-synced workspace without replay. Unsynced device files
and in-flight work may be lost. This explicit abandonment also fences an active
local Codex turn claim without waiting for an acknowledgment from the offline
node. If the device is already available, use the
ordinary reconcile-first move instead.

When the work is complete and no turn is running, choose **Stop cloud worker…** from the same chip. The Gateway performs one final workspace reconciliation before it destroys the environment. A placement already in `draining` or `reconciling` is finishing teardown; wait for its badge to become `reclaimed` before deleting the session.

Archiving a non-main cloud-worker session with an active placement also performs this safe stop and reclaim before the Gateway records it as archived. If the placement is still transitioning or failed without proof that its environment is gone, the session remains unarchived; wait for the placement to settle, then retry. Restoring the session retains the reclaimed placement metadata so the next turn can dispatch a fresh worker with the same workspace profile.

For a broken or runaway cloud environment, an administrator can call the admin-only `environments.destroy` method with `{ "force": true }` as a last resort. Forced teardown durably marks the placement failed and abandons any unreconciled remote result before destroying the environment.

The equivalent write-scoped session RPC is:

```bash
openclaw gateway call sessions.reclaim \
  --timeout 600000 \
  --params '{"key":"agent:main:big-refactor"}'
```

The result placement is `reclaimed` after an active worker is safely stopped. Reclaim also waits for an in-flight dispatch and retries pending teardown for a failed placement before returning `local`. No other placement states are successful reclaim results.

For automation, read the active placement's `generation`, `environmentId`, and `activeOwnerEpoch` from `sessions.describe`, then supply those exact source facts to `sessions.move`:

```bash
openclaw gateway call sessions.move \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","expected":{"generation":5,"environmentId":"worker:source","ownerEpoch":2},"target":{"kind":"gateway"}}'
```

Worker targets use `{"kind":"profile","profileId":"aws","machineClass":"fast"}` or `{"kind":"device","deviceId":"paired-device-id"}`. Omit `machineClass` to use the profile default. Moving to the same profile with a different class is the resize workflow. A stale source is rejected rather than moving a newer placement. Successful results end in `local` for the Gateway target or `active` for a worker target.

Automation may explicitly abandon an offline paired-device source by adding
`"abandonSource":true` to the exact-source Gateway request above. The field is
rejected for profile or device targets and when the source runner is available
or cannot be proven to be the exact device binding. This path has the same
unsynced-file and in-flight-work loss boundary as the Control UI confirmation.

Placement moves through a durable state machine (`local → requested → provisioning → syncing → starting → active`), so a Gateway restart mid-dispatch reconciles instead of leaking machines. A failed model turn keeps the active placement available for a retry. Workspace path conflicts keep the local version, apply the rest of the cloud result, and preserve the staged cloud ref for inspection; other reconciliation or lifecycle failures retain their durable recovery fence and diagnostic tail until recovery can safely retry or reclaim the environment.

## What survives a dead machine

The Gateway owns the canonical session transcript in both modes. Worker-turn commits each complete user, assistant, and tool-result message before the worker's session write settles; remote-exec uses the normal local harness transcript path because the Codex app-server stays on the Gateway. If the machine disappears mid-message, durable history ends at the last committed message. Partial text or tool progress already shown by the live stream may disappear; the failed turn remains visible, and the failed placement records a bounded terminal reason above the composer.

Workspace state has a wider loss window. A completed turn reconciles cloud files before releasing its claim, and **Stop cloud worker…** performs one final reconciliation before destroying the machine. Changes made between reconciliations exist only on the box and can be lost. Session deletion does not synchronize an active placement: it must first be stopped or archived. Deletion then snapshots the already-reconciled managed worktree under `refs/openclaw/snapshots/` before removing it.

After a failed placement, redispatch the session and retry the turn. A reclaimed placement redispatches automatically on the next turn. The next turn rebuilds model context from the Gateway transcript, so it continues from the messages that crossed the durability boundary.

## Desktop (interactive)

Cloud Worker Desktop lets an administrator watch or control a capable worker from the Control UI without exposing its cloud node as an ordinary paired node. Enable the **Cloud Worker Desktop** lab, then set `settings.desktop: true` on a Crabbox profile. Desktop capability is fixed at warm time: changing the setting affects newly provisioned workers, while an existing non-desktop lease must be stopped and reprovisioned.

The bundled Crabbox plugin supports direct AWS profiles. Coordinator-backed AWS and Hetzner profiles are supported when the selected coordinator advertises Desktop and Browser capability. OpenClaw keeps worker execution node-only: `openclaw worker`, workspace transfer, desktop observation, and app launch all use the authenticated outbound node connection. It does not restore SSH execution, a reverse tunnel, or rsync. Direct Hetzner rejects OpenClaw's fixed lease ID, so desktop profiles fail before allocation unless Hetzner uses a capable managed coordinator.

Crabbox provisions XFCE on display `:99`, an authenticated RFB server on `127.0.0.1:5900`, a fresh lease-scoped browser profile with CDP on `127.0.0.1:9222`, and fixed zero-argument Browser and Terminal launchers. The provider also installs an OpenClaw worker wallpaper so the disposable desktop is easy to identify. Setup is idempotent and runs before node enrollment on every provisioning replay.

The desktop never gains public ingress. The node reads `/var/lib/crabbox/vnc.password` locally, probes the authenticated loopback RFB server, and redeems a single-use Gateway broker ticket over the node's already-connected origin. TLS deployments pin the same Gateway certificate used by the node connection. The Gateway revalidates the durable environment, lease, node, owner epoch, desktop descriptor, connection, and pairing both before dispatch and after attach; drain, replacement, or teardown aborts the stream and any pending app launch. The shared desktop session owner performs RFB preauthentication, view-only input filtering, and single-controller arbitration.

## Security model

- **Closed worker ingress.** In worker-turn mode, the enrolled node launches the worker child, which dials the Gateway's authenticated public worker route and speaks a dedicated protocol with a closed method allowlist — a worker cannot call operator RPCs.
- **Gateway-owned tool authority.** In worker-turn mode, the Gateway projects current profile, provider, agent, group, sender, sandbox, delegation, inherited, and runtime-cap policy over the worker's fixed coding-tool catalog before every turn. The launch envelope carries only that final closed-vocabulary subset. Explicitly capped scheduled turns reuse their trusted owner-group context without sending that identity to the box or reapplying a fresh sender overlay. Tools outside the worker catalog remain unavailable; an empty result runs with no tools.
- **Minted credentials, hashed at rest.** Each dispatch mints a worker credential; the Gateway stores only its hash. Credential rotation and owner-epoch fencing guarantee at most one live owner per session — a stale worker that reconnects is fenced, never merged.
- **Environment-bound enrollment.** One short-lived node-only setup credential is bound to the durable environment before allocation. Its first authenticated Ed25519 device identity is recorded atomically with setup completion; replay cannot substitute an unrelated node.
- **Explicit Codex device authorization.** Paired-device remote execution requires an explicitly allowed `codex.exec-server.stdio.v1` command, an approved pairing surface, and normal node invocation approval. The managed exec-server starts with a fresh private home and sanitized environment; allow-once never grants a later launch. Its managed workspace is not an OS sandbox: approved execution can access processes and files allowed to the node account, so use a separate least-privilege account when isolation is required.
- **No standing model, forge, or cloud credentials on the box.** OpenClaw worker turns proxy inference by `{provider, model}` reference. Codex remote-exec keeps the app-server plus ChatGPT subscription or API-key auth on the Gateway and sends only sandbox operations to the box. Remote-exec requires prepared auth and rejects ambient auth fallback. Workspace git commits are authored without forge credentials, and Crabbox AWS lease metadata is checked authoritatively for an instance role before setup. Keep setup commands credential-free too.
- **Gateway-owned GitHub publication.** Publication credentials stay in the effective managed or native GitHub profile on the Gateway. The broker disables repository hooks, refuses configured Git clean filters, uses a temporary index and `git commit-tree`, pushes only a reconstructed public HTTPS URL with a command-local `gh auth git-credential` helper, and never writes a bearer token to argv, a remote URL, `.git/config`, a worker payload, or a transcript.
- **Provider-owned egress.** Gateway-proxied inference removes any OpenClaw need for direct model access, but OpenClaw does not rewrite provider firewalls. Restrict outbound traffic in the worker provider when the task requires it.
- **Durable, exactly-once worker transcripts.** In worker-turn mode, the worker commits transcript batches through a compare-and-swap protocol against the session's leaf; a stale base fail-stops the run instead of duplicating or rebasing paid output. Remote-exec writes through the Gateway's normal local harness path.

## Troubleshooting

- **No cloud profile is advertised** — run the `operator.read`-scoped `openclaw gateway call environments.list --params '{}'`. If the response has no `profiles`, ask an administrator to validate `cloudWorkers.profiles`, inspect the provider plugin, and restart the Gateway. This is a configuration or provider-activation problem, not an authorization result.
- **Cloud destinations are hidden or an RPC is denied** — cloud profile dispatch and profile-target moves require `operator.admin`. `operator.write` can dispatch or move to an eligible paired device, move to the Gateway, and reclaim a placement; `operator.read` alone can discover profiles but cannot start, stop, or move a session. Profile configuration, infrastructure pairing, Connect machine, raw environment lifecycle, direct `execNode` execution, incognito sessions, and arbitrary host or node paths remain `operator.admin`.
- **The selected runtime lacks cloud placement support** — choose a model whose advertised runtime supports cloud placement. The bundled OpenClaw and Codex runtimes are supported; undeclared runtimes remain local-only.
- **"Worker bootstrap requires Node.js on the leased host"** — add a Node install to `settings.setup` (see above).
- **AWS instance-role attestation fails** — clear `aws.instanceProfile` (and `CRABBOX_AWS_INSTANCE_PROFILE`, if set). Install Crabbox 0.41.1 or newer; older binaries do not satisfy the fixed-ID and authoritative `providerMetadata.instanceProfileAttached` contracts required for AWS admission.
- **Dispatch or workspace recovery fails** — inspect `environments.list` and `sessions.describe`. A failed environment exposes its bounded environment error. A failed placement exposes `recoveryError` plus its durable per-session `terminalReason`; the selected Control UI chat shows that terminal reason above the composer. When deeper diagnosis is necessary, an operator on the Gateway host can inspect the durable worker state read-only. Do not edit the state database to bypass lifecycle fencing.
- **Crabbox setup cannot reach the lease** — compare the Gateway host's current outbound IPv4 with an explicitly configured `aws.sshCIDRs` policy in `crabbox config show --json`. If the matching `/32` is absent, correct Crabbox's configuration and rerun `crabbox doctor --provider aws --json` before retrying. An empty configured list is valid when Crabbox discovers and injects the caller's `/32` for the request.
- **Node enrollment times out** — inspect the package selection, node process state, and bounded node-log tail included in the enrollment error. Verify that profile setup installed Node.js and `npx` and that the box can reach the Gateway's advertised TLS URL and public worker/node WebSocket route. If the error contains `proxy_attribution_required`, add the reverse proxy's source address to `gateway.trustedProxies`.
- **Client timeout while dispatching** — `openclaw gateway call` defaults to a 10s timeout; pass `--timeout` generously. Dispatch keeps running server-side either way, and an identical retry on the same Gateway joins that in-flight operation instead of provisioning another worker. A retry with a different profile or session identity is rejected.
- **Direct AWS authorization fails after `doctor` passes** — `doctor` proves read-only AWS access, not the complete mutation policy. Inspect the named denied action and grant only Crabbox's required provisioning/cleanup actions, or configure coordinator-backed Crabbox instead. A fresh direct AWS lease normally needs key-pair import before `RunInstances`; an authorization failure there creates no instance.
- **Worker reclaimed after upgrading from a 2026.7.2 beta** — those betas used the older worker launch contract. On restart, OpenClaw destroys an idle incompatible worker, keeps the session and workspace, marks the placement reclaimed, and provisions a current worker on the next dispatch or turn. A beta worker interrupted while still starting is marked failed after cleanup; retry the dispatch to provision it with the current contract.
- **Cloud workspace conflict notice** — the turn completed and kept the local version of each listed path. Use the staged-ref commands in the notice to inspect or take the cloud version; no retry is required for the non-conflicting changes, which are already applied.
- **Cloud session disk-space warning** — delete unneeded files from the remote workspace or stop the cloud worker before large writes. The warning clears automatically after the next successful sample shows enough free space; a failed sample leaves the last successful warning visible and does not affect the session lifecycle.
- **“The previous cloud turn's workspace result is still reconciling”** — the Gateway waited briefly for the prior result's durable fence and could not acquire the session claim. Wait for reconciliation to finish, then retry the turn; restarting the Gateway is safe because recovery preserves staged results before reclaiming a dead worker.
- **GitHub publication failed** — open **Agents → Tools → GitHub Identity** and confirm the effective `@login`, selected scope, access expiry, and refresh state. Reconnect GitHub when refresh is expired or unavailable; use a managed PAT only as the explicit fallback. For push rejection, inspect repository write access and branch drift; `/user` verification does not prove repository write access and the broker never force-pushes. For pull request rejection, grant pull-request write access and call `github_publish` again with a new tool call.
- **Lease housekeeping** — `crabbox list --provider <backend> --json` is a read-only inventory. `crabbox stop --provider <backend> --id <lease>` and `crabbox release --provider <backend> --id <lease>` are destructive and release a lease manually. OpenClaw keeps the lease alive while its session is placed, then stops heartbeating during teardown so genuinely idle leases expire on the profile's `idleTimeout`. Crabbox 0.43.0 and older do not expose the heartbeat command; OpenClaw warns once per environment and cannot prevent coordinator-idle reaping on those binaries.

## Related

- [Sandboxing](/gateway/sandboxing) — reducing blast radius for local tool execution
- [Sessions CLI](/cli/sessions) — inspecting stored sessions
- [Configuration reference](/gateway/configuration-reference)
