---
summary: "Internal operator reference for the restricted cloud worker runtime"
read_when:
  - Operating or debugging gateway-launched cloud workers
  - Verifying worker admission, session assignment, or local tool isolation
title: "Worker"
---

# `openclaw worker`

`openclaw worker` is the restricted runtime entry point for a Gateway-owned
launcher to start inside a prepared cloud or paired-node worker environment.
It is not a general-purpose command for manual worker registration.

The Gateway installs the matching OpenClaw bundle through the enrolled node's
authenticated connection. The worker launcher starts this command with a
prepared assignment, and the worker connects back to the Gateway over its own
authenticated outbound WebSocket as the dedicated `worker` role.

## Launch contract

The command reads exactly one bounded JSON launch envelope from standard input.
The envelope carries the Gateway worker endpoint, minted worker credential,
bundle and protocol identity, owner epoch, the single assigned session and turn,
and the exact worker-local tool names authorized for that turn. The Gateway
resolves this final tool set from current policy before handoff; raw config and
scheduled-owner identity never enter the worker envelope.
The credential is never accepted through command-line arguments, and this page
intentionally provides no credential or hand-authored envelope example.

The node supervisor uses a private managed entry point that can admit successive
turns into the same environment while background processes remain. Each turn
still receives a fresh bounded envelope, Gateway connection, and tool authority.
The standalone command above remains a single-turn entry point.

Launches must fit 25 MiB in each complete serialized form: the node invocation
event and the managed worker input line, including the node's connection endpoint.
The Gateway trims older complete turns when needed, without discarding the newest
provider replay checkpoint. If that replay unit cannot fit, the turn fails before
handoff with a visible retry instruction. The managed line limit excludes its final
newline; standalone stdin counts every byte.

Admission fails closed if the envelope is invalid, the credential is rejected,
the bundle or protocol features do not match, or the session and owner epoch are
no longer current. Missing, duplicate, or unknown tool names also invalidate the
envelope. Operators should start workers through the cloud worker
orchestrator rather than invoke this entry point directly.

If admission exhausts its 120-second retry budget, the terminal error includes
the attempt count, Gateway host and port (or local socket path), and last failure.
`connect failed` means the WebSocket did not open; check reachability and TLS.
`no hello within deadline` means it opened but the Gateway did not complete worker
admission. A retryable admission rejection retains its reason. These bounded,
credential-redacted details appear in the node launch journal and turn error.

Container launches revalidate the pinned daemon identity before creating each
container. This check allows 30 seconds for a busy daemon; a timeout still fails
the launch and names the command. A changed daemon identity remains a hard failure.

## Runtime boundary

The process runs the normal embedded agent loop with a restricted backend:

- The `read`, `write`, `edit`, `apply_patch`, `exec`, and `process` coding tools
  run locally in the worker workspace when present in the Gateway-issued turn
  authority. An empty authority runs the model with no tools.
- Model calls use the gateway inference proxy. No local model auth profile is
  loaded.
- Transcript writes use the gateway transcript-commit RPC.
- Streaming and tool lifecycle updates use the gateway live-event RPC.
- Only the assigned session and turn are accepted.

Worker mode does not start channels, Gateway HTTP surfaces, or plugin auto-start
beyond the assigned session toolset. It uses a throwaway state directory and has
no model provider credentials. When the Gateway's effective shared GitHub identity
is available, the worker receives a turn-bound access token in its private launch
envelope. The token is materialized in a private per-turn profile inside the
throwaway state directory, with earlier profiles removed before the next binding,
and scrubbed when that directory is removed. The sealed worker launcher binds it
to each `exec` child. GitHub CLI must be installed on the worker host; the bundle
includes the launcher, not `gh`.

Materialized skill files are temporary turn inputs in a private directory separate
from worker state and its GitHub credentials. A failed per-turn deletion logs
`Materialized skill cleanup failed`. Node Claude skill sessions separately report
`Node Claude skill session cleanup failed` for temporary Workshop configuration. These
bounded, redacted warnings identify files that may remain. Wait until the worker or
session and its owned processes have stopped before checking permissions and manually
removing the reported directory. A completed turn alone does not mean a managed worker
has stopped. These filesystem deletion failures preserve the original success, error,
cancellation, or timeout without replaying work or claiming deletion succeeded.
Worker state deletion, including GitHub credential cleanup, still rejects on failure.
Process draining, authority revocation, database close, and transport or MCP close
retain their existing failure behavior. Invalid skill integrity or delivery limits
still reject the turn.

The worker loads workspace `AGENTS.md` through the bounded bootstrap loader and
appends Gateway-supplied system instructions as literal text. It does not discover
`SYSTEM.md` or `APPEND_SYSTEM.md` from the workspace or agent state directory.

Worker-to-worker session dispatch is not exposed in this mode. Placement and
dispatch remain gateway-owned: an operator can dispatch an existing local,
managed-worktree session through the Gateway, while a worker process cannot
dispatch itself or another worker.

The prepared assignment carries the transcript context, accepted base leaf,
commit sequence, and live-event cursor. On a worker WebSocket reconnect, the
process re-admits with the same credential and owner epoch, retains the accepted
transcript base, replays its unacknowledged live-event tail, and reattaches an
in-flight inference turn with the same identity. The terminal inference message
is authoritative if streamed deltas were missed. A superseding owner epoch
fences the process and causes a clean exit.

A `stale-base-leaf` transcript rejection fail-stops the current run. Worker
mode does not retry the rejected sequence against a different leaf, so no
duplicate commit is produced; any still-uncommitted in-memory tail from that
run is lost. Relaunch belongs to the milestone-3 placement owner, which must
create a fresh assignment from the gateway's authoritative transcript and
commit ledger. Likewise, a gateway process restart terminates a pending
inference turn with a provider error; only a worker WebSocket reconnect can
reattach to an active same-process inference stream.

See [Gateway protocol](/gateway/protocol/handshake#worker-role-and-closed-protocol) for the
closed worker RPC surface and [Cloud workers](/gateway/cloud-workers) for the
architecture and security model.
