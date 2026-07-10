---
summary: "Troubleshoot node pairing, foreground requirements, permissions, and tool failures"
read_when:
  - Node is connected but camera/canvas/screen/exec tools fail
  - You need the node pairing versus approvals mental model
title: "Node troubleshooting"
---

Use this page when a node is visible in status but node tools fail.

## Command ladder

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Then run node-specific checks:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Healthy signals:

- Node is connected and paired for role `node`.
- `nodes describe` includes the capability you're calling.
- Exec approvals show the expected mode/allowlist.

## Foreground requirements

`canvas.*`, `camera.*`, and `screen.*` are foreground-only on iOS/Android nodes.

Quick check and fix:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

If you see `NODE_BACKGROUND_UNAVAILABLE`, bring the node app to the foreground and retry.

## Permissions matrix

| Capability                   | iOS                                     | Android                                      | macOS node app                   | Typical failure code                          |
| ---------------------------- | --------------------------------------- | -------------------------------------------- | -------------------------------- | --------------------------------------------- |
| `camera.snap`, `camera.clip` | Camera (+ mic for clip audio)           | Camera (+ mic for clip audio)                | Camera (+ mic for clip audio)    | `*_PERMISSION_REQUIRED`                       |
| `screen.record`              | Screen Recording (+ mic optional)       | Screen capture prompt (+ mic optional)       | Screen Recording                 | `*_PERMISSION_REQUIRED`                       |
| `computer.act`               | n/a                                     | n/a                                          | Accessibility + Screen Recording | `COMPUTER_DISABLED`, `ACCESSIBILITY_REQUIRED` |
| `location.get`               | While Using or Always (depends on mode) | Foreground/Background location based on mode | Location permission              | `LOCATION_PERMISSION_REQUIRED`                |
| `system.run`                 | n/a (node host path)                    | n/a (node host path)                         | Exec approvals required          | `SYSTEM_RUN_DENIED`                           |

## Pairing versus approvals

Three separate gates control whether a node command succeeds:

1. **Device pairing**: can this node connect to the gateway?
2. **Gateway node command policy**: is the RPC command ID allowed by `gateway.nodes.allowCommands` / `denyCommands` and platform defaults?
3. **Exec approvals**: can this node run a specific shell command locally?

Node pairing is an identity/trust gate, not a per-command approval surface. For `system.run`, the per-node policy lives in that node's exec approvals file (`openclaw approvals get --node ...`), not in the gateway pairing record.

Quick checks:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

- Pairing missing: approve the node device first.
- `nodes describe` missing a command: check the gateway node command policy and whether the node actually declared that command on connect.
- Pairing fine but `system.run` fails: fix exec approvals/allowlist on that node.

For approval-backed `host=node` runs, the gateway also binds execution to the prepared canonical `systemRunPlan`. If a later caller mutates the command, cwd, or session metadata before the approved run is forwarded, the gateway rejects the run as an approval mismatch instead of trusting the edited payload.

## Common node error codes

| Code                                   | Meaning                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_BACKGROUND_UNAVAILABLE`          | App is backgrounded; bring it to the foreground.                                                                                                                                        |
| `CAMERA_DISABLED`                      | Camera toggle disabled in node settings.                                                                                                                                                |
| `*_PERMISSION_REQUIRED`                | OS permission missing/denied.                                                                                                                                                           |
| `LOCATION_DISABLED`                    | Location mode is off.                                                                                                                                                                   |
| `LOCATION_PERMISSION_REQUIRED`         | Requested location mode not granted.                                                                                                                                                    |
| `LOCATION_BACKGROUND_UNAVAILABLE`      | App is backgrounded but only While Using permission exists.                                                                                                                             |
| `COMPUTER_DISABLED`                    | Enable **Allow Computer Control** in the macOS app, then approve the pairing update.                                                                                                    |
| `ACCESSIBILITY_REQUIRED`               | Grant Accessibility to the current OpenClaw app bundle in macOS System Settings.                                                                                                        |
| `SYSTEM_RUN_DENIED: approval required` | Exec request needs explicit approval.                                                                                                                                                   |
| `SYSTEM_RUN_DENIED: allowlist miss`    | Command blocked by allowlist mode. On Windows node hosts, shell-wrapper forms like `cmd.exe /c ...` are treated as allowlist misses in allowlist mode unless approved via the ask flow. |

## Fast recovery loop

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

If still stuck:

- Re-approve device pairing.
- Re-open the node app (foreground).
- Re-grant OS permissions.
- Recreate/adjust the exec approval policy.

For computer control, also verify that a vision-capable agent exposes the `computer` tool, `screen.snapshot` succeeds with Screen Recording permission, and `/phone status` shows the temporary or persistent gateway authorization you intended. A `gateway.nodes.denyCommands` entry always overrides `allowCommands`.

## Related

- [Nodes overview](/nodes)
- [Camera nodes](/nodes/camera)
- [Location command](/nodes/location-command)
- [Computer use](/nodes/computer-use)
- [Exec approvals](/tools/exec-approvals)
- [Gateway pairing](/gateway/pairing)
- [Gateway troubleshooting](/gateway/troubleshooting)
- [Channel troubleshooting](/channels/troubleshooting)
