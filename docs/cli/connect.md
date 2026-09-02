---
summary: "Connect a machine to an OpenClaw Gateway with one pasted command"
read_when:
  - Pairing a new headless node with a Gateway
  - Installing a node host from a join URL or setup code
title: "Connect"
---

# `openclaw connect`

Connect the current machine to an OpenClaw Gateway as a headless node. The
command redeems a short-lived bootstrap credential, saves the Gateway endpoint
in the existing node-host state, and runs the same runtime as
[`openclaw node run`](/cli/node).

## Create a join command

On the Gateway host, use admin credentials to mint a single-use join URL:

```bash
openclaw devices join-code
```

The command prints the URL and a pasteable command:

```bash
npx openclaw connect https://gateway.example/j/<shortcode>
```

The shortcode has 128 bits of entropy, expires with the setup credential after
about 10 minutes, and can be fetched exactly once. Mint another code if it
expires or has already been used.

## Connect in the foreground

Paste the printed command on the machine you want to connect:

```bash
npx openclaw connect https://gateway.example/j/<shortcode>
```

Set the device name during enrollment when useful:

```bash
npx openclaw connect https://gateway.example/j/<shortcode> --display-name "Build Node"
```

The node stays in the foreground until you stop it.

To expose only selected commands, pass a comma-separated list of exact command
IDs. For a [Session Share](/plugins/session-share) node:

```bash
openclaw connect <join-url> \
  --commands openclaw.sessions.list.v1,openclaw.sessions.read.v1
```

The flag is repeatable. The allowlist is durable node state and also applies
after `--service` installation; omitting it preserves a saved list. It filters
available commands and their required capabilities,
and disables computer use, skills, plugin-tool publication, MCP servers, and
worker hosting. Startup fails when no requested command is available. The
Gateway pairing approval shows the resulting declared commands.

To restore the full default surface, use `openclaw node run --all-commands`
for a foreground node or `openclaw node install --force --all-commands` for
an installed service. When enrolling again, use `openclaw connect <join-url>
--all-commands` (add `--service` for a service). This forgets the saved allowlist;
`--all-commands` cannot be combined with `--commands`.

To let that foreground process host full worker sessions, give explicit local
consent with `--session-host`:

```bash
npx openclaw connect https://gateway.example/j/<shortcode> --session-host
```

Foreground consent applies only to that process. It does not change
`openclaw.json`, so the next normal node-host start remains non-hosting.

## Environment-managed cloud nodes

Worker providers use `--ephemeral` for disposable cloud machines:

```bash
npx openclaw connect <setup-code> --ephemeral
```

This process hosts worker sessions even when the machine's durable node config has worker hosting disabled. It does not install a service and cannot be combined with `--service` or `--session-host`. The Gateway owns the setup identity and paired-node lifetime: provider replay resumes the persisted device token after the one-shot setup credential is consumed, and environment teardown removes the node role after releasing the cloud lease.

`--ephemeral` is intended for provider-managed state directories on throwaway machines, not as a shortcut for enrolling a personal device.

## Install as a service

Pass `--service` to redeem the bootstrap credential and install the node host as
the platform user service:

```bash
npx openclaw connect https://gateway.example/j/<shortcode> --service
```

OpenClaw completes the first authenticated connection before installing the
service. The short-lived bootstrap token is never stored in the service command
or node-host configuration; later starts use the durable paired-device token.
Use [`openclaw node status`](/cli/node#service-background) to inspect the
installed service.

The service does not host worker sessions by default. To consent to full
worker-session hosting, add `--session-host`:

```bash
npx openclaw connect https://gateway.example/j/<shortcode> --service --session-host
```

The one-shot bootstrap connection authenticates and saves the durable device
identity without advertising worker hosting. Only after that connection
succeeds does OpenClaw persist `nodeHost.workerRuns.enabled=true`, preserving
the rest of the config, and install the service. If the config write fails,
service installation does not start. The installed service advertises worker
hosting and exact capacity from this durable consent when it starts.

## Accepted targets

| Option                  | Purpose                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--commands <ids>`      | Save an exact comma-separated node command allowlist (repeatable). Applies to foreground runs and installed services. |
| `--all-commands`        | Advertise the full default command surface and forget any saved `--commands` allowlist. Conflicts with `--commands`.  |
| `--display-name <name>` | Set the node display name.                                                                                            |
| `--service`             | Pair first, then install the node as a user service.                                                                  |
| `--session-host`        | Consent to worker hosting. An explicit command allowlist disables hosting.                                            |
| `--ephemeral`           | Run a provider-managed disposable worker node.                                                                        |
| `--target-file <path>`  | Read a join target from a file and consume the handoff after a successful read.                                       |

`openclaw connect <target>` accepts:

- an `https://<gateway>/j/<shortcode>` join URL;
- an `oc-pair://<setup-code>` URL;
- a bare base64url setup code.

`--target-file <path>` accepts a regular file up to 64 KiB. It removes the path
only after reading a non-empty target. If the file is empty, too large,
unreadable, or not a regular file, OpenClaw leaves it in place. A symlink is
allowed; OpenClaw reads its target, removes the symlink after a successful read,
and keeps the backing file. The dormant installer wrapper uses this handoff to
keep the single-use target out of child-process arguments.

Join URLs must use HTTPS. Plain HTTP is accepted only for loopback Gateway URLs
such as `http://127.0.0.1/j/<shortcode>`. Direct setup codes can carry the
Gateway TLS certificate fingerprint, which lets the node host pin a self-signed
Gateway certificate after decoding the payload.

The payload determines the saved host, port, TLS mode, WebSocket context path,
and ordered fallback endpoints. Normal and foreground connections do not add
`openclaw.json` keys; `--service --session-host` explicitly persists the worker
hosting consent described above.

## Revocation behavior

A join code and a paired device have separate lifecycles:

- Burning or expiring a join code prevents another enrollment with that code.
- It does not disconnect or remove a node that already redeemed it.
- To revoke a normal enrolled machine, remove its paired device with
  [`openclaw devices remove <deviceId>`](/cli/devices#openclaw-devices-remove-%3Cdeviceid%3E).
- Environment-managed `--ephemeral` nodes are removed automatically when their owning cloud environment is destroyed.

## Troubleshooting

If the join URL reports that it is missing or expired, mint a new one with
`openclaw devices join-code`. A used code intentionally returns the same result
as an unknown code.

If an HTTPS join URL uses a certificate the local machine does not trust, use
the direct `oc-pair://` or bare setup-code form that includes the TLS pin.

See [Node](/cli/node) for service management, explicit connection flags, node
state, and exec approval behavior.
