---
summary: "iMessage via BlueBubbles macOS server (REST send/receive, typing, reactions, pairing, advanced actions)."
read_when:
  - Setting up BlueBubbles channel
  - Troubleshooting webhook pairing
  - Configuring iMessage on macOS
---
# BlueBubbles (macOS REST)

Status: bundled plugin that talks to the BlueBubbles macOS server over HTTP. **Recommended for iMessage integration** due to its richer API and easier setup compared to the legacy imsg channel.

## Overview
- Runs on macOS via the BlueBubbles helper app ([bluebubbles.app](https://bluebubbles.app)).
- Recommended/tested: macOS Sequoia (15). macOS Tahoe (26) works; edit is currently broken on Tahoe, and group icon updates may report success but not sync.
- Moltbot talks to it through its REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Incoming messages arrive via webhooks; outgoing replies, typing indicators, read receipts, and tapbacks are REST calls.
- Attachments and stickers are ingested as inbound media (and surfaced to the agent when possible).
- Pairing/allowlist works the same way as other channels (`/start/pairing` etc) with `channels.bluebubbles.allowFrom` + pairing codes.
- Reactions are surfaced as system events just like Slack/Telegram so agents can "mention" them before replying.
- Advanced features: edit, unsend, reply threading, message effects, group management.

## Quick start
1. Install the BlueBubbles server on your Mac (follow the instructions at [bluebubbles.app/install](https://bluebubbles.app/install)).
2. In the BlueBubbles config, enable the web API and set a password.
3. Run `moltbot onboard` and select BlueBubbles, or configure manually:
   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook"
       }
     }
   }
   ```
4. Point BlueBubbles webhooks to your gateway (example: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).
5. Start the gateway; it will register the webhook handler and start pairing.

## Onboarding
BlueBubbles is available in the interactive setup wizard:
```
moltbot onboard
```

The wizard prompts for:
- **Server URL** (required): BlueBubbles server address (e.g., `http://192.168.1.100:1234`)
- **Password** (required): API password from BlueBubbles Server settings
- **Webhook path** (optional): Defaults to `/bluebubbles-webhook`
- **DM policy**: pairing, allowlist, open, or disabled
- **Allow list**: Phone numbers, emails, or chat targets

You can also add BlueBubbles via CLI:
```
moltbot channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Access control (DMs + groups)
DMs:
- Default: `channels.bluebubbles.dmPolicy = "pairing"`.
- Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).
- Approve via:
  - `moltbot pairing list bluebubbles`
  - `moltbot pairing approve bluebubbles <CODE>`
- Pairing is the default token exchange. Details: [Pairing](/start/pairing)

Groups:
- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (default: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` controls who can trigger in groups when `allowlist` is set.

### Mention gating (groups)
BlueBubbles supports mention gating for group chats, matching iMessage/WhatsApp behavior:
- Uses `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`) to detect mentions.
- When `requireMention` is enabled for a group, the agent only responds when mentioned.
- Control commands from authorized senders bypass mention gating.

Per-group configuration:
```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },  // default for all groups
        "iMessage;-;chat123": { requireMention: false }  // override for specific group
      }
    }
  }
}
```

### Command gating
- Control commands (e.g., `/config`, `/model`) require authorization.
- Uses `allowFrom` and `groupAllowFrom` to determine command authorization.
- Authorized senders can run control commands even without mentioning in groups.

## Typing + read receipts
- **Typing indicators**: Sent automatically before and during response generation.
- **Read receipts**: Controlled by `channels.bluebubbles.sendReadReceipts` (default: `true`).
- **Typing indicators**: Moltbot sends typing start events; BlueBubbles clears typing automatically on send or timeout (manual stop via DELETE is unreliable).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false  // disable read receipts
    }
  }
}
```

## Advanced actions
BlueBubbles supports advanced message actions when enabled in config:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true,       // tapbacks (default: true)
        edit: true,            // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true,          // unsend messages (macOS 13+)
        reply: true,           // reply threading by message GUID
        sendWithEffect: true,  // message effects (slam, loud, etc.)
        renameGroup: true,     // rename group chats
        setGroupIcon: true,    // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true,  // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true,      // leave group chats
        sendAttachment: true   // send attachments/media
      }
    }
  }
}
```

Available actions:
- **react**: Add/remove tapback reactions (`messageId`, `emoji`, `remove`)
- **edit**: Edit a sent message (`messageId`, `text`)
- **unsend**: Unsend a message (`messageId`)
- **reply**: Reply to a specific message (`messageId`, `text`, `to`)
- **sendWithEffect**: Send with iMessage effect (`text`, `to`, `effectId`)
- **renameGroup**: Rename a group chat (`chatGuid`, `displayName`)
- **setGroupIcon**: Set a group chat's icon/photo (`chatGuid`, `media`) — flaky on macOS 26 Tahoe (API may return success but the icon does not sync).
- **addParticipant**: Add someone to a group (`chatGuid`, `address`)
- **removeParticipant**: Remove someone from a group (`chatGuid`, `address`)
- **leaveGroup**: Leave a group chat (`chatGuid`)
- **sendAttachment**: Send media/files (`to`, `buffer`, `filename`, `asVoice`)
  - Voice memos: set `asVoice: true` with **MP3** or **CAF** audio to send as an iMessage voice message. BlueBubbles converts MP3 → CAF when sending voice memos.

### Message IDs (short vs full)
Moltbot may surface *short* message IDs (e.g., `1`, `2`) to save tokens.
- `MessageSid` / `ReplyToId` can be short IDs.
- `MessageSidFull` / `ReplyToIdFull` contain the provider full IDs.
- Short IDs are in-memory; they can expire on restart or cache eviction.
- Actions accept short or full `messageId`, but short IDs will error if no longer available.

Use full IDs for durable automations and storage:
- Templates: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Context: `MessageSidFull` / `ReplyToIdFull` in inbound payloads

See [Configuration](/gateway/configuration) for template variables.

## Block streaming
Control whether responses are sent as a single message or streamed in blocks:
```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true  // enable block streaming (default behavior)
    }
  }
}
```

## Media + limits
- Inbound attachments are downloaded and stored in the media cache.
- Media cap via `channels.bluebubbles.mediaMaxMb` (default: 8 MB).
- Outbound text is chunked to `channels.bluebubbles.textChunkLimit` (default: 4000 chars).

## Configuration reference
Full configuration: [Configuration](/gateway/configuration)

Provider options:
- `channels.bluebubbles.enabled`: Enable/disable the channel.
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API base URL.
- `channels.bluebubbles.password`: API password.
- `channels.bluebubbles.webhookPath`: Webhook endpoint path (default: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (default: `pairing`).
- `channels.bluebubbles.allowFrom`: DM allowlist (handles, emails, E.164 numbers, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (default: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: Group sender allowlist.
- `channels.bluebubbles.groups`: Per-group config (`requireMention`, etc.).
- `channels.bluebubbles.sendReadReceipts`: Send read receipts (default: `true`).
- `channels.bluebubbles.blockStreaming`: Enable block streaming (default: `true`).
- `channels.bluebubbles.textChunkLimit`: Outbound chunk size in chars (default: 4000).
- `channels.bluebubbles.chunkMode`: `length` (default) splits only when exceeding `textChunkLimit`; `newline` splits on blank lines (paragraph boundaries) before length chunking.
- `channels.bluebubbles.mediaMaxMb`: Inbound media cap in MB (default: 8).
- `channels.bluebubbles.historyLimit`: Max group messages for context (0 disables).
- `channels.bluebubbles.dmHistoryLimit`: DM history limit.
- `channels.bluebubbles.actions`: Enable/disable specific actions.
- `channels.bluebubbles.accounts`: Multi-account configuration.

Related global options:
- `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Addressing / delivery targets
Prefer `chat_guid` for stable routing:
- `chat_guid:iMessage;-;+15555550123` (preferred for groups)
- `chat_id:123`
- `chat_identifier:...`
- Direct handles: `+15555550123`, `user@example.com`
  - If a direct handle does not have an existing DM chat, Moltbot will create one via `POST /api/v1/chat/new`. This requires the BlueBubbles Private API to be enabled.

## Security
- Webhook requests are authenticated by comparing `guid`/`password` query params or headers against `channels.bluebubbles.password`. Requests from `localhost` are also accepted.
- Keep the API password and webhook endpoint secret (treat them like credentials).
- Localhost trust means a same-host reverse proxy can unintentionally bypass the password. If you proxy the gateway, require auth at the proxy and configure `gateway.trustedProxies`. See [Gateway security](/gateway/security#reverse-proxy-configuration).
- Enable HTTPS + firewall rules on the BlueBubbles server if exposing it outside your LAN.

## Troubleshooting
- If typing/read events stop working, check the BlueBubbles webhook logs and verify the gateway path matches `channels.bluebubbles.webhookPath`.
- Pairing codes expire after one hour; use `moltbot pairing list bluebubbles` and `moltbot pairing approve bluebubbles <code>`.
- Reactions require the BlueBubbles private API (`POST /api/v1/message/react`); ensure the server version exposes it.
- Edit/unsend require macOS 13+ and a compatible BlueBubbles server version. On macOS 26 (Tahoe), edit is currently broken due to private API changes.
- Group icon updates can be flaky on macOS 26 (Tahoe): the API may return success but the new icon does not sync.
- Moltbot auto-hides known-broken actions based on the BlueBubbles server's macOS version. If edit still appears on macOS 26 (Tahoe), disable it manually with `channels.bluebubbles.actions.edit=false`.
- For status/health info: `moltbot status --all` or `moltbot status --deep`.

For general channel workflow reference, see [Channels](/channels) and the [Plugins](/plugins) guide.
