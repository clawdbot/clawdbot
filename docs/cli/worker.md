---
summary: "Internal operator reference for the restricted cloud worker runtime"
read_when:
  - Operating or debugging gateway-launched cloud workers
  - Verifying worker admission, session assignment, or local tool isolation
title: "Worker"
---

# `openclaw worker`

`openclaw worker` is the restricted runtime entry point for a cloud worker
orchestrator to launch inside a prepared worker environment. It is not a
general-purpose command for manual worker registration.

The gateway installs the matching OpenClaw bundle and opens the host-key-pinned
reverse SSH tunnel. The worker launcher starts this command with a prepared
assignment. The command connects through the tunnel-forwarded local socket and
admits as the dedicated `worker` role.

## Launch contract

The command reads exactly one bounded JSON launch envelope from standard input.
The envelope carries the local socket location, minted worker credential, bundle
and protocol identity, owner epoch, the single assigned session and turn, and the
exact worker-local tool names authorized for that turn. The Gateway resolves this
final tool set from current policy before handoff; raw config and scheduled-owner
identity never enter the worker envelope.
The credential is never accepted through command-line arguments, and this page
intentionally provides no credential or hand-authored envelope example.

Admission fails closed if the envelope is invalid, the credential is rejected,
the bundle or protocol features do not match, or the session and owner epoch are
no longer current. Missing, duplicate, or unknown tool names also invalidate the
envelope. Operators should start workers through the cloud worker
orchestrator rather than invoke this entry point directly.

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
no standing provider or forge credentials.

Worker-to-worker session dispatch is not exposed in this mode. Placement and
dispatch remain gateway-owned: an operator can dispatch an existing local,
managed-worktree session through the Gateway, while a worker process cannot
dispatch itself or another worker.

The prepared assignment carries the transcript context, accepted base leaf,
commit sequence, and live-event cursor. On a tunnel reconnect, the process
re-admits with the same credential and owner epoch, retains the accepted
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
inference turn with a provider error; only a tunnel or worker WebSocket
reconnect can reattach to an active same-process inference stream.

See [Gateway protocol](/gateway/protocol#worker-role-and-closed-protocol) for the
closed worker RPC surface and [Cloud workers plan](/plan/cloud-workers) for the
architecture and security model.
