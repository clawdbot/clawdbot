---
summary: "Zalo bot support status, capabilities, and configuration"
read_when:
  - Working on Zalo features or webhooks
title: "Zalo"
---

Status: experimental. Direct messages and group chats are both implemented; the [Capabilities](#capabilities) table below reflects verified behavior on Zalo Bot Creator / Marketplace bots.

## Bundled plugin

Zalo ships as a bundled plugin in current OpenClaw releases, so packaged builds do not need a separate install.

On an older build or a custom install that excludes Zalo, install the npm package directly:

- Install: `openclaw plugins install @openclaw/zalo`
- Pinned version: `openclaw plugins install @openclaw/zalo@2026.6.11`
- From a local checkout: `openclaw plugins install ./path/to/local/zalo-plugin`
- Details: [Plugins](/tools/plugin)

## Quick setup

1. Create a bot token at [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) (sign in, create a bot, configure settings). The token is `numeric_id:secret`; for Marketplace bots the usable runtime token may appear in the bot's welcome message.
2. Set the token, either as env `ZALO_BOT_TOKEN=...` (default account only) or in config.
3. Restart the gateway.
4. Approve the pairing code on first DM contact (default DM policy is pairing).

Minimal config:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      accounts: {
        default: {
          botToken: "12345689:abc-xyz",
          dmPolicy: "pairing",
        },
      },
    },
  },
}
```

Multi-account: add more entries under `channels.zalo.accounts.<id>`, each with its own `botToken`/`name`. `channels.zalo.botToken` (flat, no `accounts`) is a legacy single-account shorthand; prefer `accounts.<id>.*` for new configs.

## What it is

Zalo is a Vietnam-focused messaging app. Its Bot API lets the Gateway run a bot for both 1:1 conversations and group chats, with deterministic routing back to Zalo (the model never chooses channels).

This page covers **Zalo Bot Creator / Marketplace bots**. **Zalo Official Account (OA) bots** are a different product surface and may behave differently; this page does not cover them.

## How it works

- Inbound messages are normalized into the shared channel envelope with media placeholders.
- Replies always route back to the same Zalo chat; quote-reply is not used (`replyToMode` is fixed off).
- Long-polling (`getUpdates`) by default; webhook mode available via `channels.zalo.webhookUrl`.
- Groups require an @mention to trigger the bot; this is not configurable per channel.

## Limits

| Limit                         | Value                                                                    |
| ----------------------------- | ------------------------------------------------------------------------ |
| Outbound text chunk size      | 2000 characters (Zalo API limit)                                         |
| Media size (inbound/outbound) | `channels.zalo.mediaMaxMb`, default `5` MB                               |
| Webhook request body          | 1 MB, 30s read timeout                                                   |
| Webhook rate limit            | 120 requests / 60s per path+client IP, then HTTP 429                     |
| Webhook replay tombstones     | 30 days, up to 20,000 completed events per account (keyed by message id) |

## Access control

### Direct messages

- `channels.zalo.dmPolicy`: `pairing` (default) | `allowlist` | `open` | `disabled`.
- Pairing: unknown senders get a pairing code; messages are ignored until approved. Codes expire after 1 hour.
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
  - Details: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` accepts numeric Zalo user IDs (no username lookup). `open` requires `"*"`.

### Groups

Group chats are supported by the plugin (`chatTypes: ["direct", "group"]`) and gated by mention plus group policy:

- `channels.zalo.groupPolicy`: `open` | `allowlist` | `disabled`.
- `channels.zalo.groupAllowFrom` restricts which sender IDs can trigger the bot in groups; falls back to `allowFrom` when unset.
- Default resolution: when `channels.zalo` is configured, an unset `groupPolicy` resolves to `open`. When `channels.zalo` is missing entirely, runtime fails closed to `allowlist`.
- Reported real-world caveat: on some Marketplace-bot setups the bot could not be added to a group at all. If you hit that, verify with your bot's Zalo Bot Platform settings; it is a platform-side constraint, not an OpenClaw policy.

## Long-polling vs webhook

- Default: long-polling (no public URL required).
- Webhook mode: set `channels.zalo.webhookUrl` and `channels.zalo.webhookSecret`.
  - Webhook URL must use HTTPS.
  - Webhook secret must be 8-256 characters.
  - Zalo sends events with an `X-Bot-Api-Secret-Token` header, checked with a constant-time comparison.
  - Gateway HTTP handles webhook requests at `channels.zalo.webhookPath` (defaults to the webhook URL's path).
  - Requests must use `Content-Type: application/json` (or a `+json` media type).
  - HTTP 200 is returned only after the raw event is durably stored; storage failures return HTTP 500.
  - getUpdates polling and webhook are mutually exclusive per Zalo API docs.

## Supported message types

- Text: full support, chunked to 2000 characters.
- Media: inbound/outbound, capped by `mediaMaxMb`.
- Reactions, threads, polls, native commands: not supported by the plugin.
- Streaming: the plugin declares block-streaming capability, but Zalo has no dedicated outbound queue/merge-text tuning knobs (unlike some other regional channels); verify current behavior in your environment if this matters for your use case.

## Capabilities

| Feature                  | Status                            |
| ------------------------ | --------------------------------- |
| Direct messages          | Supported                         |
| Groups                   | Supported (mention-gated)         |
| Media (inbound/outbound) | Supported, capped by `mediaMaxMb` |
| Reactions                | Not supported                     |
| Threads                  | Not supported                     |
| Polls                    | Not supported                     |
| Native commands          | Not supported                     |
| Reply-to / quote         | Not used (fixed off)              |

## Delivery targets (CLI/cron)

Use a chat ID as the target:

```bash
openclaw message send --channel zalo --target 123456789 --message "hi"
```

## Troubleshooting

**Bot does not respond:**

- Check the token: `openclaw channels status --probe`
- Verify the sender is approved (pairing or `allowFrom`)
- Check gateway logs: `openclaw logs --follow`

**Webhook not receiving events:**

- Confirm the webhook URL uses HTTPS
- Confirm the secret is 8-256 characters
- Confirm the gateway HTTP endpoint is reachable on the configured path
- Confirm getUpdates polling is not also running (they are mutually exclusive)
- A burst of requests can return HTTP 429 (120 requests / 60s per path+IP); back off and retry

## Configuration reference

Full configuration: [Configuration](/gateway/configuration)

| Setting                                      | Description                                       | Default               |
| -------------------------------------------- | ------------------------------------------------- | --------------------- |
| `channels.zalo.enabled`                      | Enable/disable channel startup                    | `true`                |
| `channels.zalo.accounts.<id>.botToken`       | Bot token from Zalo Bot Platform                  | -                     |
| `channels.zalo.accounts.<id>.tokenFile`      | Read token from a file (symlinks rejected)        | -                     |
| `channels.zalo.accounts.<id>.name`           | Display name                                      | -                     |
| `channels.zalo.accounts.<id>.enabled`        | Enable/disable this account                       | `true`                |
| `channels.zalo.accounts.<id>.dmPolicy`       | Per-account DM policy                             | `pairing`             |
| `channels.zalo.accounts.<id>.allowFrom`      | DM allowlist (user IDs)                           | -                     |
| `channels.zalo.accounts.<id>.groupPolicy`    | Per-account group policy                          | see [Groups](#groups) |
| `channels.zalo.accounts.<id>.groupAllowFrom` | Group sender allowlist; falls back to `allowFrom` | -                     |
| `channels.zalo.accounts.<id>.mediaMaxMb`     | Inbound/outbound media cap (MB)                   | `5`                   |
| `channels.zalo.accounts.<id>.webhookUrl`     | Enable webhook mode (HTTPS required)              | -                     |
| `channels.zalo.accounts.<id>.webhookSecret`  | Webhook secret (8-256 chars)                      | -                     |
| `channels.zalo.accounts.<id>.webhookPath`    | Webhook path on the gateway HTTP server           | webhook URL path      |
| `channels.zalo.accounts.<id>.proxy`          | Proxy URL for API requests                        | -                     |
| `channels.zalo.accounts.<id>.responsePrefix` | Outbound response prefix override                 | -                     |
| `channels.zalo.defaultAccount`               | Default account when multiple are configured      | `default`             |

`channels.zalo.botToken`, `channels.zalo.dmPolicy`, and other flat top-level keys are the legacy single-account shorthand for the fields above; both forms are supported.

Env option: `ZALO_BOT_TOKEN=...` resolves the default account's token only.

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
