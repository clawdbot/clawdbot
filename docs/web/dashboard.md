---
summary: "Gateway dashboard (Control UI) access and auth"
read_when:
  - Changing dashboard authentication or exposure modes
---
# Dashboard (Control UI)

The Gateway dashboard is the browser Control UI served at `/` by default
(override with `gateway.controlUi.basePath`).

Quick open (local Gateway):
- http://127.0.0.1:18789/ (or http://localhost:18789/)

Key references:
- [Control UI](/web/control-ui) for usage and UI capabilities.
- [Tailscale](/gateway/tailscale) for Serve/Funnel automation.
- [Web surfaces](/web) for bind modes and security notes.

Authentication is enforced at the WebSocket handshake via `connect.params.auth`
(token or password). See `gateway.auth` in [Gateway configuration](/gateway/configuration).

Security note: the Control UI is an **admin surface** (chat, config, exec approvals).
Do not expose it publicly. The UI stores the token in `localStorage` after first load.
Prefer localhost, Tailscale Serve, or an SSH tunnel.

## Fast path (recommended)

- After onboarding, the CLI now auto-opens the dashboard with your token and prints the same tokenized link.
- Re-open anytime: `moltbot dashboard` (copies link, opens browser if possible, shows SSH hint if headless).
- The token stays local (query param only); the UI strips it after first load and saves it in localStorage.

## Token basics (local vs remote)

- **Localhost**: open `http://127.0.0.1:18789/`. If you see “unauthorized,” run `moltbot dashboard` and use the tokenized link (`?token=...`).
- **Token source**: `gateway.auth.token` (or `CLAWDBOT_GATEWAY_TOKEN`); the UI stores it after first load.
- **Not localhost**: use Tailscale Serve (tokenless if `gateway.auth.allowTailscale: true`), tailnet bind with a token, or an SSH tunnel. See [Web surfaces](/web).

## If you see “unauthorized” / 1008

- Run `moltbot dashboard` to get a fresh tokenized link.
- Ensure the gateway is reachable (local: `moltbot status`; remote: SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/?token=...`).
- In the dashboard settings, paste the same token you configured in `gateway.auth.token` (or `CLAWDBOT_GATEWAY_TOKEN`).
