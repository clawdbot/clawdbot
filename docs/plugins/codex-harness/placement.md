---
summary: "Place Codex native execution on a paired device or a cloud worker"
read_when:
  - You want Codex commands to run on another machine
  - You are approving the Codex node exec-server command
  - You are placing a Codex session on a cloud worker
title: "Run Codex on another machine"
sidebarTitle: "Remote placement"
---

How Codex sessions place native execution off the Gateway while the app-server, model connection, and transcript stay Gateway-owned. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Run Codex on a paired device

Codex sessions can place native command, filesystem, capability-discovery, and
HTTP execution on an eligible paired device while the Codex app-server, model
inference, provider authentication, and session transcript stay on the Gateway.
This is session-wide `remote-exec` placement, not `node_exec` or
`tools.exec.host: "node"`.

Install and enable the Codex plugin in both the Gateway's configuration and the
paired node's own local configuration. If either machine uses `plugins.allow`,
include `codex` in that machine's allowlist. On the Gateway, explicitly allow
the high-risk node command:

```json5
{
  gateway: {
    nodes: {
      commands: {
        allow: ["codex.exec-server.stdio.v1"],
      },
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

The paired node must enable session hosting and advertise the `codex.exec-server`
capability and `codex.exec-server.stdio.v1` command. If enabling the plugin
changes an existing node's command surface, reconnect the node, inspect
`openclaw nodes pending`, and approve the updated pairing with
`openclaw nodes approve <requestId>`. The persistent command allowlist does not
replace launch authorization. The critical prompt offers two approval scopes:

- **Allow once** authorizes one exec-server launch.
- **Allow always** authorizes later launches only while that exact session
  placement remains active on the same node, pairing generation, environment,
  owner epoch, placement generation, command risk, and working directory.

The Gateway keeps the standing placement grant only in its current process and
revalidates it immediately before every node transport dispatch. Restarting the
Gateway therefore returns to the normal prompt without migrating or reloading
approval state. Moving or reclaiming the session, replacing the environment,
reconnecting under a new pairing, changing the workspace, or reaching the
30-day maximum lifetime also invalidates reuse. If the Gateway cannot derive
the exact placement authority, it offers only **Allow once**. Deny starts no
process.

Explicitly selected session **Full access** can substitute for the prompt only
during the exact admitted turn and placement, and only when the node's own
`tools.exec` policy and exec-approvals floors both allow full/off execution.
Node-local deny always blocks. Local ask or allowlist restrictions require a
human decision; Full access does not erase them. If a Full launch is refused
by local policy, use an ordinary session permission mode to request approval,
or deliberately change the node's local policy and reconnect it.
Policy tightening during launch preparation refuses the stale launch.

Codex launches its node exec-server directly rather than starting an OpenClaw
worker, so a paired host remains eligible when all worker slots are occupied.
The command must still be effectively invocable: declaring it without the
approved pairing surface and Gateway allowlist is insufficient.

Approval grants access to any process or file available to the node's operating
system account. The verified placement workspace sets the working directory
and reconciliation scope; it does not sandbox or confine that access. Pair only
trusted devices, and run the node under a separate least-privilege OS account
when isolation is required.

Choose the paired device in the Control UI **Place** picker, or dispatch an
existing managed-worktree session explicitly:

```bash
openclaw gateway call sessions.dispatch \
  --params '{"key":"agent:main:device-work","deviceId":"<paired-device-id>"}'
```

The node starts the same managed, pinned Codex binary with
`codex exec-server --listen stdio` in the placement workspace. The node waits for
the native process to start listening before announcing execution readiness, so
cold disk startup does not consume Codex's initialize-handshake budget. Startup
remains cancellable through the existing attempt lifecycle. The Gateway
relays complete Codex JSON-RPC messages through the existing authenticated,
approval-gated duplex node channel, with a 64 MiB limit per message. It does not
start an OpenClaw worker child, open a reverse tunnel, or copy provider, cloud,
or GitHub credentials to the device. Authenticated remote HTTP is unavailable:
the Gateway rejects requests containing bearer/OAuth authorization, cookies,
API keys, or other sensitive authentication headers before sending them to the
node. Run authenticated HTTP on the Gateway, or use an intentionally
credential-free endpoint. The node process uses a fresh private
`HOME` and `CODEX_HOME` that are removed after the attempt, and both its launch
environment and requested child-process environments are sanitized. Completed
filesystem changes reconcile into the Gateway-owned managed worktree or, for
repository-only sessions, an immutable checkpoint retained by the Gateway.

Native task processes inherit the exec-server's startup `RUST_LOG` filter under
Codex's default environment policy. Set `RUST_LOG` explicitly in a command when
that program needs a different log level.

Disconnecting the node, closing the app-server connection, cancelling the turn,
or retiring the plugin ends that Codex attempt visibly and terminates its remote
exec-server process. Each paired-device attempt owns an isolated Gateway
app-server client, preventing remote environment registrations from
accumulating across attempts. Reconnecting the same paired device permits a
fresh attempt; it never resumes the disconnected stdio connection or its
processes. Normal Codex turns are supported, but `/btw` side questions are not
yet bound to paired-device placement and fail with an actionable explanation.
See [Cloud workers and paired-device placement](/gateway/cloud-workers) and
[Node command policy](/nodes#command-policy).

## Run Codex on a cloud worker

The bundled Crabbox provider supports both OpenClaw `worker-turn` and Codex
`remote-exec`, so one configured cloud-worker profile is selectable for either
harness. Choose the same **Cloud · profile** destination in New Session or
Move Session after selecting a Codex model. Profile placement requires
`operator.admin`. Start from a GitHub repository URL and optional ref without a
Gateway checkout, or place an existing Gateway managed-worktree session.
Repository-only sessions fetch and pin their source on the selected node.
Repository sessions require a managed node; SSH-only providers cannot create them.

Enable a trusted Codex plugin installation and explicitly allow
`codex.exec-server.stdio.v1` on the Gateway, as shown in
[Run Codex on a paired device](#run-codex-on-a-paired-device).
Crabbox automatically bootstraps the cloud node from the running Gateway's
built installation, including the Codex plugin and its pinned native dependency.
Bootstrap installs dependencies for the cloud machine's operating system and
CPU, then enables the plugin in the node's isolated state. Keep profile setup
focused on machine prerequisites and project tools, including a supported
Node.js release and npm. See [Bundle installation](/gateway/cloud-workers#bundle-installation)
for build and registry access requirements.

The Gateway checks the cloud node's current pairing and
effectively invocable command before starting a Codex process. The same
placement-scoped approval or explicitly selected Full access rules apply,
including the cloud node's local exec policy and approvals floors.

Codex runs its managed exec-server over the enrolled node's authenticated
outbound connection without starting an OpenClaw worker child or consuming a
worker slot. Its app-server, model connection, provider authentication, and
transcript remain Gateway-owned. Process and filesystem access still have the
node operating-system account's permissions, and only credential-free HTTP is
forwarded. Workspace changes reconcile to the Gateway-owned worktree or an
immutable repository checkpoint. A failed or disconnected attempt is terminal
and requires a fresh attempt; it never resumes the remote process or falls back
to Gateway-local or SSH execution.

See [Cloud workers](/gateway/cloud-workers) for profile configuration,
placement lifecycle, and cleanup.
