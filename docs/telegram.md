---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
---
# Telegram (Bot API)

Updated: 2025-12-07

Status: ready for bot-mode use with grammY (long-polling by default; webhook supported when configured). Text + media send, mention-gated group replies with per-group overrides, and optional proxy support are implemented.

## Goals
- Let you talk to Clawdbot via a Telegram bot in DMs and groups.
- Share the same `main` session used by WhatsApp/WebChat; groups stay isolated as `telegram:group:<chatId>`.
- Keep transport routing deterministic: replies always go back to the surface they arrived on.

## How it will work (Bot API)
1) Create a bot with @BotFather and grab the token.
2) Configure Clawdbot with `TELEGRAM_BOT_TOKEN` (or `telegram.botToken` in `~/.clawdbot/clawdbot.json`).
3) Run the gateway; it auto-starts Telegram only when a `telegram` config section exists **and** a bot token is set (unless `telegram.enabled = false`).
   - If you prefer env vars, still add `telegram: { enabled: true }` to `~/.clawdbot/clawdbot.json` and set `TELEGRAM_BOT_TOKEN`.
   - **Long-polling** is the default.
   - **Webhook mode** is enabled by setting `telegram.webhookUrl` (optionally `telegram.webhookSecret` / `telegram.webhookPath`).
     - The webhook listener currently binds to `0.0.0.0:8787` and serves `POST /telegram-webhook` by default.
     - If you need a different public port/host, set `telegram.webhookUrl` to the externally reachable URL and use a reverse proxy to forward to `:8787`.
4) Direct chats: secure by default — unknown senders are gated by `telegram.dmPolicy` (default: `"pairing"`). The bot responds with a pairing code that the owner must approve before messages are processed. If you really want public inbound DMs: set `telegram.dmPolicy="open"` and `telegram.allowFrom=["*"]`.
5) Groups: add the bot, disable privacy mode (or make it admin) so it can read messages; group threads stay on `telegram:group:<chatId>`. When `telegram.groups` is set, it becomes a group allowlist (use `"*"` to allow all). Mention/command gating defaults come from `telegram.groups`.
6) Allowlist + pairing:
   - Direct chats: `telegram.allowFrom` (chat ids) or pairing approvals via `clawdbot pairing approve --provider telegram <code>` (alias: `clawdbot telegram pairing approve <code>`).
   - Groups: set `telegram.groupPolicy = "allowlist"` and list senders in `telegram.groupAllowFrom` (fallback: explicit `telegram.allowFrom`).

## Capabilities & limits (Bot API)
- Sees only messages sent after it’s added to a chat; no pre-history access.
- Cannot DM users first; they must initiate. Channels are receive-only unless the bot is an admin poster.
- File size caps follow Telegram Bot API (up to 2 GB for documents; smaller for some media types).
- Typing indicators (`sendChatAction`) supported; native replies are **off by default** and enabled via `telegram.replyToMode` + reply tags.

## Planned implementation details
- Library: grammY is the only client for send + gateway (fetch fallback removed); grammY throttler is enabled by default to stay under Bot API limits.
- Inbound normalization: maps Bot API updates to `MsgContext` with `Surface: "telegram"`, `ChatType: direct|group`, `SenderName`, `MediaPath`/`MediaType` when attachments arrive, `Timestamp`, and reply-to metadata (`ReplyToId`, `ReplyToBody`, `ReplyToSender`) when the user replies; reply context is appended to `Body` as a `[Replying to ...]` block (includes `id:` when available); groups require @bot mention or a `routing.groupChat.mentionPatterns` match by default (override per chat in config).
- Outbound: text and media (photo/video/audio/document) with optional caption; chunked to limits. Typing cue sent best-effort.
- Config: `TELEGRAM_BOT_TOKEN` env or `telegram.botToken` required; `telegram.dmPolicy`, `telegram.groups` (group allowlist + mention defaults), `telegram.allowFrom`, `telegram.groupAllowFrom`, `telegram.groupPolicy`, `telegram.mediaMaxMb`, `telegram.replyToMode`, `telegram.proxy`, `telegram.webhookSecret`, `telegram.webhookUrl`, `telegram.webhookPath` supported.
  - Ack reactions are controlled globally via `messages.ackReaction` + `messages.ackReactionScope`.
  - Mention gating precedence (most specific wins): `telegram.groups.<chatId>.requireMention` → `telegram.groups."*".requireMention` → default `true`.

Example config:
```json5
{
  telegram: {
    enabled: true,
    botToken: "123:abc",
    dmPolicy: "pairing", // pairing | allowlist | open | disabled
    replyToMode: "off",
    groups: {
      "*": { requireMention: true }, // allow all groups
      "123456789": { requireMention: false } // group chat id
    },
    allowFrom: ["123456789"], // direct chat ids allowed ("open" requires ["*"])
    groupPolicy: "allowlist",
    groupAllowFrom: ["tg:123456789", "@alice"],
    mediaMaxMb: 5,
    proxy: "socks5://localhost:9050",
    webhookSecret: "mysecret",
    webhookPath: "/telegram-webhook",
    webhookUrl: "https://yourdomain.com/telegram-webhook"
  }
}
```
- Tests: grammY-based paths in `src/telegram/*.test.ts` cover DM + group gating; add more media and webhook cases as needed.

## Group etiquette
- Keep privacy mode off if you expect the bot to read all messages; with privacy on, it only sees commands/mentions.
- Make the bot an admin if you need it to send in restricted groups or channels.
- Mention the bot (`@yourbot`) or use a `routing.groupChat.mentionPatterns` trigger; per-group overrides live in `telegram.groups` if you want always-on behavior. If `telegram.groups` is set, add `"*"` to keep existing allow-all behavior.

## Reply tags
To request a threaded reply, the model can include one tag in its output:
- `[[reply_to_current]]` — reply to the triggering Telegram message.
- `[[reply_to:<id>]]` — reply to a specific message id from context.
Current message ids are appended to prompts as `[message_id: …]`; reply context includes `id:` when available.

Behavior is controlled by `telegram.replyToMode`:
- `off`: ignore tags.
- `first`: only the first outbound chunk/attachment is a reply.
- `all`: every outbound chunk/attachment is a reply.

## Roadmap
- ✅ Design and defaults (this doc)
- ✅ grammY long-poll gateway + text/media send
- ✅ Proxy + webhook helpers (setWebhook/deleteWebhook, health endpoint, optional public URL)
- ⏳ Add more grammY coverage (webhook payloads, media edge cases)

## Safety & ops
- Treat the bot token as a secret (equivalent to account control); prefer `TELEGRAM_BOT_TOKEN` or a locked-down config file (`chmod 600 ~/.clawdbot/clawdbot.json`).
- Respect Telegram rate limits (429s); grammY throttling is enabled by default.
- Use a test bot for development to avoid hitting production chats.
