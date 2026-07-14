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

The box needs no inbound ports except `sshd` and no egress beyond what your setup command uses: the Gateway connects out via SSH and a reverse tunnel carries the worker's WebSocket back. No Tailscale or VPN required.

## Requirements

- A worker provider plugin. The bundled `crabbox` plugin drives the [Crabbox](https://github.com/openclaw/crabbox) CLI, which brokers leases across cloud backends (AWS, Hetzner, and others). The `crabbox` binary must be on `PATH` (or set `settings.binary`) with provider credentials already configured.
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

| Key        | Meaning                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` | Worker provider id registered by a plugin (`crabbox` for the bundled plugin).                                                                                                             |
| `install`  | `bundle` (default) ships the running Gateway's build; `npm` installs the exact released Gateway version with pinned integrity. `npm` requires the Gateway to run from a packaged release. |
| `settings` | Provider-owned JSON. For crabbox: `provider` (backend), `class` (machine class), `ttl`, `idleTimeout` (Go durations), optional `setup` and absolute `binary` path.                        |
| `lifetime` | Optional stored policy (`idleTimeoutMinutes`, `maxLifetimeMinutes`).                                                                                                                      |

### The setup command

`settings.setup` runs on the leased box after it is SSH-ready and before OpenClaw is installed. It runs on **every** provision attempt (including replays after an interrupted dispatch), so it must be idempotent — guard installs with a `command -v`/`test -x` check as in the example. If setup fails, the provider stops the lease and the dispatch fails closed; no half-configured box is left running.

### Install channels

- **`bundle`** packs the running Gateway's `dist`, a pruned `package.json`, and any workspace packages the build references, all covered by a content hash. The box verifies the pristine bundle against that hash, then installs production npm dependencies (scripts disabled). This is how you run a dev build on a worker.
- **`npm`** proves the release exists on the public registry, pins its SHA-512 integrity, and installs `openclaw@<version>` matching the Gateway exactly.

## Dispatching a session

Create a session with a managed worktree, then dispatch it (the RPC requires `operator.admin` and only exists when profiles are configured):

```bash
openclaw gateway call sessions.create \
  --params '{"key":"agent:main:big-refactor","worktree":true,"cwd":"/path/to/repo","worktreeName":"big-refactor"}'

openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","profileId":"aws"}'
```

`sessions.dispatch` closes local turn admission, drains active work, provisions the lease, runs setup, bootstraps OpenClaw, syncs the workspace, and returns once the placement reaches `active` worker ownership. Budget several minutes for the first dispatch; leases and installs are cached where the provider supports it. After that, talk to the session as usual — turns route to the worker automatically.

Placement moves through a durable state machine (`local → requested → provisioning → syncing → starting → active`), so a Gateway restart mid-dispatch reconciles instead of leaking machines. Dispatch is one-way in v1: there is no pull-back RPC yet, and a failed worker turn fail-stops the placement with the worker's stderr tail preserved in the placement error for diagnosis.

## Security model

- **Closed worker ingress.** Workers speak a dedicated protocol on the tunneled socket with a closed method allowlist — a worker cannot call operator RPCs.
- **Minted credentials, hashed at rest.** Each dispatch mints a worker credential; the Gateway stores only its hash. Credential rotation and owner-epoch fencing guarantee at most one live owner per session — a stale worker that reconnects is fenced, never merged.
- **Host-key pinning.** The provider must surface the box's SSH host key at provision time; bootstrap connects with strict pinning and fails closed without it.
- **No secrets on the box.** Model auth stays on the Gateway (inference travels by `{provider, model}` reference), and workspace git commits are authored on the box without credentials.
- **Durable, exactly-once transcripts.** The worker commits transcript batches through a compare-and-swap protocol against the session's leaf; a stale base fail-stops the run instead of duplicating or rebasing paid output.

## Troubleshooting

- **`sessions.dispatch` is an unknown method** — no `cloudWorkers.profiles` are configured, or the caller lacks `operator.admin`.
- **"Worker bootstrap requires Node.js on the leased host"** — add a Node install to `settings.setup` (see above).
- **Dispatch fails with a provider error** — the placement record and `environments.list` keep the last error, including the setup/bootstrap stderr tail. Boxes are destroyed on failure, so that tail is the primary forensic.
- **Client timeout while dispatching** — `openclaw gateway call` defaults to a 10s timeout; pass `--timeout` generously (dispatch keeps running server-side either way, and a retry while provisioning is rejected with `session cannot dispatch from placement provisioning`).
- **Lease housekeeping** — `crabbox list --provider <backend>` shows live leases; `crabbox stop --provider <backend> --id <lease>` releases one manually. Idle leases expire on the profile's `idleTimeout`.

## Related

- [Sandboxing](/gateway/sandboxing) — reducing blast radius for local tool execution
- [Sessions CLI](/cli/sessions) — inspecting stored sessions
- [Configuration reference](/gateway/configuration-reference)
