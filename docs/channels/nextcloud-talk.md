---
summary: "Nextcloud Talk support status, capabilities, and configuration"
read_when:
  - Working on Nextcloud Talk channel features
title: "Nextcloud Talk"
---

Nextcloud Talk is a downloadable channel plugin (`@openclaw/nextcloud-talk`) that connects OpenClaw to a self-hosted Nextcloud instance through a Talk webhook bot. Direct messages, rooms, reactions, and markdown messages are supported; media goes out as URLs.

## Install

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Use the bare package spec to follow the current official release tag. Pin an exact version only when you need a reproducible install.

From a local checkout (dev workflows):

```bash
openclaw plugins install ./path/to/local/nextcloud-talk-plugin
```

Restart the gateway after installing. Details: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. Install the plugin (above).
2. On your Nextcloud server, create a bot:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature webhook --feature response --feature reaction
   ```

   Keep `--feature response`: without it, outbound replies fail with 401. Repair an existing bot with `./occ talk:bot:state --feature webhook --feature response --feature reaction <botId> 1`.

3. Enable the bot in the target room settings.
4. Configure OpenClaw:
   - Config: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Or env: `NEXTCLOUD_TALK_BOT_SECRET` (default account only)

   CLI setup (`--url`/`--token` are aliases for the explicit fields; `nc-talk` and `nc` work as channel aliases):

   ```bash
   openclaw channels add --channel nextcloud-talk \
     --url https://cloud.example.com \
     --token "<shared-secret>"
   ```

   Equivalent explicit fields:

   ```bash
   openclaw channels add --channel nextcloud-talk \
     --base-url https://cloud.example.com \
     --secret "<shared-secret>"
   ```

   File-backed secret:

   ```bash
   openclaw channels add --channel nextcloud-talk \
     --base-url https://cloud.example.com \
     --secret-file /path/to/nextcloud-talk-secret
   ```

5. Restart the gateway (or finish setup).

Minimal config:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Notes

- Bots cannot initiate DMs. The user must message the bot first.
- The webhook URL must be reachable from the Nextcloud server; set `webhookPublicUrl` when the gateway sits behind a proxy. Webhook requests are HMAC-SHA256 signed with the bot secret; invalid signatures are rejected and rate limited.
- Media uploads are not supported by the bot API; outbound media is appended as an `Attachment: <url>` line.
- The webhook payload does not distinguish DMs from rooms; set `apiUser` + `apiPassword` to enable room-type lookups (cached about 5 minutes). Without them, every conversation is treated as a room.
- Outbound requests go through the SSRF guard. For a Nextcloud host on a trusted private/internal network, opt in with `channels.nextcloud-talk.network.dangerouslyAllowPrivateNetwork: true`.
- With `apiUser`/`apiPassword` and `webhookPublicUrl` set, `openclaw channels status` probes the bot and warns when the `response` feature is missing.

## Access control (DMs)

- Default: `channels.nextcloud-talk.dmPolicy = "pairing"`. Unknown senders get a pairing code.
- Approve via:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Public DMs: `channels.nextcloud-talk.dmPolicy="open"` plus `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` matches Nextcloud user IDs only (lowercased); display names are ignored.

## Rooms (groups)

- Default: `channels.nextcloud-talk.groupPolicy = "allowlist"` (mention-gated).
- Allowlist rooms with `channels.nextcloud-talk.rooms`, keyed by room token; `"*"` sets a wildcard default:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Per-room keys: `requireMention` (default true), `enabled` (false disables the room), `allowFrom` (per-room sender allowlist), `tools` (allow/deny tool overrides), `skills` (limit loaded skills), `systemPrompt`.
- To allow no rooms, keep the allowlist empty or set `channels.nextcloud-talk.groupPolicy="disabled"`.

## Capabilities

| Feature         | Status        |
| --------------- | ------------- |
| Direct messages | Supported     |
| Rooms           | Supported     |
| Threads         | Not supported |
| Media           | URL-only      |
| Reactions       | Supported     |
| Native commands | Not supported |

## Configuration reference (Nextcloud Talk)

Full configuration: [Configuration](/gateway/configuration)

Provider options:

- `channels.nextcloud-talk.enabled`: enable/disable channel startup.
- `channels.nextcloud-talk.baseUrl`: Nextcloud instance URL.
- `channels.nextcloud-talk.botSecret`: bot shared secret (string or secret reference).
- `channels.nextcloud-talk.botSecretFile`: regular-file secret path. Symlinks are rejected.
- `channels.nextcloud-talk.apiUser`: API user for room lookups (DM detection) and the status probe.
- `channels.nextcloud-talk.apiPassword`: API/app password for room lookups.
- `channels.nextcloud-talk.apiPasswordFile`: API password file path.
- `channels.nextcloud-talk.webhookPort`: webhook listener port (default: 8788).
- `channels.nextcloud-talk.webhookHost`: webhook host (default: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: webhook path (default: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: externally reachable webhook URL.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing). `open` requires `allowFrom=["*"]`.
- `channels.nextcloud-talk.allowFrom`: DM allowlist (user IDs).
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled` (default: allowlist).
- `channels.nextcloud-talk.groupAllowFrom`: room sender allowlist (user IDs); falls back to `allowFrom` when unset.
- `channels.nextcloud-talk.rooms`: per-room settings and allowlist (see above).
- Static sender access groups can be referenced from `allowFrom` and `groupAllowFrom` with `accessGroup:<name>`.
- `channels.nextcloud-talk.historyLimit`: group history limit (0 disables).
- `channels.nextcloud-talk.dmHistoryLimit`: DM history limit (0 disables).
- `channels.nextcloud-talk.dms`: per-DM overrides keyed by user ID (`historyLimit`).
- `channels.nextcloud-talk.textChunkLimit`: outbound text chunk size in chars (default: 4000).
- `channels.nextcloud-talk.streaming.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.
- `channels.nextcloud-talk.streaming.block.enabled`: enable or disable block streaming for this channel.
- `channels.nextcloud-talk.streaming.block.coalesce`: block streaming coalesce tuning.
- `channels.nextcloud-talk.responsePrefix`: outbound reply prefix.
- `channels.nextcloud-talk.markdown.tables`: markdown table rendering mode (`off | bullets | code | block`).
- `channels.nextcloud-talk.mediaMaxMb`: inbound media cap (MB).
- `channels.nextcloud-talk.network.dangerouslyAllowPrivateNetwork`: allow private/internal Nextcloud hosts past the SSRF guard.
- `channels.nextcloud-talk.accounts.<id>`: per-account overrides (same keys); `defaultAccount` picks the default. Env vars `NEXTCLOUD_TALK_BOT_SECRET` / `NEXTCLOUD_TALK_API_PASSWORD` apply to the default account only.

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
