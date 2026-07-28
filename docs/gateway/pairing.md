---
summary: "Node capability approvals: how nodes gain command exposure after device pairing"
read_when:
  - Implementing node pairing approvals without macOS UI
  - Adding CLI flows for approving remote nodes
  - Extending gateway protocol with node management
title: "Node pairing"
---

Node pairing has two layers, both stored on the paired device record in the
Gateway's SQLite state database:

- **Device pairing** (role `node`) gates the `connect` handshake. See
  [Trusted-CIDR device auto-approval](#trusted-cidr-device-auto-approval)
  below and [Channel pairing](/channels/pairing).
- **Node capability approval** (`node.pair.*`) gates which declared
  capabilities/commands a connected node may expose. The Gateway is the
  source of truth; UIs (macOS app, Control UI) are frontends that approve or
  reject pending requests.

The former standalone node pairing store (`nodes/paired.json` with a per-node
token, retired from the connect path in January 2026) is gone: gateways fold
any remaining rows into the device records once at startup and archive the
legacy files with a `.migrated` suffix. Legacy TCP bridge support has been
removed.

## How capability approval works

1. A node connects to the Gateway WS (device pairing gates this step).
2. The Gateway compares the declared capability/command surface with the
   approved one; new or widened surfaces store a **pending request** on the
   device record and emit `node.pair.requested`.
3. You approve or reject the request (CLI or UI).
4. Until approval, node commands stay filtered; approval exposes the declared
   surface, subject to the normal command policy.

Pending requests expire automatically **5 minutes after the node's last
retry** — an actively reconnecting node keeps its one pending request alive
rather than generating a fresh request (and approval prompt) per attempt.

## CLI workflow (headless friendly)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes remove --node <id|name|ip>
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` shows paired/connected nodes and their capabilities.

## API surface (gateway protocol)

Events:

- `node.pair.requested` - emitted when a new pending request is created.
- `node.pair.resolved` - emitted when a request is approved, rejected, or
  expired.

Methods:

- `node.pair.list` - list pending and paired nodes (`operator.pairing`).
- `node.pair.approve` - approve a pending request.
- `node.pair.reject` - reject a pending request.
- `node.pair.remove` - remove a paired node. This revokes the device's `node`
  role in the paired-device store, drops the approved node surface with it, and
  invalidates/disconnects that device's node-role sessions. A **mixed-role**
  device (for example one that also holds `operator`) keeps its row and only
  loses the `node` role; a node-only device row is deleted. Authz:
  `operator.pairing` may remove non-operator node rows; a device-token caller
  revoking its **own** node role on a mixed-role device additionally needs
  `operator.admin`.
- `node.rename` - rename a paired node's operator-facing display name.

Removed in 2026.7: `node.pair.request` and `node.pair.verify`. Pending
requests are created by the Gateway itself during node connects, and the
standalone per-node token they served no longer exists; node auth is the
device pairing token.

Notes:

- Reconnects with an unchanged surface reuse the pending request; repeated
  requests refresh the stored node metadata and the latest allowlisted
  declared command snapshot for operator visibility.
- Operator scope levels and approval-time checks are summarized in
  [Operator scopes](/gateway/operator-scopes).
- `node.pair.approve` uses the pending request's declared commands to enforce
  extra approval scopes:
  - commandless request: `operator.pairing`
  - ordinary command request: `operator.pairing` + `operator.write`
  - admin-sensitive request containing `system.run`, `system.run.prepare`,
    `system.which`, `browser.proxy`, `fs.listDir`, or
    `system.execApprovals.get/set`: `operator.pairing` + `operator.admin`

<Warning>
Node pairing approval records the trusted capability surface. It does **not** pin the live node command surface per node.

- Live node commands come from what the node declares on connect, filtered by
  the gateway's global node command policy (`gateway.nodes.commands.allow` and
  `gateway.nodes.commands.deny`).
- Per-node `system.run` allow and ask policy lives on the node in
  `exec.approvals.node.*`, not in the pairing record.

</Warning>

## Node command gating (2026.3.31+)

<Warning>
**Breaking change:** starting with `2026.3.31`, node commands are disabled until node pairing is approved. Device pairing alone is no longer enough to expose declared node commands.
</Warning>

When a node connects for the first time, pairing is requested automatically.
Until that request is approved, all pending node commands from that node are
filtered and will not execute. Once pairing is approved, the node's declared
commands become available, subject to the normal command policy.

This means:

- Nodes that previously relied on device pairing alone to expose commands must
  now also complete node pairing.
- Commands queued before pairing approval are dropped, not deferred.

## Node event trust boundaries (2026.3.31+)

<Warning>
**Breaking change:** node-originated runs now stay on a reduced trusted surface.
</Warning>

Node-originated summaries and related session events are restricted to the
intended trusted surface. Notification-driven or node-triggered flows that
previously relied on broader host or session tool access may need adjustment.
This hardening keeps node events from escalating into host-level tool access
beyond what the node's trust boundary permits.

Durable node presence updates follow the same identity boundary: the
`node.presence.alive` event is accepted only from authenticated node device
sessions, and updates pairing metadata only when the device/node identity is
already paired. A self-declared `client.id` value is not enough to write
last-seen state.

## SSH-verified device auto-approval (default)

First-time `role: node` device pairing from a private/CGNAT address is
auto-approved when the gateway can **prove machine ownership over SSH**: it
connects back to the pairing host (`BatchMode`, `StrictHostKeyChecking=yes`),
runs `openclaw node identity --json` there, and approves only when the remote
device id and public key match the pending request exactly. The key match is
what makes this safe: reachability alone never approves, so NAT co-tenants,
other users on a shared host, and LAN spoofing all fall through to the normal
prompt.

Enabled by default. Requirements for it to fire:

- The gateway process user (or `sshVerify.user`) can SSH to the node host
  non-interactively (keys/agent; Tailscale SSH works too), and the host key is
  already trusted.
- `openclaw` resolves on the remote `PATH` for non-interactive `sh -lc`.
- The connecting IP is a direct (non-proxied, non-loopback) private, ULA,
  link-local, or CGNAT address, or matches `sshVerify.cidrs` when set.
- Same eligibility floor as trusted-CIDR approval: fresh scopeless node
  pairing only; upgrades, browsers, Control UI, and WebChat always prompt.

While a probe is running, the node client is told to keep retrying
(`wait_then_retry`) instead of pausing for manual approval; if the probe
fails, the next attempt falls back to the normal prompt flow. Failed targets
get a short cooldown (5 minutes after a key mismatch).

Approved devices record `approvedVia: "ssh-verified"` and their first declared
capability surface is approved in the same step — the key match already proves
the node runs under the operator's account on a machine they own, which is the
same claim a manual capability approval asserts. Later surface upgrades still
prompt.

Harden or disable:

```json5
{
  gateway: {
    nodes: {
      pairing: {
        // Disable entirely:
        sshVerify: false,
        // ...or scope/tune the probe:
        // sshVerify: { user: "me", identity: "~/.ssh/probe", timeoutMs: 7000, cidrs: ["10.0.0.0/8"] },
      },
    },
  },
}
```

## Auto-approval (macOS app)

The macOS app can attempt a **silent approval** of node capability requests
when:

- the request is marked `silent` (the gateway marks the first capability
  surface silent when device pairing was approved non-interactively), and
- the app can verify an SSH connection to the gateway host using the same
  user.

If silent approval fails, it falls back to the normal Approve/Reject prompt.

## Trusted-CIDR device auto-approval

WS device pairing for `role: node` stays manual by default. For private node
networks where the Gateway already trusts the network path, operators can opt
in with explicit CIDRs or exact IPs:

```json5
{
  gateway: {
    nodes: {
      pairing: {
        autoApproveCidrs: ["192.168.1.0/24"],
      },
    },
  },
}
```

Security boundary:

- Disabled when `gateway.nodes.pairing.autoApproveCidrs` is unset.
- No blanket LAN or private-network auto-approve mode exists; SSH-verified
  auto-approval (above) requires a cryptographic device-key match, never
  network locality alone.
- Only a fresh `role: node` device pairing request with no requested scopes is
  eligible.
- Operator, browser, Control UI, and WebChat clients stay manual.
- Role, scope, metadata, and public-key upgrades stay manual.
- Same-host loopback trusted-proxy header paths are not eligible, because that
  path can be spoofed by local callers.

## Silent pairing supersede cleanup

Non-interactive approvals record their provenance on the paired-device row:
same-host local policy approvals as `silent`, trusted-CIDR node approvals as
`trusted-cidr`, SSH-verified node approvals as `ssh-verified`. Clients whose state directory is ephemeral (temporary homes,
containers, per-run sandboxes) mint a fresh device keypair per run, and every
run silently re-pairs as a brand-new device — without cleanup the paired list
grows one stale row per run.

When the Gateway silently approves a **local** device pairing, it retires
older `silent`-approved records that belong to the same client cluster
(matching `clientId`, `clientMode`, and display name) and are not currently
connected. Local clients run on the gateway host itself, so the cluster key
cannot match a different machine. Retired rows lose their tokens immediately;
any matching legacy node pairing entry is cleared and a `node.pair.resolved`
removal event is broadcast.

Boundaries:

- Only records whose latest approval was same-host local (`silent`) are
  eligible, as trigger and as target. Trusted-CIDR and SSH-verified pairings
  cross hosts where display metadata is not a machine identity, so they are
  never removed automatically — use the Control UI cleanup or
  `openclaw nodes remove` for those.
- Owner-approved and QR/setup-code (bootstrap) pairings are never removed
  automatically. Records approved before provenance existed stay protected,
  even after a later silent re-approval of the same device id.
- Currently connected devices are skipped, so concurrent local sessions with
  separate state directories keep their tokens while live. Records approved
  within the last minute are also skipped, so simultaneous pairing handshakes
  cannot retire each other before their connections register.
- Affected clients are local by construction, so they re-pair silently on
  their next connection.

## Metadata-upgrade auto-approval

When an already-paired device reconnects with only non-sensitive metadata
changes (for example display name or client platform hints), OpenClaw treats
that as a `metadata-upgrade`. Silent auto-approval is narrow: it applies only
to trusted non-browser local reconnects that already proved possession of
local or shared credentials, including same-host native app reconnects after
OS version metadata changes. Browser/Control UI clients and remote clients
still use the explicit re-approval flow. Scope upgrades (read to
write/admin) and public key changes are **not** eligible for
metadata-upgrade auto-approval; they stay explicit re-approval requests.

## QR pairing helpers

`/pair qr` renders the pairing payload as structured media so mobile and
browser clients can scan it directly.

Deleting a device also sweeps any stale pending pairing requests for that
device id, so `nodes pending` does not show orphaned rows after a revoke.

## Locality and forwarded headers

Gateway pairing treats a connection as loopback only when both the raw socket
and any upstream proxy evidence agree. If a request arrives on loopback but
carries `Forwarded`, any `X-Forwarded-*`, or `X-Real-IP` header evidence, that
forwarded-header evidence disqualifies the loopback locality claim, and the
pairing path requires explicit approval instead of silently treating the
request as a same-host connect. See
[Trusted Proxy Auth](/gateway/trusted-proxy-auth) for the equivalent rule on
operator auth.

## Storage (local, private)

Pairing state lives on the paired device records in the shared SQLite state
database under the Gateway state directory (default `~/.openclaw`):

- `~/.openclaw/state/openclaw.sqlite` (paired devices with device auth,
  approved node surfaces, pending surface requests, pending device pairing
  requests, and bootstrap tokens)

If you override `OPENCLAW_STATE_DIR`, the database moves with it. Gateways
upgraded from releases with JSON stores import them at startup and leave
`devices/*.json.migrated` and `nodes/*.json.migrated` archives behind.

Security notes:

- Device tokens are secrets; treat the state database as sensitive.
- Rotating a device token uses `openclaw devices rotate` /
  `device.token.rotate`.

## Transport behavior

- The transport is **stateless**; it does not store membership.
- If the Gateway is offline or pairing is disabled, nodes cannot pair.
- In remote mode, pairing happens against the remote Gateway's store.

## Related

- [Channel pairing](/channels/pairing)
- [Nodes CLI](/cli/nodes)
- [Devices CLI](/cli/devices)
