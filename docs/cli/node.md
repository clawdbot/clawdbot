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

## Why use a node host?

Use a node host when you want agents to **run commands on other machines** in your
network without installing a full macOS companion app there.

Common use cases:

- Run commands on remote Linux/Windows boxes (build servers, lab machines, NAS).
- Keep exec **sandboxed** on the gateway, but delegate approved runs to other hosts.
- Provide a lightweight, headless execution target for automation or CI nodes.

Execution is still guarded by **exec approvals** and per-agent allowlists on the
node host, so you can keep command access scoped and explicit.

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
- `--tls`: Use TLS for the gateway connection
- `--tls-fingerprint <sha256>`: Expected TLS certificate fingerprint (sha256)
- `--node-id <id>`: Override node id (clears pairing token)
- `--display-name <name>`: Override the node display name

## Gateway auth for node host

`openclaw node run` and `openclaw node install` resolve gateway auth from config/env (no `--token`/`--password` flags on node commands):

- `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` are checked first.
- Then local config fallback: `gateway.auth.token` / `gateway.auth.password`.
- In local mode, node host intentionally does not inherit `gateway.remote.token` / `gateway.remote.password`.
- If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, node auth resolution fails closed (no remote fallback masking).
- In `gateway.mode=remote`, remote client fields (`gateway.remote.token` / `gateway.remote.password`) are also eligible per remote precedence rules.
- Node host auth resolution only honors `OPENCLAW_GATEWAY_*` env vars.

For a node connecting to a non-loopback `ws://` Gateway on a trusted private
network, set `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`. Without it, node startup
fails closed and asks you to use `wss://`, an SSH tunnel, or Tailscale.
This is a process-environment opt-in, not an `openclaw.json` config key.
`openclaw node install` persists it into the supervised node service when it is
present in the install command environment.

## Service (background)

Install a headless node host as a user service.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Options:

- `--host <host>`: Gateway WebSocket host (default: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket port (default: `18789`)
- `--tls`: Use TLS for the gateway connection
- `--tls-fingerprint <sha256>`: Expected TLS certificate fingerprint (sha256)
- `--node-id <id>`: Override node id (clears pairing token)
- `--display-name <name>`: Override the node display name
- `--runtime <runtime>`: Service runtime (`node` or `bun`)
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
logs the close detail and exits non-zero so launchd/systemd can restart it with
fresh config and credentials. Pairing-required pauses stay in the foreground
flow so the pending request can be approved.

## Pairing

The first connection creates a pending device pairing request (`role: node`) on the Gateway.
Approve it via:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

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

This is disabled by default. It only applies to fresh `role: node` pairing with
no requested scopes. Operator/browser clients, Control UI, WebChat, and role,
scope, metadata, or public-key upgrades still require manual approval.

If the node retries pairing with changed auth details (role/scopes/public key),
the previous pending request is superseded and a new `requestId` is created.
Run `openclaw devices list` again before approval.

The node host stores its node id, token, display name, and gateway connection info in
`~/.openclaw/node.json`.

## Exec approvals

`system.run` is gated by local exec approvals:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (edit from the Gateway)

For approved async node exec, OpenClaw prepares a canonical `systemRunPlan`
before prompting. The later approved `system.run` forward reuses that stored
plan, so edits to command/cwd/session fields after the approval request was
created are rejected instead of changing what the node executes.

## Related

- [CLI reference](/cli)
- [Nodes](/nodes)
