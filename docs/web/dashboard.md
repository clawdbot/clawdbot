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

- After onboarding, the CLI auto-opens the dashboard and prints a clean link.
- Re-open or repair a browser anytime: `openclaw dashboard`. It copies/opens a single-use pairing link
  that grants administrator access to that exact signed browser, including recovery from a previously
  limited credential, without granting blanket remote auto-approval.
- If clipboard and browser delivery both fail, `openclaw dashboard` either gives a safe manual-token
  hint or tells you to run `openclaw dashboard --json` and open its short-lived `browserUrl`; it never
  prints the shared token value in interactive logs.
- If the UI prompts for shared-secret auth, paste the configured token or password into Control UI settings.

## Auth basics (local vs remote)

- **Localhost**: open `http://127.0.0.1:18789/`.
- **Gateway TLS**: when `gateway.tls.enabled: true`, dashboard/status links use `https://` and Control UI WebSocket links use `wss://`.
- **Shared-secret token source**: `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`). Manual token entry
  is kept in sessionStorage for the current tab and selected gateway URL, not localStorage.
- **Host-authorized browser handoff**: `openclaw dashboard` issues a short-lived, single-use bootstrap
  instead of putting the shared Gateway token in the browser launch URL. The bootstrap is bound to
  that browser's signed device identity and exchanged for a durable administrator credential. A
  different browser profile cannot redeem the same handoff or inherit the resulting access.
- **Missing-config runtime token**: if startup says it generated a runtime token, that token is ephemeral and cannot be recovered. Loopback still requires auth. Run `openclaw doctor --generate-gateway-token`, restart the Gateway, then run `openclaw gateway auth-token --show` in an interactive terminal and paste the output into Control UI settings.
- If `gateway.auth.token` is SecretRef-managed, the interactive dashboard handoff still works because
  it carries only the short-lived browser bootstrap; the external shared token is not placed in
  terminal output, clipboard history, or browser-launch arguments.
- **Shared-secret password**: use the configured `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`). The dashboard does not persist passwords across reloads.
- **Identity-bearing modes**: Tailscale Serve satisfies Control UI/WebSocket auth via identity headers when `gateway.auth.allowTailscale: true`; a non-loopback identity-aware reverse proxy satisfies `gateway.auth.mode: "trusted-proxy"`. Neither needs a pasted shared secret for the WebSocket.
- **Not localhost**: use Tailscale Serve, a non-loopback shared-secret bind, a non-loopback identity-aware reverse proxy with `gateway.auth.mode: "trusted-proxy"`, or an SSH tunnel. HTTP APIs still use shared-secret auth unless you intentionally run private-ingress `gateway.auth.mode: "none"` or trusted-proxy HTTP auth. See [Web surfaces](/web).

## Automatic browser handoff

An identity-aware HTTPS host can provide automatic login for direct dashboard links while
keeping the Gateway's existing token and device authentication. After an initial connection
fails because authentication is missing, the Control UI makes one same-origin request to
`GET /.well-known/openclaw/browser-bootstrap` (under the Control UI base path, if configured).
Existing credentials are tried first. Explicit credentials, remote Gateway selections,
pairing failures, and rejected credentials do not trigger this recovery.

This endpoint belongs to the deployment's authenticated proxy or handoff service. OpenClaw
does not expose an unauthenticated credential issuer. The service must independently verify
the browser's identity and authorization before using the host's `openclaw dashboard --json`
handoff. Return only its single-use browser credential:

```json
{ "bootstrapToken": "<single-use-browser-bootstrap>", "bootstrapProfile": "owner" }
```

Use `Content-Type: application/json` and `Cache-Control: no-store`, reject cross-origin
requests, and never return the shared Gateway token. The UI rejects redirects, responses
larger than 8 KiB, and tokens longer than 4096 printable ASCII characters. The request has
a 45-second deadline and is cancelled if the connection changes or the page stops.
Successful recovery preserves the current dashboard route. If no endpoint is configured or
the host declines the request, the existing login instructions remain available.

## Open in Telegram

Telegram bots can open the dashboard as a Telegram Mini App with `/dashboard`.

Requirements:

- `gateway.tailscale.mode: "serve"` or `"funnel"` so Telegram gets an HTTPS Mini App URL.
- The Telegram sender must be the bot owner: a numeric Telegram user ID in `commands.ownerAllowFrom` or the selected account's effective `channels.telegram.allowFrom`.
- Run `/dashboard` in a DM with the bot. Group invocations only tell you to open the command in DM and do not include a button.
- Docker installs: Serve/Funnel modes require the gateway to bind loopback next to `tailscaled`, which bridge networking with published ports cannot satisfy. Run the gateway container with `network_mode: host` and mount the host `tailscaled` socket (`/var/run/tailscale`) plus the `tailscale` CLI into the container.

The Mini App performs a bounded one-time dashboard handoff and redirects to Control UI with a
short-lived bootstrap token. It does not expose a shared gateway token in the URL, and it does not
receive the administrator grant reserved for handoffs issued directly by the Gateway host.

Non-goals for v1:

- Telegram Web iframe is unsupported.
- Tailscale Serve/Funnel is the only supported published URL path.

<a id="if-you-see-unauthorized-1008"></a>

## If you see "unauthorized" / 1008

- Confirm the gateway is reachable: local `openclaw status`; remote, SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 user@gateway-host` then open `http://127.0.0.1:18789/`.
- For `AUTH_TOKEN_MISMATCH`, clients may do one trusted retry with a cached device token when the gateway returns retry hints; that retry reuses the token's cached approved scopes (explicit `deviceToken`/`scopes` callers keep their requested scope set). If auth still fails after that retry, resolve token drift manually.
- For `AUTH_SCOPE_MISMATCH`, the device token was recognized but does not carry the requested scopes; re-pair or approve the new scope set instead of rotating the shared gateway token.
- For **Proxy authentication required** or `AUTH_IDENTITY_HEADER_REQUIRED`, open the configured proxy/SSO dashboard URL and sign in there. Ask the Gateway administrator to check identity-header forwarding on WebSocket upgrades and account access. A Gateway token cannot override trusted-proxy mode; see [Trusted proxy troubleshooting](/gateway/trusted-proxy-auth#control-ui-says-proxy-authentication-required).
- Outside that retry path, the Control UI prefers a pending bootstrap token so a fresh host-issued handoff can create or upgrade the browser credential. Without a pending bootstrap, explicit shared token/password take precedence over the stored device token.
- On the async Tailscale Serve path, failed attempts for the same `{scope, ip}` are serialized before the failed-auth limiter records them, so a second concurrent bad retry can already show `retry later`.
- For token drift repair steps, see [Token drift recovery checklist](/cli/devices#token-drift-recovery-checklist).
- For shared-secret authentication, retrieve or supply the configured secret from the gateway host:
  - Token: run `openclaw gateway auth-token --show` in an interactive terminal on the Gateway host
  - Password: resolve the configured `gateway.auth.password` or `OPENCLAW_GATEWAY_PASSWORD`
  - SecretRef-managed token: run `openclaw gateway auth-token --show`; if resolution fails, repair the external secret provider and rerun it
  - Runtime token generated because no shared secret was configured: run `openclaw doctor --generate-gateway-token`, restart the Gateway, then use the configured token
- In the dashboard settings, paste the token or password into the auth field, then connect.
- The UI language picker lives in **Settings → Appearance → Language**.

## Related

- [Control UI](/web/control-ui)
- [WebChat](/web/webchat)
