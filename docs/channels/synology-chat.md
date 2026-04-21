---
summary: "Synology Chat webhook setup and OpenClaw config"
read_when:
  - Setting up Synology Chat with OpenClaw
  - Debugging Synology Chat webhook routing
title: "Synology Chat"
---

# Synology Chat

Status: bundled plugin direct-message channel using Synology Chat webhooks.
The plugin accepts inbound messages from Synology Chat outgoing webhooks and sends replies
through a Synology Chat incoming webhook.

## Bundled plugin

Synology Chat ships as a bundled plugin in current OpenClaw releases, so normal
packaged builds do not need a separate install.

If you are on an older build or a custom install that excludes Synology Chat,
install it manually:

Install from a local checkout:

```bash
openclaw plugins install ./path/to/local/synology-chat-plugin
```

Details: [Plugins](/tools/plugin)

## Quick setup

1. Ensure the Synology Chat plugin is available.
   - Current packaged OpenClaw releases already bundle it.
   - Older/custom installs can add it manually from a source checkout with the command above.
   - `openclaw onboard` now shows Synology Chat in the same channel setup list as `openclaw channels add`.
   - Non-interactive setup: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
2. In Synology Chat integrations:
   - Create an incoming webhook and copy its URL.
   - Create an outgoing webhook with your secret token.
3. Point the outgoing webhook URL to your OpenClaw gateway:
   - `https://gateway-host/webhook/synology` by default.
   - Or your custom `channels.synology-chat.webhookPath`.
4. Finish setup in OpenClaw.
   - Guided: `openclaw onboard`
   - Direct: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
5. Restart gateway and send a DM to the Synology Chat bot.

Webhook auth details:

- OpenClaw accepts the outgoing webhook token from `body.token`, then
  `?token=...`, then headers.
- Accepted header forms:
  - `x-synology-token`
  - `x-webhook-token`
  - `x-openclaw-token`
  - `Authorization: Bearer <token>`
- Empty or missing tokens fail closed.

Minimal config:

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "synology-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
      webhookPath: "/webhook/synology",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
      rateLimitPerMinute: 30,
      allowInsecureSsl: false,
    },
  },
}
```

## Environment variables

For the default account, you can use env vars:

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS` (comma-separated)
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

Config values override env vars.

## DM policy and access control

- `dmPolicy: "allowlist"` is the recommended default.
- `allowedUserIds` accepts a list (or comma-separated string) of Synology user IDs.
- In `allowlist` mode, an empty `allowedUserIds` list is treated as misconfiguration and the webhook route will not start (use `dmPolicy: "open"` for allow-all).
- `dmPolicy: "open"` allows any sender.
- `dmPolicy: "disabled"` blocks DMs.
- Reply recipient binding stays on stable numeric `user_id` by default. `channels.synology-chat.dangerouslyAllowNameMatching: true` is break-glass compatibility mode that re-enables mutable username/nickname lookup for reply delivery.
- Pairing approvals work with:
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

## Outbound delivery

Use numeric Synology Chat user IDs as targets.

Examples:

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello from OpenClaw"
openclaw message send --channel synology-chat --target synology-chat:123456 --text "Hello again"
```

Media sends are supported by URL-based file delivery.
Outbound file URLs must use `http` or `https`, and private or otherwise blocked network targets are rejected before OpenClaw forwards the URL to the NAS webhook.

## Multi-account

Multiple Synology Chat accounts are supported under `channels.synology-chat.accounts`.
Each account can override token, incoming URL, webhook path, DM policy, and limits.
Direct-message sessions are isolated per account and user, so the same numeric `user_id`
on two different Synology accounts does not share transcript state.
Give each enabled account a distinct `webhookPath`. OpenClaw now rejects duplicate exact paths
and refuses to start named accounts that only inherit a shared webhook path in multi-account setups.
If you intentionally need legacy inheritance for a named account, set
`dangerouslyAllowInheritedWebhookPath: true` on that account or at `channels.synology-chat`,
but duplicate exact paths are still rejected fail-closed. Prefer explicit per-account paths.

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      accounts: {
        default: {
          token: "token-a",
          incomingUrl: "https://nas-a.example.com/...token=...",
        },
        alerts: {
          token: "token-b",
          incomingUrl: "https://nas-b.example.com/...token=...",
          webhookPath: "/webhook/synology-alerts",
          dmPolicy: "allowlist",
          allowedUserIds: ["987654"],
        },
      },
    },
  },
}
```

## Security notes

- Keep `token` secret and rotate it if leaked.
- Keep `allowInsecureSsl: false` unless you explicitly trust a self-signed local NAS cert.
- Inbound webhook requests are token-verified and rate-limited per sender.
- Invalid token checks use constant-time secret comparison and fail closed.
- Prefer `dmPolicy: "allowlist"` for production.
- Keep `dangerouslyAllowNameMatching` off unless you explicitly need legacy username-based reply delivery.
- Keep `dangerouslyAllowInheritedWebhookPath` off unless you explicitly accept shared-path routing risk in a multi-account setup.

## Troubleshooting

- `Missing required fields (token, user_id, text)`:
  - the outgoing webhook payload is missing one of the required fields
  - if Synology sends the token in headers, make sure the gateway/proxy preserves those headers
- `Invalid token`:
  - the outgoing webhook secret does not match `channels.synology-chat.token`
  - the request is hitting the wrong account/webhook path
  - a reverse proxy stripped the token header before the request reached OpenClaw
- `Rate limit exceeded`:
  - too many invalid token attempts from the same source can temporarily lock that source out
  - authenticated senders also have a separate per-user message rate limit
- `Allowlist is empty. Configure allowedUserIds or use dmPolicy=open.`:
  - `dmPolicy="allowlist"` is enabled but no users are configured
- `User not authorized`:
  - the sender's numeric `user_id` is not in `allowedUserIds`

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
