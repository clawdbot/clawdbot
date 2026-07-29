---
summary: "Detect the Mac you most recently used and route node alerts there"
read_when:
  - You want OpenClaw to identify the active Mac
  - You are debugging last-input activity or active-node selection
  - You want to understand node connection notification routing
title: "Active computer presence"
---

Active computer presence tells the Gateway which connected macOS node received
the most recent physical mouse or keyboard input. OpenClaw uses that signal to
mark one Mac as `active`, give the agent a stable active-node hint, and route
node connection alerts to the computer where you are most likely present.

This is separate from [system presence](/concepts/presence), which is the live
roster of Gateway clients, and from durable `node.presence.alive` beacons, which
record when a mobile node last woke without treating it as connected.

## Requirements

- The OpenClaw macOS app is paired and connected in node mode.
- **Settings -> Permissions -> Active computer detection** is enabled. It is off by default.
- **Accessibility** permission is granted to the signed OpenClaw app.
- For connection alerts, **Notifications** permission is also granted and the
  Mac node exposes `system.notify`.

Activity reporting is currently implemented by the native macOS node. iOS,
Android, watchOS, and headless node hosts can report connection or background
last-seen state, but they do not compete for the active-computer designation.

## Check the active computer

1. In the macOS app, open **Settings -> Permissions**, enable
   **Active computer detection**, and grant **Accessibility** in macOS System Settings.
2. Confirm the Mac node is connected:

   ```bash
   openclaw nodes status --connected
   ```

3. Move the mouse or press a key on that Mac, then run:

   ```bash
   openclaw nodes status
   openclaw nodes describe --node <node-id-or-name>
   ```

The freshest eligible Mac is marked `active`. Status output shows its last-input
age; `describe` exposes `active`, `lastActiveAtMs`, and `presenceUpdatedAtMs`.
Activity is intentionally coalesced, so the display may take up to about 15
seconds to reflect another input after a recent report.

## How activity becomes presence

The macOS reporter samples the HID system idle clock every two seconds. It
reports once when a node connection becomes ready, then reports newer physical
activity no more than once every 15 seconds. While idle, it sends a keepalive
every three minutes. Idle duration is capped at 30 days so a very old sample
cannot drift forward and incorrectly become the newest computer.

Disabling **Active computer detection** stops sampling and sends an authenticated
clear event over the current node connection. The Gateway immediately removes
that Mac's retained activity timestamps and recomputes the active computer;
other node capabilities and in-flight work stay connected. If the connected
Gateway predates this clear action, the Mac node reconnects once so disconnect
cleanup can remove the retained activity instead.

The Gateway accepts activity only when all of these are true:

- the event belongs to the current authenticated connection for that node id;
- the node has effective `accessibility: true` permission;
- the payload contains a bounded integer `idleSeconds` value.

The Gateway subtracts `idleSeconds` from its own observation time to derive
`lastActiveAtMs`. It never trusts a node-supplied wall-clock timestamp. Among
connected eligible Macs, the newest `lastActiveAtMs` wins; a tie uses the most
recent presence update.

Presence is process-local and connection-bound. Disconnecting the current
session, replacing it with another session using the same node id, or revoking
Accessibility clears that node's activity state and recomputes the active Mac.

## Privacy and model context

Activity sharing is off by default and is separate from the Accessibility grant
used for UI automation. OpenClaw sends idle duration, not input content. It does not send key values,
mouse coordinates, application names, window titles, or raw input events. The
macOS reporter reads the hardware HID state, so synthetic computer-control
events do not make an automated Mac appear to be the computer you physically
used.

Continuous activity does not create model-facing system events. The dynamic
runtime line contains only the authenticated node id:

```text
active_node=<node-id>
```

Exact timestamps and node-controlled display names stay out of the prompt to
avoid prompt injection and cache churn. When the agent needs current details,
the `nodes` tool can read `node.list` or `node.describe` instead.

## How connection alerts are routed

After a node finishes its first successful Gateway handshake after approval,
OpenClaw waits 750 milliseconds so the connecting Mac can submit its first
activity sample. It then tries the connected notification-capable Mac with the
freshest activity.

- If primary delivery succeeds, no other Mac receives the alert.
- If no active Mac is available or primary delivery fails, OpenClaw waits five
  seconds and tries every remaining connected Mac that exposes `system.notify`.
- Later reconnects are silent. The Gateway records the successful connection
  in pairing metadata, so a Gateway restart does not replay alerts for every
  previously connected node.

Alerts are bound to the authenticated node identity. A replacement session for
the same node takes over its pending first-connection alert; if that node is no
longer connected when delivery runs, the alert is canceled.

## Troubleshooting

| Symptom                                   | Check                                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No row is marked `active`                 | Confirm active computer detection is enabled, a native macOS node is connected, and `openclaw nodes describe --node <id>` shows `permissions.accessibility: true`.   |
| The wrong Mac remains active              | Use that Mac physically, wait for the coalescing window, then rerun `openclaw nodes status`. Synthetic computer-control actions do not count.                        |
| Last-input data disappears                | Check whether the Mac disconnected, its node session was replaced, or Accessibility was revoked. Each condition intentionally clears activity.                       |
| The alert appears on several Macs         | Primary delivery was unavailable or failed, so the delayed fallback ran. Verify that the active Mac is connected, allows notifications, and exposes `system.notify`. |
| The agent does not mention the active Mac | Start a new turn after activity changes. The runtime hint is stable and compact; use the `nodes` tool for exact current metadata.                                    |

For TCC recovery, see [macOS permissions](/platforms/mac/permissions). For node
connection and command failures, see [Node troubleshooting](/nodes/troubleshooting).

## Related

- [Nodes](/nodes)
- [Nodes CLI](/cli/nodes)
- [System presence](/concepts/presence)
- [Gateway protocol](/gateway/protocol#presence)
- [macOS app](/platforms/macos)
