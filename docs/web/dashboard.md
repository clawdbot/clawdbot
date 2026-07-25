---
summary: "Gateway dashboard (Control UI) access and auth"
read_when:
  - Changing dashboard authentication or exposure modes
title: "Dashboard"
---

The Gateway dashboard is the browser Control UI served at `/` by default (override with `gateway.controlUi.basePath`).

Quick open (local Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/))
- With `gateway.tls.enabled: true`, use `https://127.0.0.1:18789/` and `wss://127.0.0.1:18789` for the WebSocket endpoint.

Key references:

- [Control UI](/web/control-ui) for usage and UI capabilities.
- [Tailscale](/gateway/tailscale) for Serve/Funnel automation.
- [Web surfaces](/web) for bind modes and security notes.

Auth is enforced at the WebSocket handshake via the configured gateway auth path:

- `connect.params.auth.token`
- `connect.params.auth.password`
- Tailscale Serve identity headers when `gateway.auth.allowTailscale: true`
- trusted-proxy identity headers when `gateway.auth.mode: "trusted-proxy"`

See `gateway.auth` in [Gateway configuration](/gateway/configuration).

<Warning>
The Control UI is an **admin surface** (chat, config, exec approvals). Do not expose it publicly. The UI keeps dashboard URL tokens in sessionStorage for the current browser tab and selected gateway URL, and strips them from the URL after load. Prefer localhost, Tailscale Serve, or an SSH tunnel.
</Warning>

## Fast path (recommended)

- After onboarding, the CLI auto-opens the dashboard and prints a clean (non-tokenized) link.
- Re-open anytime: `openclaw dashboard` (copies the link, opens a browser if possible, prints an SSH hint if headless).
- If clipboard and browser delivery both fail, `openclaw dashboard` still prints the clean URL and tells you to append your token (from `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.token`) as the URL fragment key `token`; it never prints the token value in logs.
- If the UI prompts for shared-secret auth, paste the configured token or password into Control UI settings.

## Auth basics (local vs remote)

- **Localhost**: open `http://127.0.0.1:18789/`.
- **Gateway TLS**: when `gateway.tls.enabled: true`, dashboard/status links use `https://` and Control UI WebSocket links use `wss://`.
- **Shared-secret token source**: `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`). `openclaw dashboard` can pass it via URL fragment for one-time bootstrap; the Control UI keeps it in sessionStorage for the current tab and selected gateway URL, not localStorage.
- **Missing-config runtime token**: if startup says it generated a runtime token, that token is ephemeral and is not available through `openclaw config get gateway.auth.token`. Loopback still requires auth. Run `openclaw doctor --generate-gateway-token`, restart the Gateway, then paste the configured token in Control UI settings.
- If `gateway.auth.token` is SecretRef-managed, `openclaw dashboard` prints/copies/opens a non-tokenized URL by design, to avoid exposing externally managed tokens in shell logs, clipboard history, or browser-launch arguments. If the ref is unresolved in your current shell, it still prints the non-tokenized URL plus actionable auth setup guidance.
- **Shared-secret password**: use the configured `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`). The dashboard does not persist passwords across reloads.
- **Identity-bearing modes**: Tailscale Serve satisfies Control UI/WebSocket auth via identity headers when `gateway.auth.allowTailscale: true`; a non-loopback identity-aware reverse proxy satisfies `gateway.auth.mode: "trusted-proxy"`. Neither needs a pasted shared secret for the WebSocket.
- **Not localhost**: use Tailscale Serve, a non-loopback shared-secret bind, a non-loopback identity-aware reverse proxy with `gateway.auth.mode: "trusted-proxy"`, or an SSH tunnel. HTTP APIs still use shared-secret auth unless you intentionally run private-ingress `gateway.auth.mode: "none"` or trusted-proxy HTTP auth. See [Web surfaces](/web).

## Open in Telegram

Telegram bots can open the dashboard as a Telegram Mini App with `/dashboard`.

Requirements:

- `gateway.tailscale.mode: "serve"` or `"funnel"` so Telegram gets an HTTPS Mini App URL.
- The Telegram sender must be the bot owner: a numeric Telegram user ID in `commands.ownerAllowFrom` or the selected account's effective `channels.telegram.allowFrom`.
- Run `/dashboard` in a DM with the bot. Group invocations only tell you to open the command in DM and do not include a button.
- Docker installs: Serve/Funnel modes require the gateway to bind loopback next to `tailscaled`, which bridge networking with published ports cannot satisfy. Run the gateway container with `network_mode: host` and mount the host `tailscaled` socket (`/var/run/tailscale`) plus the `tailscale` CLI into the container.

The Mini App performs a one-time owner handoff and redirects to Control UI with a short-lived bootstrap token. It does not expose a shared gateway token in the URL.

Non-goals for v1:

- Telegram Web iframe is unsupported.
- Tailscale Serve/Funnel is the only supported published URL path.

<a id="if-you-see-unauthorized-1008"></a>

## If you see "unauthorized" / 1008

- Confirm the gateway is reachable: local `openclaw status`; remote, SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 user@gateway-host` then open `http://127.0.0.1:18789/`.
- For `AUTH_TOKEN_MISMATCH`, clients may do one trusted retry with a cached device token when the gateway returns retry hints; that retry reuses the token's cached approved scopes (explicit `deviceToken`/`scopes` callers keep their requested scope set). If auth still fails after that retry, resolve token drift manually.
- For `AUTH_SCOPE_MISMATCH`, the device token was recognized but does not carry the requested scopes; re-pair or approve the new scope set instead of rotating the shared gateway token.
- Outside that retry path, connect auth precedence is: explicit shared token/password, then explicit `deviceToken`, then stored device token, then bootstrap token.
- On the async Tailscale Serve path, failed attempts for the same `{scope, ip}` are serialized before the failed-auth limiter records them, so a second concurrent bad retry can already show `retry later`.
- For token drift repair steps, see [Token drift recovery checklist](/cli/devices#token-drift-recovery-checklist).
- Retrieve or supply the shared secret from the gateway host:
  - Token: `openclaw config get gateway.auth.token`
  - Password: resolve the configured `gateway.auth.password` or `OPENCLAW_GATEWAY_PASSWORD`
  - SecretRef-managed token: resolve the external secret provider, or export `OPENCLAW_GATEWAY_TOKEN` in this shell and rerun `openclaw dashboard`
  - Runtime token generated because no shared secret was configured: run `openclaw doctor --generate-gateway-token`, restart the Gateway, then use the configured token
- In the dashboard settings, paste the token or password into the auth field, then connect.
- The UI language picker lives in **Settings -> General -> Language**, not under Appearance.

## Related

- [Control UI](/web/control-ui)
- [WebChat](/web/webchat)
