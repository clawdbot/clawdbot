---
summary: "Nextcloud Talk support status, capabilities, and configuration"
read_when:
  - Working on Nextcloud Talk channel features
title: "Nextcloud Talk"
---

Status: bundled plugin (webhook bot). Direct messages, rooms, reactions, and markdown messages are supported.

## Bundled plugin

Nextcloud Talk ships as a bundled plugin in current OpenClaw releases, so
normal packaged builds do not need a separate install.

If you are on an older build or a custom install that excludes Nextcloud Talk,
install the npm package directly:

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Use the bare package to follow the current official release tag. Pin an exact
version only when you need a reproducible install.

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./path/to/local/nextcloud-talk-plugin
```

Details: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. Ensure the Nextcloud Talk plugin is available.
   - Current packaged OpenClaw releases already bundle it.
   - Older/custom installs can add it manually with the commands above.
2. On your Nextcloud server, create a bot:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Enable the bot in the target room settings.
4. Configure OpenClaw:
   - Config: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Or env: `NEXTCLOUD_TALK_BOT_SECRET` (default account only)

   CLI setup:

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
- Webhook URL must be reachable by the Gateway; set `webhookPublicUrl` if behind a proxy.
- Media uploads are not supported by the bot API; media is sent as URLs.
- The webhook payload does not distinguish DMs vs rooms; set `apiUser` + `apiPassword` to enable room-type lookups (otherwise DMs are treated as rooms).

## Access control (DMs)

- Default: `channels.nextcloud-talk.dmPolicy = "pairing"`. Unknown senders get a pairing code.
- Approve via:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Public DMs: `channels.nextcloud-talk.dmPolicy="open"` plus `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` matches Nextcloud user IDs only; display names are ignored.

## Rooms (groups)

- Default: `channels.nextcloud-talk.groupPolicy = "allowlist"` (mention-gated).
- Allowlist rooms with `channels.nextcloud-talk.rooms`:

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
- `channels.nextcloud-talk.botSecret`: bot shared secret.
- `channels.nextcloud-talk.botSecretFile`: regular-file secret path. Symlinks are rejected.
- `channels.nextcloud-talk.apiUser`: API user for room lookups (DM detection).
- `channels.nextcloud-talk.apiPassword`: API/app password for room lookups.
- `channels.nextcloud-talk.apiPasswordFile`: API password file path.
- `channels.nextcloud-talk.webhookPort`: webhook listener port (default: 8788).
- `channels.nextcloud-talk.webhookHost`: webhook host (default: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: webhook path (default: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: externally reachable webhook URL.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM allowlist (user IDs). `open` requires `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: group allowlist (user IDs).
- `channels.nextcloud-talk.rooms`: per-room settings and allowlist.
- `channels.nextcloud-talk.historyLimit`: group history limit (0 disables).
- `channels.nextcloud-talk.dmHistoryLimit`: DM history limit (0 disables).
- `channels.nextcloud-talk.dms`: per-DM overrides (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: outbound text chunk size (chars).
- `channels.nextcloud-talk.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.
- `channels.nextcloud-talk.blockStreaming`: disable block streaming for this channel.
- `channels.nextcloud-talk.blockStreamingCoalesce`: block streaming coalesce tuning.
- `channels.nextcloud-talk.mediaMaxMb`: inbound media cap (MB).

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
