---
summary: "WhatsApp (web provider) integration: login, inbox, replies, media, and ops"
read_when:
  - Working on WhatsApp/web provider behavior or inbox routing
---
# WhatsApp (web provider)

Updated: 2026-01-07

Status: WhatsApp Web via Baileys only. Gateway owns the session(s).

## Goals
- Multiple WhatsApp accounts (multi-account) in one Gateway process.
- Deterministic routing: replies return to WhatsApp, no model routing.
- Model sees enough context to understand quoted replies.

## Architecture (who owns what)
- **Gateway** owns the Baileys socket and inbox loop.
- **CLI / macOS app** talk to the gateway; no direct Baileys use.
- **Active listener** is required for outbound sends; otherwise send fails fast.

## Getting a phone number

WhatsApp requires a real mobile number for verification. VoIP and virtual numbers are usually blocked.

**Recommended approaches:**
- **Local eSIM** from your country's mobile carrier (most reliable)
  - Austria: [hot.at](https://www.hot.at)
  - UK: [giffgaff](https://www.giffgaff.com) — free SIM, no contract
- **Prepaid SIM** — cheap, just needs to receive one SMS for verification

**Avoid:** TextNow, Google Voice, most "free SMS" services — WhatsApp blocks these aggressively.

**Tip:** The number only needs to receive one verification SMS. After that, WhatsApp Web sessions persist via `creds.json`.

**WhatsApp Business:** You can use WhatsApp Business on the same phone with a different number. This is a great option if you want to keep your personal WhatsApp separate — just install WhatsApp Business and register it with Clawdbot's dedicated number.

## Why Not Twilio?
- Early Clawdbot builds supported Twilio’s WhatsApp Business integration.
- WhatsApp Business numbers are a poor fit for a personal assistant.
- Meta enforces a 24‑hour reply window; if you haven’t responded in the last 24 hours, the business number can’t initiate new messages.
- High-volume or “chatty” usage triggers aggressive blocking, because business accounts aren’t meant to send dozens of personal assistant messages.
- Result: unreliable delivery and frequent blocks, so support was removed.

## Login + credentials
- Login command: `clawdbot providers login` (QR via Linked Devices).
- Multi-account login: `clawdbot providers login --account <id>` (`<id>` = `accountId`).
- Default account (when `--account` is omitted): `default` if present, otherwise the first configured account id (sorted).
- Credentials stored in `~/.clawdbot/credentials/whatsapp/<accountId>/creds.json`.
- Backup copy at `creds.json.bak` (restored on corruption).
- Legacy compatibility: older installs stored Baileys files directly in `~/.clawdbot/credentials/`.
- Logout: `clawdbot providers logout` (or `--account <id>`) deletes WhatsApp auth state (but keeps shared `oauth.json`).
- Logged-out socket => error instructs re-link.

## Inbound flow (DM + group)
- WhatsApp events come from `messages.upsert` (Baileys).
- Inbox listeners are detached on shutdown to avoid accumulating event handlers in tests/restarts.
- Status/broadcast chats are ignored.
- Direct chats use E.164; groups use group JID.
- **DM policy**: `whatsapp.dmPolicy` controls direct chat access (default: `pairing`).
  - Pairing: unknown senders get a pairing code (approve via `clawdbot pairing approve --provider whatsapp <code>`; codes expire after 1 hour).
  - Open: requires `whatsapp.allowFrom` to include `"*"`.
  - Self messages are always allowed; “self-chat mode” still requires `whatsapp.allowFrom` to include your own number.

### Same-phone mode (personal number)
If you run Clawdbot on your **personal WhatsApp number**, set:

```json
{
  "whatsapp": {
    "selfChatMode": true
  }
}
```

Behavior:
- Suppresses pairing replies for **outbound DMs** (prevents spamming contacts).
- Inbound unknown senders still follow `whatsapp.dmPolicy`.

Recommended for personal numbers:
- Set `whatsapp.dmPolicy="allowlist"` and add your number to `whatsapp.allowFrom`.
- Set `messages.responsePrefix` (for example, `[clawdbot]`) so replies are clearly labeled.
- **Group policy**: `whatsapp.groupPolicy` controls group handling (`open|disabled|allowlist`).
  - `allowlist` uses `whatsapp.groupAllowFrom` (fallback: explicit `whatsapp.allowFrom`).
- **Self-chat mode**: avoids auto read receipts and ignores mention JIDs.
- Read receipts sent for non-self-chat DMs.

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
- Group policy: `whatsapp.groupPolicy = open|disabled|allowlist` (default `open`).
- Activation modes:
  - `mention` (default): requires @mention or regex match.
  - `always`: always triggers.
- `/activation mention|always` is owner-only and must be sent as a standalone message.
- Owner = `whatsapp.allowFrom` (or self E.164 if unset).
- **History injection**:
  - Recent messages (default 50) inserted under:
    `[Chat messages since your last reply - for context]`
  - Current message under:
    `[Current message - respond to this]`
  - Sender suffix appended: `[from: Name (+E164)]`
- Group metadata cached 5 min (subject + participants).

## Reply delivery (threading)
- WhatsApp Web sends standard messages (no quoted reply threading in the current gateway).
- Reply tags are ignored on this provider.

## Agent tool (reactions)
- Tool: `whatsapp` with `react` action (`chatJid`, `messageId`, `emoji`, optional `remove`).
- Optional: `participant` (group sender), `fromMe` (reacting to your own message), `accountId` (multi-account).
- Reaction removal semantics: see [/tools/reactions](/tools/reactions).
- Tool gating: `whatsapp.actions.reactions` (default: enabled).

## Limits
- Outbound text is chunked to `whatsapp.textChunkLimit` (default 4000).
- Media items are capped by `agent.mediaMaxMb` (default 5 MB).

## Outbound send (text + media)
- Uses active web listener; error if gateway not running.
- Text chunking: 4k max per message (configurable via `whatsapp.textChunkLimit`).
- Media:
  - Image/video/audio/document supported.
  - Audio sent as PTT; `audio/ogg` => `audio/ogg; codecs=opus`.
  - Caption only on first media item.
  - Media fetch supports HTTP(S) and local paths.
  - Animated GIFs: WhatsApp expects MP4 with `gifPlayback: true` for inline looping.
    - CLI: `clawdbot send --media <mp4> --gif-playback`
    - Gateway: `send` params include `gifPlayback: true`

## Media limits + optimization
- Default cap: 5 MB (per media item).
- Override: `agent.mediaMaxMb`.
- Images are auto-optimized to JPEG under cap (resize + quality sweep).
- Oversize media => error; media reply falls back to text warning.

## Heartbeats
- **Gateway heartbeat** logs connection health (`web.heartbeatSeconds`, default 60s).
- **Agent heartbeat** is global (`agent.heartbeat.*`) and runs in the main session.
  - Uses the configured heartbeat prompt (default: `Read HEARTBEAT.md if exists. Consider outstanding tasks. Checkup sometimes on your human during (user local) day time.`) + `HEARTBEAT_OK` skip behavior.
  - Delivery defaults to the last used provider (or configured target).

## Reconnect behavior
- Backoff policy: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- If maxAttempts reached, web monitoring stops (degraded).
- Logged-out => stop and require re-link.

## Config quick map
- `whatsapp.dmPolicy` (DM policy: pairing/allowlist/open/disabled).
- `whatsapp.selfChatMode` (same-phone setup; suppress pairing replies for outbound DMs).
- `whatsapp.allowFrom` (DM allowlist).
- `whatsapp.accounts.<accountId>.*` (per-account settings + optional `authDir`).
- `whatsapp.groupAllowFrom` (group sender allowlist).
- `whatsapp.groupPolicy` (group policy).
- `whatsapp.groups` (group allowlist + mention gating defaults; use `"*"` to allow all)
- `whatsapp.actions.reactions` (gate WhatsApp tool reactions).
- `routing.groupChat.mentionPatterns`
- `routing.groupChat.historyLimit`
- `messages.messagePrefix` (inbound prefix)
- `messages.responsePrefix` (outbound prefix)
- `agent.mediaMaxMb`
- `agent.heartbeat.every`
- `agent.heartbeat.model` (optional override)
- `agent.heartbeat.target`
- `agent.heartbeat.to`
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (disable provider startup when false)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Logs + troubleshooting
- Subsystems: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- Log file: `/tmp/clawdbot/clawdbot-YYYY-MM-DD.log` (configurable).
- Troubleshooting guide: [`docs/troubleshooting.md`](/gateway/troubleshooting).

## Tests
- [`src/web/auto-reply.test.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/web/auto-reply.test.ts) (mention gating, history injection, reply flow)
- [`src/web/monitor-inbox.test.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/web/monitor-inbox.test.ts) (inbound parsing + reply context)
- [`src/web/outbound.test.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/web/outbound.test.ts) (send mapping + media)
