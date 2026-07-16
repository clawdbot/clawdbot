---
summary: "CLI reference for `openclaw node` (headless node host)"
read_when:
  - Running the headless node host
  - Pairing a non-macOS node for system.run
title: "Node"
---

# `openclaw node`

Run a **headless node host** that connects to the Gateway WebSocket and exposes
`system.run` / `system.which` on this machine.

On macOS, the menu bar app already embeds this node-host runtime into its own
node connection and adds native Mac capabilities. Use `openclaw node run` on a
Mac only when you intentionally want a headless node without the app. Running
both creates two node identities for the same machine.

## Why use a node host?

Use a node host when you want agents to **run commands on other machines** in your
network without installing a full macOS companion app there.

Common use cases:

- Run commands on remote Linux/Windows boxes (build servers, lab machines, NAS).
- Keep exec **sandboxed** on the gateway, but delegate approved runs to other hosts.
- Provide a lightweight, headless execution target for automation or CI nodes.

Execution is still guarded by **exec approvals** and per-agent allowlists on the
node host, so you can keep command access scoped and explicit.

`openclaw node run` can publish plugin or MCP-backed tools after it connects.
The Gateway trusts descriptors from the paired node by default, while requiring
each descriptor's command to remain in the node's approved command surface. The
agent sees each accepted descriptor as a normal plugin tool, but execution still
goes through `node.invoke`, so disconnecting the node removes the tool from new
agent runs. Gateway operators can disable publication with
`gateway.nodes.pluginTools.enabled: false`.

For declarative MCP tools, add the normal MCP server shape under
`nodeHost.mcp.servers` in `openclaw.json` on the node machine, then restart the
node host. The node declares the approval-gated `mcp.tools.call.v1` command
family and publishes listed tools after connecting; changing the server list
later does not require re-pairing. See
[Node-hosted MCP servers](/nodes#node-hosted-mcp-servers).

## Browser proxy (zero-config)

Node hosts automatically advertise a browser proxy if `browser.enabled` is not
disabled on the node. This lets the agent use browser automation on that node
without extra configuration.

By default, the proxy exposes the node's normal browser profile surface. If you
set `nodeHost.browserProxy.allowProfiles`, the proxy becomes restrictive:
non-allowlisted profile targeting is rejected, and persistent profile
create/delete routes are blocked through the proxy.

Disable it on the node if needed:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Run (foreground)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Options:

- `--host <host>`: Gateway WebSocket host (default: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket port (default: `18789`)
- `--context-path <path>`: Gateway WebSocket context path (e.g. `/openclaw-gw`). Appended to the WebSocket URL.
- `--tls`: Use TLS for the gateway connection
- `--no-tls`: Force a plaintext Gateway connection even when the local Gateway config enables TLS
- `--tls-fingerprint <sha256>`: Expected TLS certificate fingerprint (sha256)
- `--node-id <id>`: Override the client instance ID stored in shared SQLite state (does not reset pairing)
- `--display-name <name>`: Override the node display name

## Gateway auth for node host

`openclaw node run` and `openclaw node install` resolve gateway auth from config/env (no `--token`/`--password` flags on node commands):

- `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` are checked first.
- Then local config fallback: `gateway.auth.token` / `gateway.auth.password`.
- In local mode, node host intentionally does not inherit `gateway.remote.token` / `gateway.remote.password`.
- If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, node auth resolution fails closed (no remote fallback masking).
- In `gateway.mode=remote`, remote client fields (`gateway.remote.token` / `gateway.remote.password`) are also eligible per remote precedence rules.
- Node host auth resolution only honors `OPENCLAW_GATEWAY_*` env vars.

For a node connecting to a plaintext `ws://` Gateway, loopback, private IP
literals, `.local`, and Tailnet `*.ts.net` hosts are accepted. For other
trusted private-DNS names, set `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`; without
it, node startup fails closed and asks you to use `wss://`, an SSH tunnel, or
Tailscale. This is a process-environment opt-in, not an `openclaw.json` config
key.
`openclaw node install` persists it into the supervised node service when it is
present in the install command environment.

## Service (background)

Install a headless node host as a user service (launchd on macOS, systemd on
Linux, Windows Task Scheduler on Windows).

```bash
openclaw node install --host <gateway-host> --port 18789
```

Options:

- `--host <host>`: Gateway WebSocket host (default: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket port (default: `18789`)
- `--context-path <path>`: Gateway WebSocket context path (e.g. `/openclaw-gw`). Appended to the WebSocket URL.
- `--tls`: Use TLS for the gateway connection
- `--tls-fingerprint <sha256>`: Expected TLS certificate fingerprint (sha256)
- `--node-id <id>`: Override the client instance ID stored in shared SQLite state (does not reset pairing)
- `--display-name <name>`: Override the node display name
- `--runtime <runtime>`: Service runtime (`node`)
- `--force`: Reinstall/overwrite if already installed

Manage the service:

```bash
openclaw node status
openclaw node start
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Use `openclaw node run` for a foreground node host (no service).

Service commands accept `--json` for machine-readable output.

The node host retries Gateway restart and network closes in-process. If the
Gateway reports a terminal token/password/bootstrap auth pause, the node host
logs the close detail and exits non-zero so launchd/systemd/Task Scheduler can
restart it with fresh config and credentials. Pairing-required pauses stay in
the foreground flow so the pending request can be approved.

## Pairing

The first connection creates a pending device pairing request (`role: node`) on the Gateway.

When the Gateway host can SSH to the node host non-interactively (same user,
trusted host key), the pending request is approved automatically: the Gateway
runs `openclaw node identity --json` on the node host over SSH and approves on
an exact device-key match. This is on by default; see
[SSH-verified device auto-approval](/gateway/pairing#ssh-verified-device-auto-approval-default)
for requirements and how to disable it (`gateway.nodes.pairing.sshVerify: false`).

Otherwise approve manually via:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

Inspect the local node identity the Gateway verifies against:

```bash
openclaw node identity --json
```

It prints the device ID and public key from `identity/device.json` and never
creates or modifies identity files.

On tightly controlled node networks, the Gateway operator can explicitly opt in
to auto-approving first-time node pairing from trusted CIDRs:

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

This is disabled by default (`autoApproveCidrs` is unset). It only applies to
fresh `role: node` pairing with no requested scopes, from a client IP the
Gateway trusts. Operator/browser clients, Control UI, WebChat, and role,
scope, metadata, or public-key upgrades still require manual approval.

If the node retries pairing with changed auth details (role/scopes/public key),
the previous pending request is superseded and a new `requestId` is created.
Run `openclaw devices list` again before approval.

### Identity and pairing state

The headless node separates its client instance ID from the signed device
identity that the Gateway uses for pairing and routing. This state lives in the
OpenClaw state directory (`~/.openclaw` by default, or `$OPENCLAW_STATE_DIR`
when set):

| State                                        | Purpose                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `state/openclaw.sqlite` (`node_host_config`) | Client instance ID, display name, and Gateway connection metadata. The client sends this ID as `instanceId`.                     |
| `identity/device.json`                       | Signed Ed25519 keypair and derived device ID. For signed connections, this device ID is the routed node ID and pairing identity. |
| `identity/device-auth.json`                  | Paired device tokens, keyed by cryptographic device ID and role.                                                                 |

`--node-id` changes only the client instance ID in shared SQLite state. It does
not change the cryptographic device ID or clear pairing auth. Migrating a retired
`node.json` with `openclaw doctor --fix` likewise does not reset pairing. To
revoke and re-pair a node:

1. On the Gateway, run `openclaw nodes remove --node <id|name|ip>`.
2. On the node, restart the installed service with `openclaw node restart`, or
   stop and rerun the foreground `openclaw node run` command. This starts the
   device-pairing flow. If `openclaw devices list` does not show a request
   and the node reports `AUTH_DEVICE_TOKEN_MISMATCH`, restart or rerun it once
   more. The rejected attempt clears the now-revoked local token; the next
   attempt can request pairing.
3. On the Gateway, run `openclaw devices list`, then
   `openclaw devices approve <deviceRequestId>`.
4. Restart or rerun the node again. A client paused for pairing does not resume
   automatically after approval; this reconnect creates the separate
   command-surface request.
5. On the Gateway, run `openclaw nodes pending`, then
   `openclaw nodes approve <nodeRequestId>`.

The two request IDs are distinct. An applicable trusted-CIDR policy can
auto-approve the first-time device-pairing step; command-surface approval remains
a separate check.

Older OpenClaw releases stored node-host state in `node.json` and could leave an
obsolete `token` field there. Stop the node host and run `openclaw doctor --fix`
once; Doctor imports the supported identity and connection fields into SQLite,
discards the unused token field, verifies the row, and removes the retired file.
Normal node commands fail closed with this repair instruction while the file or
an interrupted Doctor claim remains. Keep both files under `identity/` private;
they contain the device keypair and auth tokens.

## Exec approvals

`system.run` is gated by local exec approvals:

- `$OPENCLAW_STATE_DIR/exec-approvals.json`, or
  `~/.openclaw/exec-approvals.json` when the variable is unset
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (edit from the Gateway)

For approved async node exec, OpenClaw prepares a canonical `systemRunPlan`
before prompting. The later approved `system.run` forward reuses that stored
plan, so edits to command/cwd/session fields after the approval request was
created are rejected instead of changing what the node executes.

## Related

- [CLI reference](/cli)
- [Nodes](/nodes)
