---
summary: "CLI reference for `openclaw nodes` (status, pairing, invoke, camera/canvas/screen/location/notify)"
read_when:
  - You're managing paired nodes (cameras, screen, canvas)
  - You need to approve requests or invoke node commands
title: "Nodes"
---

# `openclaw nodes`

Manage paired nodes (devices) and invoke node capabilities.

Related: [Nodes overview](/nodes) - [Active computer presence](/nodes/presence) - [Camera nodes](/nodes/camera) - [Image nodes](/nodes/images)

Common options on every subcommand: `--url <url>`, `--token <token>`, `--timeout <ms>` (default `10000`), `--json`.

## Status

```bash
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
openclaw nodes list
openclaw nodes describe --node <idOrNameOrIp>
```

`status` and `list` both accept `--connected` (only connected nodes) and `--last-connected <duration>` (e.g. `24h`, `7d`; only nodes that connected within the duration). `list` shows pending and paired nodes in separate tables, with paired rows including the most recent connect age (Last Connect); `status` shows one merged table with per-node capability, version, and last-input detail. A connected macOS node reports last input only while Accessibility permission is granted, and the freshest row is marked `active`; see [Active computer presence](/nodes/presence). `describe` prints one node's capabilities, permissions, activity, and effective/pending invoke commands.

## Pairing

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes remove --node <id|name|ip>
openclaw nodes rename --node <id|name|ip> --name <displayName>
```

These commands drive the gateway-owned `node.pair.*` store, separate from device pairing (`openclaw devices approve`) that gates the node's WS `connect` handshake. See [Nodes](/nodes) for how the two relate.

- `remove` revokes the node's paired-role entry. For a device-backed node this revokes the `node` role in the device pairing store and disconnects its node-role sessions: a mixed-role device keeps its row and only loses the `node` role, a node-only device row is deleted. It also clears any matching legacy gateway-owned node pairing record.
- `pending` only needs `operator.pairing` scope.
- `gateway.nodes.pairing.autoApproveCidrs` can skip the pending step for explicitly trusted, first-time `role: node` device pairing. Off by default; does not approve role upgrades.
- `gateway.nodes.pairing.sshVerify` (on by default) auto-approves first-time `role: node` device pairing when the gateway can verify the device key over SSH to the node host; the first capability surface is approved in the same step. See [Node pairing](/gateway/pairing#ssh-verified-device-auto-approval-default).
- `approve` scope requirements follow the pending request's declared commands:
  - commandless request: `operator.pairing`
  - ordinary node commands: `operator.pairing` + `operator.write`
  - admin-sensitive commands (`system.run`, `system.run.prepare`, `system.which`, `browser.proxy`, `fs.listDir`, and `system.execApprovals.get/set`): `operator.pairing` + `operator.admin`
- `remove` scope: `operator.pairing` can remove non-operator node rows; a device-token caller revoking its own node role on a mixed-role device additionally needs `operator.admin`.

## Invoke

```bash
openclaw nodes invoke --node <id> --command system.which --params '{"bins":["uname"]}'
```

Flags:

- `--command <command>` (required): e.g. `canvas.eval`.
- `--params <json>`: JSON object string (default `{}`).
- `--invoke-timeout <ms>`: node invoke timeout (default `15000`).
- `--idempotency-key <key>`: optional idempotency key.

`system.run` and `system.run.prepare` are blocked here; use the `exec` tool with `host=node` for shell execution instead. `system.which` is allowed through `invoke`.

## Notify, push, location, screen

```bash
openclaw nodes notify --node <id> --title "Build" --body "Done" --priority timeSensitive
openclaw nodes push --node <id> --title "OpenClaw" --environment sandbox
openclaw nodes location get --node <id> --accuracy precise
openclaw nodes screen record --node <id> --duration 10s --fps 10 --out ./clip.mp4
```

- `notify` sends a local notification on a node that declares `system.notify`, including macOS, iOS, Android, and direct watchOS nodes. Direct watchOS delivery requires OpenClaw to be active. Requires `--title` or `--body`. Options: `--sound <name>`, `--priority <passive|active|timeSensitive>`, `--delivery <system|overlay|auto>` (default `system`), `--invoke-timeout <ms>` (default `15000`).
- `push` sends an APNs test push to an iOS node. Options: `--title <text>` (default `OpenClaw`), `--body <text>`, `--environment <sandbox|production>` to override the detected APNs environment.
- `location get` fetches the node's current location. Options: `--max-age <ms>` (reuse a cached fix), `--accuracy <coarse|balanced|precise>`, `--location-timeout <ms>` (default `10000`), `--invoke-timeout <ms>` (default `20000`).
- `screen record` captures a short clip and prints the saved path (or writes JSON with `--json`). Options: `--screen <index>` (default `0`), `--duration <ms|10s>` (default `10000`), `--fps <fps>` (default `10`), `--no-audio`, `--out <path>`, `--invoke-timeout <ms>` (default `120000`).

Camera and Canvas commands have their own docs: [Camera nodes](/nodes/camera), [Canvas](/platforms/mac/canvas). Canvas is implemented by the bundled experimental Canvas plugin; core keeps `openclaw nodes canvas` as a compatibility mount point.

## Related

- [CLI reference](/cli)
- [Nodes](/nodes)
