---
summary: "How the macOS app reports gateway/channel health states"
read_when:
  - Debugging mac app health indicators
title: "Health checks (macOS)"
---

# Health checks on macOS

The macOS app reads channel health from the Gateway. Configured channels do
not need a linked-session field to report a healthy state. Explicitly disabled
accounts stay inactive and cannot provide a healthy fallback.

## Menu bar

The menu shows actionable health problems: an orange failure reason or a red
login requirement. Healthy and pending states stay quiet. Opening the menu
refreshes health on demand.

## Settings

- In **Connection** settings, **Local Gateway** shows a health row: status
  dot, channel summary, and an optional failure detail line, with **Retry now** and
  **Open logs** buttons.
- **Channels tab** surfaces per-channel status and controls (login QR,
  logout, probe, last disconnect/error).

The health row uses these states:

- Green: the selected linked or configured channel has no reported failure.
- Orange: a channel or health request reports a failure. An unlinked channel
  also stays orange when another configured channel is healthy.
- Red: linking is required and no healthy configured channel is available.
- Gray: health is pending or the selected channel is disabled or not configured.

The summary can read "Telegram ready", "Telegram running", or
"linked · auth 12m". The app honors the Gateway's startup and reconnect grace
windows; transient transport flags alone do not mark a channel degraded.
Reported failures such as a stale socket or unavailable inbound processing
still take precedence over a ready-looking connection.

A missing HTTP status does not by itself mean a timeout; the app preserves
the Gateway's reported probe error.

## How health refresh works

The app calls the Gateway's `health` RPC over its existing WebSocket
connection (not a CLI shell-out) every ~60s and on demand. This reads the
Gateway's health snapshot; it does not request an active channel probe or
send messages. The app caches the last
good snapshot and the last error separately so the UI loads instantly and
does not flicker while offline.

The health row and **Connected Instances** pane follow the Primary Gateway.
Switching Primary immediately clears the previous Gateway's cached status;
delayed replies from that Gateway cannot replace the new results. Reconnecting
to the same Gateway retains its last good health snapshot while a fresh check
runs. Connection errors stay with the Gateway that reported them.

## When in doubt

Use the CLI flow in [Gateway health](/gateway/health) (`openclaw status`,
`openclaw status --deep`, `openclaw health --json`) and run
`openclaw logs --follow`, filtering for `web-heartbeat` / `web-reconnect`.

## Related

- [Gateway health](/gateway/health)
- [macOS app](/platforms/macos)
