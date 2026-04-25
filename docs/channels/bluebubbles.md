---
summary: "iMessage via BlueBubbles macOS server (REST send/receive, typing, reactions, pairing, advanced actions)."
read_when:
  - Setting up BlueBubbles channel
  - Troubleshooting webhook pairing
  - Configuring iMessage on macOS
title: "BlueBubbles"
---

Status: bundled plugin that talks to the BlueBubbles macOS server over HTTP. **Recommended for iMessage integration** due to its richer API and easier setup compared to the legacy imsg channel.

## Bundled plugin

Current OpenClaw releases bundle BlueBubbles, so normal packaged builds do not
need a separate `openclaw plugins install` step.

## Overview

- Runs on macOS via the BlueBubbles helper app ([bluebubbles.app](https://bluebubbles.app)).
- Recommended/tested: macOS Sequoia (15). macOS Tahoe (26) works; edit is currently broken on Tahoe, and group icon updates may report success but not sync.
- OpenClaw talks to it through its REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Incoming messages arrive via webhooks; outgoing replies, typing indicators, read receipts, and tapbacks are REST calls.
- Attachments and stickers are ingested as inbound media (and surfaced to the agent when possible).
- Pairing/allowlist works the same way as other channels (`/channels/pairing` etc) with `channels.bluebubbles.allowFrom` + pairing codes.
- Reactions are surfaced as system events just like Slack/Telegram so agents can "mention" them before replying.
- Advanced features: edit, unsend, reply threading, message effects, group management.

## Quick start

1. Install the BlueBubbles server on your Mac (follow the instructions at [bluebubbles.app/install](https://bluebubbles.app/install)).
2. In the BlueBubbles config, enable the web API and set a password.
3. Run `openclaw onboard` and select BlueBubbles, or configure manually:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Point BlueBubbles webhooks to your gateway (example: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).
5. Start the gateway; it will register the webhook handler and start pairing.

Security note:

- Always set a webhook password.
- Webhook authentication is always required. OpenClaw rejects BlueBubbles webhook requests unless they include a password/guid that matches `channels.bluebubbles.password` (for example `?password=<password>` or `x-password`), regardless of loopback/proxy topology.
- Password authentication is checked before reading/parsing full webhook bodies.

## Keeping Messages.app alive (VM / headless setups)

Some macOS VM / always-on setups can end up with Messages.app going “idle” (incoming events stop until the app is opened/foregrounded). A simple workaround is to **poke Messages every 5 minutes** using an AppleScript + LaunchAgent.

### 1) Save the AppleScript

Save this as:

- `~/Scripts/poke-messages.scpt`

Example script (non-interactive; does not steal focus):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2) Install a LaunchAgent

Save this as:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Notes:

- This runs **every 300 seconds** and **on login**.
- The first run may trigger macOS **Automation** prompts (`osascript` → Messages). Approve them in the same user session that runs the LaunchAgent.

Load it:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles is available in interactive onboarding:

```
openclaw onboard
```

The wizard prompts for:

- **Server URL** (required): BlueBubbles server address (e.g., `http://192.168.1.100:1234`)
- **Password** (required): API password from BlueBubbles Server settings
- **Webhook path** (optional): Defaults to `/bluebubbles-webhook`
- **DM policy**: pairing, allowlist, open, or disabled
- **Allow list**: Phone numbers, emails, or chat targets

You can also add BlueBubbles via CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Access control (DMs + groups)

DMs:

- Default: `channels.bluebubbles.dmPolicy = "pairing"`.
- Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).
- Approve via:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Pairing is the default token exchange. Details: [Pairing](/channels/pairing)

Groups:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (default: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` controls who can trigger in groups when `allowlist` is set.

### Contact name enrichment (macOS, optional)

BlueBubbles group webhooks often only include raw participant addresses. If you want `GroupMembers` context to show local contact names instead, you can opt in to local Contacts enrichment on macOS:

- `channels.bluebubbles.enrichGroupParticipantsFromContacts = true` enables the lookup. Default: `false`.
- Lookups run only after group access, command authorization, and mention gating have allowed the message through.
- Only unnamed phone participants are enriched.
- Raw phone numbers remain as the fallback when no local match is found.

```json5
{
  channels: {
    bluebubbles: {
      enrichGroupParticipantsFromContacts: true,
    },
  },
}
```

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
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Command gating

- Control commands (e.g., `/config`, `/model`) require authorization.
- Uses `allowFrom` and `groupAllowFrom` to determine command authorization.
- Authorized senders can run control commands even without mentioning in groups.

### Per-group system prompt

Each entry under `channels.bluebubbles.groups.*` accepts an optional `systemPrompt` string. The value is injected into the agent's system prompt on every turn that handles a message in that group, so you can set per-group persona or behavioral rules without editing agent prompts:

```json5
{
  channels: {
    bluebubbles: {
      groups: {
        "iMessage;-;chat123": {
          systemPrompt: "Keep responses under 3 sentences. Mirror the group's casual tone.",
        },
      },
    },
  },
}
```

The key matches whatever BlueBubbles reports as `chatGuid` / `chatIdentifier` / numeric `chatId` for the group, and a `"*"` wildcard entry provides a default for every group without an exact match (same pattern used by `requireMention` and per-group tool policies). Exact matches always win over the wildcard. DMs ignore this field; use agent-level or account-level prompt customization instead.

#### Worked example: threaded replies and tapback reactions (Private API)

With the BlueBubbles Private API enabled, inbound messages arrive with short message IDs (for example `[[reply_to:5]]`) and the agent can call `action=reply` to thread into a specific message or `action=react` to drop a tapback. A per-group `systemPrompt` is a reliable way to keep the agent choosing the right tool:

```json5
{
  channels: {
    bluebubbles: {
      groups: {
        "iMessage;+;chat-family": {
          systemPrompt: [
            "When replying in this group, always call action=reply with the",
            "[[reply_to:N]] messageId from context so your response threads",
            "under the triggering message. Never send a new unlinked message.",
            "",
            "For short acknowledgements ('ok', 'got it', 'on it'), use",
            "action=react with an appropriate tapback emoji (❤️, 👍, 😂, ‼️, ❓)",
            "instead of sending a text reply.",
          ].join(" "),
        },
      },
    },
  },
}
```

Tapback reactions and threaded replies both require the BlueBubbles Private API; see [Advanced actions](#advanced-actions) and [Message IDs](#message-ids-short-vs-full) for the underlying mechanics.

## ACP conversation bindings

BlueBubbles chats can be turned into durable ACP workspaces without changing the transport layer.

Fast operator flow:

- Run `/acp spawn codex --bind here` inside the DM or allowed group chat.
- Future messages in that same BlueBubbles conversation route to the spawned ACP session.
- `/new` and `/reset` reset the same bound ACP session in place.
- `/acp close` closes the ACP session and removes the binding.

Configured persistent bindings are also supported through top-level `bindings[]` entries with `type: "acp"` and `match.channel: "bluebubbles"`.

`match.peer.id` can use any supported BlueBubbles target form:

- normalized DM handle such as `+15555550123` or `user@example.com`
- `chat_id:<id>`
- `chat_guid:<guid>`
- `chat_identifier:<identifier>`

For stable group bindings, prefer `chat_id:*` or `chat_identifier:*`.

Example:

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: { agent: "codex", backend: "acpx", mode: "persistent" },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "bluebubbles",
        accountId: "default",
        peer: { kind: "dm", id: "+15555550123" },
      },
      acp: { label: "codex-imessage" },
    },
  ],
}
```

See [ACP Agents](/tools/acp-agents) for shared ACP binding behavior.

## Typing + read receipts

- **Typing indicators**: Sent automatically before and during response generation.
- **Read receipts**: Controlled by `channels.bluebubbles.sendReadReceipts` (default: `true`).
- **Typing indicators**: OpenClaw sends typing start events; BlueBubbles clears typing automatically on send or timeout (manual stop via DELETE is unreliable).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Advanced actions

BlueBubbles supports advanced message actions when enabled in config:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Available actions:

- **react**: Add/remove tapback reactions (`messageId`, `emoji`, `remove`). iMessage's native tapback set is `love`, `like`, `dislike`, `laugh`, `emphasize`, and `question`. When an agent picks an emoji outside that set (for example `👀`), the reaction tool falls back to `love` so the tapback still renders instead of failing the whole request. Configured ack reactions still validate strictly and error on unknown values.
- **edit**: Edit a sent message (`messageId`, `text`)
- **unsend**: Unsend a message (`messageId`)
- **reply**: Reply to a specific message (`messageId`, `text`, `to`)
- **sendWithEffect**: Send with iMessage effect (`text`, `to`, `effectId`)
- **renameGroup**: Rename a group chat (`chatGuid`, `displayName`)
- **setGroupIcon**: Set a group chat's icon/photo (`chatGuid`, `media`) — flaky on macOS 26 Tahoe (API may return success but the icon does not sync).
- **addParticipant**: Add someone to a group (`chatGuid`, `address`)
- **removeParticipant**: Remove someone from a group (`chatGuid`, `address`)
- **leaveGroup**: Leave a group chat (`chatGuid`)
- **upload-file**: Send media/files (`to`, `buffer`, `filename`, `asVoice`)
  - Voice memos: set `asVoice: true` with **MP3** or **CAF** audio to send as an iMessage voice message. BlueBubbles converts MP3 → CAF when sending voice memos.
- Legacy alias: `sendAttachment` still works, but `upload-file` is the canonical action name.

### Message IDs (short vs full)

OpenClaw may surface _short_ message IDs (e.g., `1`, `2`) to save tokens.

- `MessageSid` / `ReplyToId` can be short IDs.
- `MessageSidFull` / `ReplyToIdFull` contain the provider full IDs.
- Short IDs are in-memory; they can expire on restart or cache eviction.
- Actions accept short or full `messageId`, but short IDs will error if no longer available.

Use full IDs for durable automations and storage:

- Templates: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Context: `MessageSidFull` / `ReplyToIdFull` in inbound payloads

See [Configuration](/gateway/configuration) for template variables.

<a id="coalescing-split-send-dms-command--url-in-one-composition"></a>

## Coalescing split-send DMs (command + URL in one composition)

When a user types a command and a URL together in iMessage — e.g. `Dump https://example.com/article` — Apple splits the send into **two separate webhook deliveries**:

1. A text message (`"Dump"`).
2. A URL-preview balloon (`"https://..."`) with OG-preview images as attachments.

The two webhooks arrive at OpenClaw ~0.8-2.0 s apart on most setups. Without coalescing, the agent receives the command alone on turn 1, replies (often "send me the URL"), and only sees the URL on turn 2 — at which point the command context is already lost.

`channels.bluebubbles.coalesceSameSenderDms` opts a DM into merging consecutive same-sender webhooks into a single agent turn. Group chats continue to key per-message so multi-user turn structure is preserved.

### When to enable

Enable when:

- You ship skills that expect `command + payload` in one message (dump, paste, save, queue, etc.).
- Your users paste URLs, images, or long content alongside commands.
- You can accept the added DM turn latency (see below).

Leave disabled when:

- You need minimum command latency for single-word DM triggers.
- All your flows are one-shot commands without payload follow-ups.

### Enabling

```json5
{
  channels: {
    bluebubbles: {
      coalesceSameSenderDms: true, // opt in (default: false)
    },
  },
}
```

With the flag on and no explicit `messages.inbound.byChannel.bluebubbles`, the debounce window widens to **2500 ms** (the default for non-coalescing is 500 ms). The wider window is required — Apple's split-send cadence of 0.8-2.0 s does not fit in the tighter default.

To tune the window yourself:

```json5
{
  messages: {
    inbound: {
      byChannel: {
        // 2500 ms works for most setups; raise to 4000 ms if your Mac is slow
        // or under memory pressure (observed gap can stretch past 2 s then).
        bluebubbles: 2500,
      },
    },
  },
}
```

### Trade-offs

- **Added latency for DM control commands.** With the flag on, DM control-command messages (like `Dump`, `Save`, etc.) now wait up to the debounce window before dispatching, in case a payload webhook is coming. Group-chat commands keep instant dispatch.
- **Merged output is bounded** — merged text caps at 4000 chars with an explicit `…[truncated]` marker; attachments cap at 20; source entries cap at 10 (first-plus-latest retained beyond that). Every source `messageId` still reaches inbound-dedupe so a later MessagePoller replay of any individual event is recognized as a duplicate.
- **Opt-in, per-channel.** Other channels (Telegram, WhatsApp, Slack, …) are unaffected.

### Scenarios and what the agent sees

| User composes                                                      | Apple delivers            | Flag off (default)                      | Flag on + 2500 ms window                                                |
| ------------------------------------------------------------------ | ------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `Dump https://example.com` (one send)                              | 2 webhooks ~1 s apart     | Two agent turns: "Dump" alone, then URL | One turn: merged text `Dump https://example.com`                        |
| `Save this 📎image.jpg caption` (attachment + text)                | 2 webhooks                | Two turns                               | One turn: text + image                                                  |
| `/status` (standalone command)                                     | 1 webhook                 | Instant dispatch                        | **Wait up to window, then dispatch**                                    |
| URL pasted alone                                                   | 1 webhook                 | Instant dispatch                        | Instant dispatch (only one entry in bucket)                             |
| Text + URL sent as two deliberate separate messages, minutes apart | 2 webhooks outside window | Two turns                               | Two turns (window expires between them)                                 |
| Rapid flood (>10 small DMs inside window)                          | N webhooks                | N turns                                 | One turn, bounded output (first + latest, text/attachment caps applied) |

### Split-send coalescing troubleshooting

If the flag is on and split-sends still arrive as two turns, check each layer:

1. **Config actually loaded.**

   ```
   grep coalesceSameSenderDms ~/.openclaw/openclaw.json
   ```

   Then `openclaw gateway restart` — the flag is read at debouncer-registry creation.

2. **Debounce window wide enough for your setup.** Look at the BlueBubbles server log under `~/Library/Logs/bluebubbles-server/main.log`:

   ```
   grep -E "Dispatching event to webhook" main.log | tail -20
   ```

   Measure the gap between the `"Dump"`-style text dispatch and the `"https://..."; Attachments:` dispatch that follows. Raise `messages.inbound.byChannel.bluebubbles` to comfortably cover that gap.

3. **Session JSONL timestamps ≠ webhook arrival.** Session event timestamps (`~/.openclaw/agents/<id>/sessions/*.jsonl`) reflect when the gateway hands a message to the agent, **not** when the webhook arrived. A queued-second message tagged `[Queued messages while agent was busy]` means the first turn was still running when the second webhook arrived — the coalesce bucket had already flushed. Tune the window against the BB server log, not the session log.

4. **Memory pressure slowing reply dispatch.** On smaller machines (8 GB), agent turns can take long enough that the coalesce bucket flushes before the reply completes, and the URL lands as a queued second turn. Check `memory_pressure` and `ps -o rss -p $(pgrep openclaw-gateway)`; if the gateway is over ~500 MB RSS and the compressor is active, close other heavy processes or bump to a larger host.

5. **Reply-quote sends are a different path.** If the user tapped `Dump` as a **reply** to an existing URL-balloon (iMessage shows a "1 Reply" badge on the Dump bubble), the URL lives in `replyToBody`, not in a second webhook. Coalescing does not apply — that's a skill/prompt concern, not a debouncer concern.

## Block streaming

Control whether responses are sent as a single message or streamed in blocks:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Media + limits

- Inbound attachments are downloaded and stored in the media cache.
- Media cap via `channels.bluebubbles.mediaMaxMb` for inbound and outbound media (default: 8 MB).
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
- `channels.bluebubbles.enrichGroupParticipantsFromContacts`: On macOS, optionally enrich unnamed group participants from local Contacts after gating passes. Default: `false`.
- `channels.bluebubbles.groups`: Per-group config (`requireMention`, etc.).
- `channels.bluebubbles.sendReadReceipts`: Send read receipts (default: `true`).
- `channels.bluebubbles.blockStreaming`: Enable block streaming (default: `false`; required for streaming replies).
- `channels.bluebubbles.textChunkLimit`: Outbound chunk size in chars (default: 4000).
- `channels.bluebubbles.sendTimeoutMs`: Per-request timeout in ms for outbound text sends via `/api/v1/message/text` (default: 30000). Raise on macOS 26 setups where Private API iMessage sends can stall for 60+ seconds inside the iMessage framework; for example `45000` or `60000`. Probes, chat lookups, reactions, edits, and health checks currently keep the shorter 10s default; broadening coverage to reactions and edits is planned as a follow-up. Per-account override: `channels.bluebubbles.accounts.<accountId>.sendTimeoutMs`.
- `channels.bluebubbles.chunkMode`: `length` (default) splits only when exceeding `textChunkLimit`; `newline` splits on blank lines (paragraph boundaries) before length chunking.
- `channels.bluebubbles.mediaMaxMb`: Inbound/outbound media cap in MB (default: 8).
- `channels.bluebubbles.mediaLocalRoots`: Explicit allowlist of absolute local directories permitted for outbound local media paths. Local path sends are denied by default unless this is configured. Per-account override: `channels.bluebubbles.accounts.<accountId>.mediaLocalRoots`.
- `channels.bluebubbles.coalesceSameSenderDms`: Merge consecutive same-sender DM webhooks into one agent turn so Apple's text+URL split-send arrives as a single message (default: `false`). See [Coalescing split-send DMs](#coalescing-split-send-dms-command--url-in-one-composition) for scenarios, window tuning, and trade-offs. Widens the default inbound debounce window from 500 ms to 2500 ms when enabled without an explicit `messages.inbound.byChannel.bluebubbles`.
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
  - If a direct handle does not have an existing DM chat, OpenClaw will create one via `POST /api/v1/chat/new`. This requires the BlueBubbles Private API to be enabled.

### iMessage vs SMS routing

When the same handle has both an iMessage and an SMS chat on the Mac (for example a phone number that is iMessage-registered but has also received green-bubble fallbacks), OpenClaw prefers the iMessage chat and never silently downgrades to SMS. To force the SMS chat, use an explicit `sms:` target prefix (for example `sms:+15555550123`). Handles without a matching iMessage chat still send through whatever chat BlueBubbles reports.

## Security

- Webhook requests are authenticated by comparing `guid`/`password` query params or headers against `channels.bluebubbles.password`.
- Keep the API password and webhook endpoint secret (treat them like credentials).
- There is no localhost bypass for BlueBubbles webhook auth. If you proxy webhook traffic, keep the BlueBubbles password on the request end-to-end. `gateway.trustedProxies` does not replace `channels.bluebubbles.password` here. See [Gateway security](/gateway/security#reverse-proxy-configuration).
- Enable HTTPS + firewall rules on the BlueBubbles server if exposing it outside your LAN.

## Troubleshooting

- If typing/read events stop working, check the BlueBubbles webhook logs and verify the gateway path matches `channels.bluebubbles.webhookPath`.
- Pairing codes expire after one hour; use `openclaw pairing list bluebubbles` and `openclaw pairing approve bluebubbles <code>`.
- Reactions require the BlueBubbles private API (`POST /api/v1/message/react`); ensure the server version exposes it.
- Edit/unsend require macOS 13+ and a compatible BlueBubbles server version. On macOS 26 (Tahoe), edit is currently broken due to private API changes.
- Group icon updates can be flaky on macOS 26 (Tahoe): the API may return success but the new icon does not sync.
- OpenClaw auto-hides known-broken actions based on the BlueBubbles server's macOS version. If edit still appears on macOS 26 (Tahoe), disable it manually with `channels.bluebubbles.actions.edit=false`.
- `coalesceSameSenderDms` enabled but split-sends (e.g. `Dump` + URL) still arrive as two turns: see the [split-send coalescing troubleshooting](#split-send-coalescing-troubleshooting) checklist — common causes are too-tight debounce window, session-log timestamps misread as webhook arrival, or a reply-quote send (which uses `replyToBody`, not a second webhook).
- For status/health info: `openclaw status --all` or `openclaw status --deep`.

For general channel workflow reference, see [Channels](/channels) and the [Plugins](/tools/plugin) guide.

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
