---
summary: "How the macOS app reports gateway/channel health states"
read_when:
  - Debugging mac app health indicators
title: "Health checks (macOS)"
---

# Health checks on macOS

How to read the linked-channel health state from the menu bar app.

## Menu bar

Status dot:

- Green: linked + probe healthy.
- Orange: linked but a channel probe reports degraded/not connected.
- Red: not linked yet.

The secondary line reads "linked · auth 12m" or shows the failure reason.
"Run Health Check Now" in the menu triggers an on-demand probe.

## Settings

- General tab shows a Health card: status dot, summary line (link state +
  auth age), and an optional failure detail line, with **Retry now** and
  **Open logs** buttons.
- **Channels tab** surfaces per-channel status and controls (login QR,
  logout, probe, last disconnect/error) for WhatsApp and Telegram.

## How the probe works

The app calls the Gateway's `health` RPC over its existing WebSocket
connection (not a CLI shell-out) every ~60s and on demand. The RPC loads
creds and reports status without sending messages. The app caches the last
good snapshot and the last error separately so the UI loads instantly and
does not flicker while offline.

## When in doubt

Use the CLI flow in [Gateway health](/gateway/health) (`openclaw status`,
`openclaw status --deep`, `openclaw health --json`) and run
`openclaw logs --follow`, filtering for `web-heartbeat` / `web-reconnect`.

## Related

- [Gateway health](/gateway/health)
- [macOS app](/platforms/macos)
