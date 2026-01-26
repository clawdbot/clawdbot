---
summary: "WhatsApp (web channel) integration: login, inbox, replies, media, and ops"
read_when:
  - Working on WhatsApp/web channel behavior or inbox routing
---
# WhatsApp (web channel)


Status: WhatsApp Web via Baileys only. Gateway owns the session(s).

## Quick setup (beginner)
1) Use a **separate phone number** if possible (recommended).
2) Configure WhatsApp in `~/.clawdbot/clawdbot.json`.
3) Run `clawdbot channels login` to scan the QR code (Linked Devices).
4) Start the gateway.

Minimal config:
```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"]
    }
  }
}
```

## Goals
- Multiple WhatsApp accounts (multi-account) in one Gateway process.
- Deterministic routing: replies return to WhatsApp, no model routing.
- Model sees enough context to understand quoted replies.

## Config writes
By default, WhatsApp is allowed to write config updates triggered by `/config set|unset` (requires `commands.config: true`).

Disable with:
```json5
{
  channels: { whatsapp: { configWrites: false } }
}
```

## Architecture (who owns what)
- **Gateway** owns the Baileys socket and inbox loop.
- **CLI / macOS app** talk to the gateway; no direct Baileys use.
- **Active listener** is required for outbound sends; otherwise send fails fast.

## Getting a phone number (two modes)

WhatsApp requires a real mobile number for verification. VoIP and virtual numbers are usually blocked. There are two supported ways to run Clawdbot on WhatsApp:

### Dedicated number (recommended)
Use a **separate phone number** for Clawdbot. Best UX, clean routing, no self-chat quirks. Ideal setup: **spare/old Android phone + eSIM**. Leave it on Wi‑Fi and power, and link it via QR.

**WhatsApp Business:** You can use WhatsApp Business on the same device with a different number. Great for keeping your personal WhatsApp separate — install WhatsApp Business and register the Clawdbot number there.

**Sample config (dedicated number, single-user allowlist):**
```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"]
    }
  }
}
```

**Pairing mode (optional):**
If you want pairing instead of allowlist, set `channels.whatsapp.dmPolicy` to `pairing`. Unknown senders get a pairing code; approve with:
`clawdbot pairing approve whatsapp <code>`

### Personal number (fallback)
Quick fallback: run Clawdbot on **your own number**. Message yourself (WhatsApp “Message yourself”) for testing so you don’t spam contacts. Expect to read verification codes on your main phone during setup and experiments. **Must enable self-chat mode.**
When the wizard asks for your personal WhatsApp number, enter the phone you will message from (the owner/sender), not the assistant number.

**Sample config (personal number, self-chat):**
```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

Self-chat replies default to `[{identity.name}]` when set (otherwise `[clawdbot]`)
if `messages.responsePrefix` is unset. Set it explicitly to customize or disable
the prefix (use `""` to remove it).

### Number sourcing tips
- **Local eSIM** from your country's mobile carrier (most reliable)
  - Austria: [hot.at](https://www.hot.at)
  - UK: [giffgaff](https://www.giffgaff.com) — free SIM, no contract
- **Prepaid SIM** — cheap, just needs to receive one SMS for verification

**Avoid:** TextNow, Google Voice, most "free SMS" services — WhatsApp blocks these aggressively.

**Tip:** The number only needs to receive one verification SMS. After that, WhatsApp Web sessions persist via `creds.json`.

## Why Not Twilio?
- Early Clawdbot builds supported Twilio’s WhatsApp Business integration.
- WhatsApp Business numbers are a poor fit for a personal assistant.
- Meta enforces a 24‑hour reply window; if you haven’t responded in the last 24 hours, the business number can’t initiate new messages.
- High-volume or “chatty” usage triggers aggressive blocking, because business accounts aren’t meant to send dozens of personal assistant messages.
- Result: unreliable delivery and frequent blocks, so support was removed.

## Login + credentials
- Login command: `clawdbot channels login` (QR via Linked Devices).
- Multi-account login: `clawdbot channels login --account <id>` (`<id>` = `accountId`).
- Default account (when `--account` is omitted): `default` if present, otherwise the first configured account id (sorted).
- Credentials stored in `~/.clawdbot/credentials/whatsapp/<accountId>/creds.json`.
- Backup copy at `creds.json.bak` (restored on corruption).
- Legacy compatibility: older installs stored Baileys files directly in `~/.clawdbot/credentials/`.
- Logout: `clawdbot channels logout` (or `--account <id>`) deletes WhatsApp auth state (but keeps shared `oauth.json`).
- Logged-out socket => error instructs re-link.

## Inbound flow (DM + group)
- WhatsApp events come from `messages.upsert` (Baileys).
- Inbox listeners are detached on shutdown to avoid accumulating event handlers in tests/restarts.
- Status/broadcast chats are ignored.
- Direct chats use E.164; groups use group JID.
- **DM policy**: `channels.whatsapp.dmPolicy` controls direct chat access (default: `pairing`).
  - Pairing: unknown senders get a pairing code (approve via `clawdbot pairing approve whatsapp <code>`; codes expire after 1 hour).
  - Open: requires `channels.whatsapp.allowFrom` to include `"*"`.
  - Self messages are always allowed; “self-chat mode” still requires `channels.whatsapp.allowFrom` to include your own number.

### Personal-number mode (fallback)
If you run Clawdbot on your **personal WhatsApp number**, enable `channels.whatsapp.selfChatMode` (see sample above).

Behavior:
- Outbound DMs never trigger pairing replies (prevents spamming contacts).
- Inbound unknown senders still follow `channels.whatsapp.dmPolicy`.
- Self-chat mode (allowFrom includes your number) avoids auto read receipts and ignores mention JIDs.
- Read receipts sent for non-self-chat DMs.

## Read receipts
By default, the gateway marks inbound WhatsApp messages as read (blue ticks) once they are accepted.

Disable globally:
```json5
{
  channels: { whatsapp: { sendReadReceipts: false } }
}
```

Disable per account:
```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false }
      }
    }
  }
}
```

Notes:
- Self-chat mode always skips read receipts.

## WhatsApp FAQ: sending messages + pairing

**Will Clawdbot message random contacts when I link WhatsApp?**  
No. Default DM policy is **pairing**, so unknown senders only get a pairing code and their message is **not processed**. Clawdbot only replies to chats it receives, or to sends you explicitly trigger (agent/CLI).

**How does pairing work on WhatsApp?**  
Pairing is a DM gate for unknown senders:
- First DM from a new sender returns a short code (message is not processed).
- Approve with: `clawdbot pairing approve whatsapp <code>` (list with `clawdbot pairing list whatsapp`).
- Codes expire after 1 hour; pending requests are capped at 3 per channel.

**Can multiple people use different Clawdbots on one WhatsApp number?**  
Yes, by routing each sender to a different agent via `bindings` (peer `kind: "dm"`, sender E.164 like `+15551234567`). Replies still come from the **same WhatsApp account**, and direct chats collapse to each agent’s main session, so use **one agent per person**. DM access control (`dmPolicy`/`allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent).

**Why do you ask for my phone number in the wizard?**  
The wizard uses it to set your **allowlist/owner** so your own DMs are permitted. It’s not used for auto-sending. If you run on your personal WhatsApp number, use that same number and enable `channels.whatsapp.selfChatMode`.

## Message normalization (what the model sees)
- `Body` is the current message body with envelope.
- Quoted reply context is **always appended**:
  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```
- Reply metadata also set:
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = quoted body or media placeholder
  - `ReplyToSender` = E.164 when known
- Media-only inbound messages use placeholders:
  - `<media:image|video|audio|document|sticker>`

## Groups
- Groups map to `agent:<agentId>:whatsapp:group:<jid>` sessions.
- Group policy: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (default `allowlist`).
- Activation modes:
  - `mention` (default): requires @mention or regex match.
  - `always`: always triggers.
- `/activation mention|always` is owner-only and must be sent as a standalone message.
- Owner = `channels.whatsapp.allowFrom` (or self E.164 if unset).
- **History injection** (pending-only):
  - Recent *unprocessed* messages (default 50) inserted under:
    `[Chat messages since your last reply - for context]` (messages already in the session are not re-injected)
  - Current message under:
    `[Current message - respond to this]`
  - Sender suffix appended: `[from: Name (+E164)]`
- Group metadata cached 5 min (subject + participants).

## Reply delivery (threading)
- WhatsApp Web sends standard messages (no quoted reply threading in the current gateway).
- Reply tags are ignored on this channel.

## Acknowledgment reactions (auto-react on receipt)

WhatsApp can automatically send emoji reactions to incoming messages immediately upon receipt, before the bot generates a reply. This provides instant feedback to users that their message was received.

**Configuration:**
```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**Options:**
- `emoji` (string): Emoji to use for acknowledgment (e.g., "👀", "✅", "📨"). Empty or omitted = feature disabled.
- `direct` (boolean, default: `true`): Send reactions in direct/DM chats.
- `group` (string, default: `"mentions"`): Group chat behavior:
  - `"always"`: React to all group messages (even without @mention)
  - `"mentions"`: React only when bot is @mentioned
  - `"never"`: Never react in groups

**Per-account override:**
```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**Behavior notes:**
- Reactions are sent **immediately** upon message receipt, before typing indicators or bot replies.
- In groups with `requireMention: false` (activation: always), `group: "mentions"` will react to all messages (not just @mentions).
- Fire-and-forget: reaction failures are logged but don't prevent the bot from replying.
- Participant JID is automatically included for group reactions.
- WhatsApp ignores `messages.ackReaction`; use `channels.whatsapp.ackReaction` instead.

## Agent tool (reactions)
- Tool: `whatsapp` with `react` action (`chatJid`, `messageId`, `emoji`, optional `remove`).
- Optional: `participant` (group sender), `fromMe` (reacting to your own message), `accountId` (multi-account).
- Reaction removal semantics: see [/tools/reactions](/tools/reactions).
- Tool gating: `channels.whatsapp.actions.reactions` (default: enabled).

## Limits
- Outbound text is chunked to `channels.whatsapp.textChunkLimit` (default 4000).
- Optional newline chunking: set `channels.whatsapp.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking.
- Inbound media saves are capped by `channels.whatsapp.mediaMaxMb` (default 50 MB).
- Outbound media items are capped by `agents.defaults.mediaMaxMb` (default 5 MB).

## Outbound send (text + media)
- Uses active web listener; error if gateway not running.
- Text chunking: 4k max per message (configurable via `channels.whatsapp.textChunkLimit`, optional `channels.whatsapp.chunkMode`).
- Media:
  - Image/video/audio/document supported.
  - Audio sent as PTT; `audio/ogg` => `audio/ogg; codecs=opus`.
  - Caption only on first media item.
  - Media fetch supports HTTP(S) and local paths.
  - Animated GIFs: WhatsApp expects MP4 with `gifPlayback: true` for inline looping.
    - CLI: `clawdbot message send --media <mp4> --gif-playback`
    - Gateway: `send` params include `gifPlayback: true`

## Voice notes (PTT audio)
WhatsApp sends audio as **voice notes** (PTT bubble).
- Best results: OGG/Opus. Clawdbot rewrites `audio/ogg` to `audio/ogg; codecs=opus`.
- `[[audio_as_voice]]` is ignored for WhatsApp (audio already ships as voice note).

## Media limits + optimization
- Default outbound cap: 5 MB (per media item).
- Override: `agents.defaults.mediaMaxMb`.
- Images are auto-optimized to JPEG under cap (resize + quality sweep).
- Oversize media => error; media reply falls back to text warning.

## Heartbeats
- **Gateway heartbeat** logs connection health (`web.heartbeatSeconds`, default 60s).
- **Agent heartbeat** can be configured per agent (`agents.list[].heartbeat`) or globally
  via `agents.defaults.heartbeat` (fallback when no per-agent entries are set).
  - Uses the configured heartbeat prompt (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + `HEARTBEAT_OK` skip behavior.
  - Delivery defaults to the last used channel (or configured target).

## Reconnect behavior
- Backoff policy: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- If maxAttempts reached, web monitoring stops (degraded).
- Logged-out => stop and require re-link.

## Config quick map
- `channels.whatsapp.dmPolicy` (DM policy: pairing/allowlist/open/disabled).
- `channels.whatsapp.selfChatMode` (same-phone setup; bot uses your personal WhatsApp number).
- `channels.whatsapp.allowFrom` (DM allowlist). WhatsApp uses E.164 phone numbers (no usernames).
- `channels.whatsapp.mediaMaxMb` (inbound media save cap).
- `channels.whatsapp.ackReaction` (auto-reaction on message receipt: `{emoji, direct, group}`).
- `channels.whatsapp.accounts.<accountId>.*` (per-account settings + optional `authDir`).
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (per-account inbound media cap).
- `channels.whatsapp.accounts.<accountId>.ackReaction` (per-account ack reaction override).
- `channels.whatsapp.groupAllowFrom` (group sender allowlist).
- `channels.whatsapp.groupPolicy` (group policy).
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit` (group history context; `0` disables).
- `channels.whatsapp.dmHistoryLimit` (DM history limit in user turns). Per-user overrides: `channels.whatsapp.dms["<phone>"].historyLimit`.
- `channels.whatsapp.groups` (group allowlist + mention gating defaults; use `"*"` to allow all)
- `channels.whatsapp.actions.reactions` (gate WhatsApp tool reactions).
- `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (inbound prefix; per-account: `channels.whatsapp.accounts.<accountId>.messagePrefix`; deprecated: `messages.messagePrefix`)
- `messages.responsePrefix` (outbound prefix)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (optional override)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (per-agent overrides)
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (disable channel startup when false)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Logs + troubleshooting
- Subsystems: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- Log file: `/tmp/clawdbot/clawdbot-YYYY-MM-DD.log` (configurable).
- Troubleshooting guide: [Gateway troubleshooting](/gateway/troubleshooting).

## Troubleshooting (quick)

**Not linked / QR login required**
- Symptom: `channels status` shows `linked: false` or warns “Not linked”.
- Fix: run `clawdbot channels login` on the gateway host and scan the QR (WhatsApp → Settings → Linked Devices).

**Linked but disconnected / reconnect loop**
- Symptom: `channels status` shows `running, disconnected` or warns “Linked but disconnected”.
- Fix: `clawdbot doctor` (or restart the gateway). If it persists, relink via `channels login` and inspect `clawdbot logs --follow`.

**Bun runtime**
- Bun is **not recommended**. WhatsApp (Baileys) and Telegram are unreliable on Bun.
  Run the gateway with **Node**. (See Getting Started runtime note.)
