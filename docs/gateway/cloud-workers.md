---
summary: "Dispatch sessions to throwaway cloud machines: provisioning, worker runtime, proxied inference, and streaming results"
title: "Cloud Workers"
sidebarTitle: "Cloud Workers"
read_when: "You want agent sessions to run on ephemeral cloud machines instead of the Gateway host, or you are configuring cloudWorkers profiles."
status: active
---

Cloud workers let a session run its agent loop on a throwaway cloud machine while everything about the session stays where it always was: visible in the sidebar, streaming live, with the transcript owned by the Gateway. The Gateway leases a box, installs a pinned copy of OpenClaw on it, syncs the session's workspace over, and hands the turn loop to a restricted `openclaw worker` process. Model calls are proxied back through the Gateway, so provider credentials never leave your machine, and prompt caching keeps working because the provider sees one continuous stream.

When the work is done (or the box dies), the machine is discarded. The durable state — transcript, workspace commits, placement records — lives with the Gateway.

<Note>
Cloud workers are opt-in and invisible until you configure a profile. Unconfigured installs see no new RPCs, config, or UI.
</Note>

## What runs where

| Concern                                                 | Location                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Agent loop + tools (`exec`, `read`, `write`, `edit`, …) | Cloud worker box                                                                 |
| Model inference and provider credentials                | Gateway (proxied by `{provider, model}` reference)                               |
| Transcript (durable, session store)                     | Gateway                                                                          |
| Live streaming into the sidebar                         | Gateway fanout, fed by the worker's replayable event stream                      |
| Workspace git history                                   | Authored on the box credential-free; the Gateway adopts commits and owns push/PR |

The box needs no inbound ports except `sshd`: the Gateway connects out via pinned SSH, and a reverse tunnel carries the worker's WebSocket back. The bundled Crabbox provider forces the public SSH route and disables managed Tailscale enrollment. Outbound internet access is provider policy; the default AWS profile can reach the internet unless you restrict its network or security group.

## Requirements

- A worker provider plugin. The bundled `crabbox` plugin drives the [Crabbox](https://github.com/openclaw/crabbox) CLI, which brokers leases across cloud backends (AWS, Hetzner, and others). The `crabbox` binary must be on `PATH` (or set `settings.binary`) with provider credentials already configured. AWS admission requires Crabbox 0.38.1 or newer.
- For Crabbox AWS workers, the effective `aws.instanceProfile` must be empty. The provider checks `crabbox config show --json` before allocation, then requires `crabbox inspect --json` to report `providerMetadata.instanceProfileAttached: false` from EC2 `DescribeInstances`. Leases with an instance role or without authoritative metadata are stopped and rejected.
- Node.js on the leased machine. Bare cloud images usually lack it — install it in the profile's `setup` command.
- A session with a session-owned managed worktree (create one with `worktree: true`). Dispatch moves that worktree's contents; plain directories sync as a manifest mirror.

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

| Key        | Meaning                                                                                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` | Worker provider id registered by a plugin (`crabbox` for the bundled plugin).                                                                                                                                                                  |
| `install`  | `bundle` (default) ships the running Gateway's build; `npm` installs the exact released Gateway version with pinned integrity. `npm` requires the Gateway to run from a packaged release.                                                      |
| `settings` | Provider-owned JSON. For crabbox: `provider` (backend), `class` (machine class), `ttl`, `idleTimeout` (Go durations), optional `setup` and absolute `binary` path. OpenClaw forces public SSH and disables managed Tailscale for these leases. |
| `lifetime` | Optional stored policy (`idleTimeoutMinutes`, `maxLifetimeMinutes`).                                                                                                                                                                           |

### The setup command

`settings.setup` runs on the leased box after it is SSH-ready and before OpenClaw is installed. It runs on **every** provision attempt (including replays after an interrupted dispatch), so it must be idempotent — guard installs with a `command -v`/`test -x` check as in the example. If setup fails, the provider stops the lease and the dispatch fails closed; no half-configured box is left running.

### Install channels

- **`bundle`** packs the running Gateway's `dist`, a pruned `package.json`, and any workspace packages the build references, all covered by a content hash. The box verifies the pristine bundle against that hash, then installs production npm dependencies (scripts disabled). This is how you run a dev build on a worker.
- **`npm`** proves the release exists on the public registry, pins its SHA-512 integrity, and installs `openclaw@<version>` matching the Gateway exactly.

## Dispatching a session

In the Control UI, open **New Session**, choose an agent whose configured runtime is OpenClaw, select a configured **Cloud · profile** target from the **Where** menu, and start the task. Cloud selection enables the required managed worktree automatically; the Gateway creates the session, finishes dispatch, and only then sends the first turn. The server badge in the session sidebar shows the durable placement state. Cloud targets are not offered for external CLI session catalogs.

The equivalent RPC flow is:

Create a session with a managed worktree, then dispatch it (the RPC requires `operator.admin` and only exists when profiles are configured):

Cloud workers run the OpenClaw agent runtime. Choose an `openai/*` or other model that resolves to that runtime; sessions configured for an external CLI runtime such as `claude-cli` cannot dispatch.

```bash
openclaw gateway call sessions.create \
  --params '{"key":"agent:main:big-refactor","worktree":true,"cwd":"/path/to/repo","worktreeName":"big-refactor"}'

openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","profileId":"aws"}'
```

`sessions.dispatch` closes local turn admission, drains active work, provisions the lease, runs setup, bootstraps OpenClaw, syncs the workspace, and returns once the placement reaches `active` worker ownership. Budget several minutes for the first dispatch; leases and installs are cached where the provider supports it. After that, talk to the session as usual — turns route to the worker automatically.

Completed worker turns reconcile eligible, size-bounded workspace files back into the session's managed worktree before the turn claim is released. The terminal worker event creates a durable pending-result fence before it is acknowledged. The Gateway then stages the complete cloud result as a Git ref under `refs/openclaw/worker-results/` before applying it, so the cloud version remains recoverable even if the Gateway stops during the apply. Workspace results use Git file semantics: regular files, executable bits, symlinks, additions, changes, and deletions are retained, while empty directories and other directory modes are not. The resulting file changes remain in the managed worktree for normal review and commit.

Apply uses the dispatch-time manifest as the merge base. Cloud-only changes are applied, local-only changes stay in place, and paths changed on both sides use a three-way keep-local policy. A conflicted turn still finishes: the transcript reports the bounded path summary and staged result ref, the placement exposes the same conflict for the Control UI, and non-conflicting cloud changes remain applied. The notice includes `git show <ref>:<path>` to inspect a present cloud file and a top-level literal-pathspec `git checkout <ref> -- <path>` command to take it from any workspace directory. Run the commands in Bash or zsh (Git Bash on Windows). If inspect says the path does not exist, the cloud result deleted it; verify and remove the retained local path manually. If checkout reports a file/directory obstruction, move or remove the blocking local path and retry. If the staged ref itself is gone, treat the notice as stale and do not change the local path. Conflicted staged refs remain available after the normal turn fence is released; a later clean result clears the notice and retires the old ref, while explicit fence removal is the final cleanup boundary.

While a fenced result is still reconciling, a new turn waits up to 15 seconds for the prior claim to release. If it is still busy, the turn fails with an actionable “previous cloud turn's workspace result is still reconciling” message and can be retried shortly. On restart, recovery discovers pending and staged results before stale-claim cleanup, completes or retries their local apply, and reclaims dead environments only after preserving the result. The bounded SQLite rollback journal makes an interrupted filesystem apply recoverable without replaying already accepted mutations.

When the work is complete and no turn is running, open the session menu and choose **Stop cloud worker…**. The Gateway performs one final workspace reconciliation before it destroys the environment. A placement already in `draining` or `reconciling` is finishing teardown; wait for its badge to become `reclaimed` before deleting the session.

For a broken or runaway attached worker, an operator can call `environments.destroy` with `{ "force": true }` as a last resort. Forced teardown durably marks the placement failed and abandons any unreconciled remote result before destroying the environment.

The equivalent administrative RPC is:

```bash
openclaw gateway call sessions.reclaim \
  --timeout 600000 \
  --params '{"key":"agent:main:big-refactor"}'
```

Placement moves through a durable state machine (`local → requested → provisioning → syncing → starting → active`), so a Gateway restart mid-dispatch reconciles instead of leaking machines. A failed model turn keeps the active placement available for a retry. Workspace path conflicts keep the local version, apply the rest of the cloud result, and preserve the staged cloud ref for inspection; other reconciliation or lifecycle failures retain their durable recovery fence and diagnostic tail until recovery can safely retry or reclaim the environment.

## Security model

- **Closed worker ingress.** Workers speak a dedicated protocol on the tunneled socket with a closed method allowlist — a worker cannot call operator RPCs.
- **Gateway-owned tool authority.** Before every turn, the Gateway projects current profile, provider, agent, group, sender, sandbox, delegation, inherited, and runtime-cap policy over the worker's fixed coding-tool catalog. The launch envelope carries only that final closed-vocabulary subset. Explicitly capped scheduled turns reuse their trusted owner-group context without sending that identity to the box or reapplying a fresh sender overlay. Tools outside the worker catalog remain unavailable; an empty result runs with no tools.
- **Minted credentials, hashed at rest.** Each dispatch mints a worker credential; the Gateway stores only its hash. Credential rotation and owner-epoch fencing guarantee at most one live owner per session — a stale worker that reconnects is fenced, never merged.
- **Host-key pinning.** The provider must surface the box's SSH host key at provision time; bootstrap connects with strict pinning and fails closed without it.
- **No standing model, forge, or cloud credentials on the box.** Model auth stays on the Gateway (inference travels by `{provider, model}` reference), workspace git commits are authored without forge credentials, and Crabbox AWS lease metadata is checked authoritatively for an instance role before setup. Keep setup commands credential-free too.
- **Provider-owned egress.** The reverse tunnel removes any OpenClaw need for direct model access, but OpenClaw does not rewrite provider firewalls. Restrict outbound traffic in the worker provider when the task requires it.
- **Durable, exactly-once transcripts.** The worker commits transcript batches through a compare-and-swap protocol against the session's leaf; a stale base fail-stops the run instead of duplicating or rebasing paid output.

## Troubleshooting

- **`sessions.dispatch` is an unknown method** — no `cloudWorkers.profiles` are configured, or the caller lacks `operator.admin`.
- **"Cloud worker turns require the OpenClaw runtime"** — choose a model whose configured runtime is OpenClaw. External CLI runtimes such as `claude-cli` do not support worker inference.
- **"Worker bootstrap requires Node.js on the leased host"** — add a Node install to `settings.setup` (see above).
- **AWS instance-role attestation fails** — clear `aws.instanceProfile` (and `CRABBOX_AWS_INSTANCE_PROFILE`, if set). Install Crabbox 0.38.1 or newer; older binaries do not expose the authoritative `providerMetadata.instanceProfileAttached` contract required for AWS admission.
- **Dispatch fails with a provider error** — the placement record and `environments.list` keep the last error, including the setup/bootstrap stderr tail. Boxes are destroyed on failure, so that tail is the primary forensic.
- **Client timeout while dispatching** — `openclaw gateway call` defaults to a 10s timeout; pass `--timeout` generously (dispatch keeps running server-side either way, and a retry while provisioning is rejected with `session cannot dispatch from placement provisioning`).
- **Worker reclaimed after upgrading from a 2026.7.2 beta** — those betas used the older worker launch contract. On restart, OpenClaw destroys an idle incompatible worker, keeps the session and workspace, marks the placement reclaimed, and provisions a current worker on the next dispatch or turn. A beta worker interrupted while still starting is marked failed after cleanup; retry the dispatch to provision it with the current contract.
- **Cloud workspace conflict notice** — the turn completed and kept the local version of each listed path. Use the staged-ref commands in the notice to inspect or take the cloud version; no retry is required for the non-conflicting changes, which are already applied.
- **“The previous cloud turn's workspace result is still reconciling”** — the Gateway waited briefly for the prior result's durable fence and could not acquire the session claim. Wait for reconciliation to finish, then retry the turn; restarting the Gateway is safe because recovery preserves staged results before reclaiming a dead worker.
- **Lease housekeeping** — `crabbox list --provider <backend>` shows live leases; `crabbox stop --provider <backend> --id <lease>` releases one manually. Idle leases expire on the profile's `idleTimeout`.

## Related

- [Sandboxing](/gateway/sandboxing) — reducing blast radius for local tool execution
- [Sessions CLI](/cli/sessions) — inspecting stored sessions
- [Configuration reference](/gateway/configuration-reference)
