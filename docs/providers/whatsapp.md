---
summary: "WhatsApp (web provider) integration: login, inbox, replies, media, and ops"
read_when:
  - Working on WhatsApp/web provider behavior or inbox routing
---
# WhatsApp (web provider)


Status: WhatsApp Web via Baileys only. Gateway owns the session(s).

## Goals
- Multiple WhatsApp accounts (multi-account) in one Gateway process.
- Deterministic routing: replies return to WhatsApp, no model routing.
- Model sees enough context to understand quoted replies.

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
```json
{
  "whatsapp": {
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

**Pairing mode (optional):**
If you want pairing instead of allowlist, set `whatsapp.dmPolicy` to `pairing`. Unknown senders get a pairing code; approve with:
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
  },
  "messages": {
    "responsePrefix": "[clawdbot]"
  }
}
```

Tip: set `messages.responsePrefix` explicitly if you want a consistent bot prefix
on outbound replies.

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
  - Pairing: unknown senders get a pairing code (approve via `clawdbot pairing approve whatsapp <code>`; codes expire after 1 hour).
  - Open: requires `whatsapp.allowFrom` to include `"*"`.
  - Self messages are always allowed; “self-chat mode” still requires `whatsapp.allowFrom` to include your own number.

### Personal-number mode (fallback)
If you run Clawdbot on your **personal WhatsApp number**, enable `whatsapp.selfChatMode` (see sample above).

Behavior:
- Outbound DMs never trigger pairing replies (prevents spamming contacts).
- Inbound unknown senders still follow `whatsapp.dmPolicy`.
- Self-chat mode (allowFrom includes your number) avoids auto read receipts and ignores mention JIDs.
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
- Inbound media saves are capped by `whatsapp.mediaMaxMb` (default 50 MB).
- Outbound media items are capped by `agents.defaults.mediaMaxMb` (default 5 MB).

## Outbound send (text + media)
- Uses active web listener; error if gateway not running.
- Text chunking: 4k max per message (configurable via `whatsapp.textChunkLimit`).
- Media:
  - Image/video/audio/document supported.
  - Audio sent as PTT; `audio/ogg` => `audio/ogg; codecs=opus`.
  - Caption only on first media item.
  - Media fetch supports HTTP(S) and local paths.
  - Animated GIFs: WhatsApp expects MP4 with `gifPlayback: true` for inline looping.
    - CLI: `clawdbot message send --media <mp4> --gif-playback`
    - Gateway: `send` params include `gifPlayback: true`

## Media limits + optimization
- Default outbound cap: 5 MB (per media item).
- Override: `agents.defaults.mediaMaxMb`.
- Images are auto-optimized to JPEG under cap (resize + quality sweep).
- Oversize media => error; media reply falls back to text warning.

## Heartbeats
- **Gateway heartbeat** logs connection health (`web.heartbeatSeconds`, default 60s).
- **Agent heartbeat** is global (`agents.defaults.heartbeat.*`) and runs in the main session.
  - Uses the configured heartbeat prompt (default: `Read HEARTBEAT.md if exists. Consider outstanding tasks. Checkup sometimes on your human during (user local) day time.`) + `HEARTBEAT_OK` skip behavior.
  - Delivery defaults to the last used provider (or configured target).

## Reconnect behavior
- Backoff policy: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- If maxAttempts reached, web monitoring stops (degraded).
- Logged-out => stop and require re-link.

## Config quick map
- `whatsapp.dmPolicy` (DM policy: pairing/allowlist/open/disabled).
- `whatsapp.selfChatMode` (same-phone setup; bot uses your personal WhatsApp number).
- `whatsapp.allowFrom` (DM allowlist).
- `whatsapp.mediaMaxMb` (inbound media save cap).
- `whatsapp.accounts.<accountId>.*` (per-account settings + optional `authDir`).
- `whatsapp.accounts.<accountId>.mediaMaxMb` (per-account inbound media cap).
- `whatsapp.groupAllowFrom` (group sender allowlist).
- `whatsapp.groupPolicy` (group policy).
- `whatsapp.historyLimit` / `whatsapp.accounts.<accountId>.historyLimit` (group history context; `0` disables).
- `whatsapp.groups` (group allowlist + mention gating defaults; use `"*"` to allow all)
- `whatsapp.actions.reactions` (gate WhatsApp tool reactions).
- `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `whatsapp.messagePrefix` (inbound prefix; per-account: `whatsapp.accounts.<accountId>.messagePrefix`; deprecated: `messages.messagePrefix`)
- `messages.responsePrefix` (outbound prefix)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (optional override)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (disable provider startup when false)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Logs + troubleshooting
- Subsystems: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- Log file: `/tmp/clawdbot/clawdbot-YYYY-MM-DD.log` (configurable).
- Troubleshooting guide: [`docs/troubleshooting.md`](/gateway/troubleshooting).

## Troubleshooting (quick)

**Not linked / QR login required**
- Symptom: `providers status` shows `linked: false` or warns “Not linked”.
- Fix: run `clawdbot providers login` on the gateway host and scan the QR (WhatsApp → Settings → Linked Devices).

**Linked but disconnected / reconnect loop**
- Symptom: `providers status` shows `running, disconnected` or warns “Linked but disconnected”.
- Fix: `clawdbot doctor` (or restart the gateway). If it persists, relink via `providers login` and inspect `clawdbot logs --follow`.

**Bun runtime**
- WhatsApp uses Baileys; run the gateway with **Node** for WhatsApp. (See Getting Started runtime note.)
