---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
---
# Telegram (Bot API)

Updated: 2026-01-08

Status: production-ready for bot DMs + groups via grammY. Long-polling by default; webhook optional.

## What it is
- A Telegram Bot API provider owned by the Gateway.
- Deterministic routing: replies go back to Telegram; the model never chooses providers.
- DMs share the agent's main session; groups stay isolated (`telegram:group:<chatId>`).

## Setup (fast path)
1) Create a bot with @BotFather and copy the token.
2) Configure the token (env or config). Example:

```json5
{
  telegram: {
    enabled: true,
    botToken: "123:abc",
    dmPolicy: "pairing",
    groups: { "*": { requireMention: true } }
  }
}
```

Multi-account support: use `telegram.accounts` with per-account tokens and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

3) Start the gateway. Telegram starts when a `telegram` config section exists and a token is resolved.
4) DM access defaults to pairing. Approve the code when the bot is first contacted.
5) For groups: add the bot, disable privacy mode (or make it admin), then set `telegram.groups` to control mention gating + allowlists.

## How it works (behavior)
- Inbound messages are normalized into the shared provider envelope with reply context and media placeholders.
- Group replies require a mention by default (native @mention or `routing.groupChat.mentionPatterns`).
- Replies always route back to the same Telegram chat.
- Long-polling uses grammY runner with per-chat sequencing; overall concurrency is capped by `agent.maxConcurrent`.

## Group activation modes

By default, the bot only responds to mentions in groups (`@botname` or patterns in `routing.groupChat.mentionPatterns`). To change this behavior:

### Via config (recommended)

```json5
{
  telegram: {
    groups: {
      "-1001234567890": { requireMention: false }  // always respond in this group
    }
  }
}
```

**Important:** Setting `telegram.groups` creates an **allowlist** - only listed groups (or `"*"`) will be accepted.

To allow all groups with always-respond:
```json5
{
  telegram: {
    groups: {
      "*": { requireMention: false }  // all groups, always respond
    }
  }
}
```

To keep mention-only for all groups (default behavior):
```json5
{
  telegram: {
    groups: {
      "*": { requireMention: true }  // or omit groups entirely
    }
  }
}
```

### Via command (session-level)

Send in the group:
- `/activation always` - respond to all messages
- `/activation mention` - require mentions (default)

**Note:** Commands update session state only. For persistent behavior across restarts, use config.

### Getting the group chat ID

Forward any message from the group to `@userinfobot` or `@getidsbot` on Telegram to see the chat ID (negative number like `-1001234567890`).

## Topics (forum supergroups)
Telegram forum topics include a `message_thread_id` per message. Clawdbot:
- Appends `:topic:<threadId>` to the Telegram group session key so each topic is isolated.
- Sends typing indicators and replies with `message_thread_id` so responses stay in the topic.
- Exposes `MessageThreadId` + `IsForum` in template context for routing/templating.
- Topic-specific configuration is available under `telegram.groups.<chatId>.topics.<threadId>` (skills, allowlists, auto-reply, system prompts, disable).

Private topics (DM forum mode) also include `message_thread_id`. Clawdbot:
- Appends `:topic:<threadId>` to **DM** session keys for isolation.
- Uses the thread id for draft streaming + replies.

## Access control (DMs + groups)

### DM access
- Default: `telegram.dmPolicy = "pairing"`. Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).
- Approve via:
  - `clawdbot pairing list --provider telegram`
  - `clawdbot pairing approve --provider telegram <CODE>`
- Pairing is the default token exchange used for Telegram DMs. Details: [Pairing](/start/pairing)

### Group access

Two independent controls:

**1. Which groups are allowed** (group allowlist via `telegram.groups`):
- No `groups` config = all groups allowed
- With `groups` config = only listed groups or `"*"` are allowed
- Example: `"groups": { "-1001234567890": {}, "*": {} }` allows all groups

**2. Which senders are allowed** (sender filtering via `telegram.groupPolicy`):
- `"open"` (default) = all senders in allowed groups can message
- `"allowlist"` = only senders in `telegram.groupAllowFrom` can message
- `"disabled"` = no group messages accepted at all

Most users want: `groupPolicy: "open"` + specific groups listed in `telegram.groups`

## Long-polling vs webhook
- Default: long-polling (no public URL required).
- Webhook mode: set `telegram.webhookUrl` (optionally `telegram.webhookSecret` + `telegram.webhookPath`).
  - The local listener binds to `0.0.0.0:8787` and serves `POST /telegram-webhook` by default.
  - If your public URL is different, use a reverse proxy and point `telegram.webhookUrl` at the public endpoint.

## Reply threading
Telegram supports optional threaded replies via tags:
- `[[reply_to_current]]` -- reply to the triggering message.
- `[[reply_to:<id>]]` -- reply to a specific message id.

Controlled by `telegram.replyToMode`:
- `first` (default), `all`, `off`.

## Streaming (drafts)
Telegram can stream **draft bubbles** while the agent is generating a response.
Clawdbot uses Bot API `sendMessageDraft` (not real messages) and then sends the
final reply as a normal message.

Requirements (Telegram Bot API 9.3+):
- **Private chats with topics enabled** (forum topic mode for the bot).
- Incoming messages must include `message_thread_id` (private topic thread).
- Streaming is ignored for groups/supergroups/channels.

Config:
- `telegram.streamMode: "off" | "partial" | "block"` (default: `partial`)
  - `partial`: update the draft bubble with the latest streaming text.
  - `block`: update the draft bubble in larger blocks (chunked).
  - `off`: disable draft streaming.

Reasoning stream (Telegram only):
- `/reasoning stream` streams reasoning into the draft bubble while the reply is
  generating, then sends the final answer without reasoning.
- If `telegram.streamMode` is `off`, reasoning stream is disabled.
More context: [Streaming + chunking](/concepts/streaming).

## Retry policy
Outbound Telegram API calls retry on transient network/429 errors with exponential backoff and jitter. Configure via `telegram.retry`. See [Retry policy](/concepts/retry).

## Agent tool (messages + reactions)
- Tool: `telegram` with `sendMessage` action (`to`, `content`, optional `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- Tool: `telegram` with `react` action (`chatId`, `messageId`, `emoji`).
- Reaction removal semantics: see [/tools/reactions](/tools/reactions).
- Tool gating: `telegram.actions.reactions` and `telegram.actions.sendMessage` (default: enabled).

## Delivery targets (CLI/cron)
- Use a chat id (`123456789`) or a username (`@name`) as the target.
- Example: `clawdbot send --provider telegram --to 123456789 "hi"`.

## Troubleshooting

**Bot doesn't respond to non-mention messages in group:**
- Check if group is in `telegram.groups` with `requireMention: false`
- Or use `"*": { "requireMention": false }` to enable for all groups
- Test with `/activation always` command (requires config change to persist)

**Bot not seeing group messages at all:**
- If `telegram.groups` is set, the group must be listed or use `"*"`
- Check Privacy Settings in @BotFather → "Group Privacy" should be **OFF**
- Verify bot is actually a member (not just an admin with no read access)
- Check gateway logs: `journalctl --user -u clawdbot -f` (look for "skipping group message")

**Bot responds to mentions but not `/activation always`:**
- The `/activation` command updates session state but doesn't persist to config
- For persistent behavior, add group to `telegram.groups` with `requireMention: false`

**Commands like `/status` don't work:**
- Make sure your Telegram user ID is authorized (via pairing or `telegram.allowFrom`)
- Commands require authorization even in groups with `groupPolicy: "open"`

## Configuration reference (Telegram)
Full configuration: [Configuration](/gateway/configuration)

Provider options:
- `telegram.enabled`: enable/disable provider startup.
- `telegram.botToken`: bot token (BotFather).
- `telegram.tokenFile`: read token from file path.
- `telegram.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `telegram.allowFrom`: DM allowlist (ids/usernames). `open` requires `"*"`.
- `telegram.groupPolicy`: `open | allowlist | disabled` (default: open).
- `telegram.groupAllowFrom`: group sender allowlist (ids/usernames).
- `telegram.groups`: per-group defaults + allowlist (use `"*"` for global defaults).
  - `telegram.groups.<id>.requireMention`: mention gating default.
  - `telegram.groups.<id>.skills`: skill filter (omit = all skills, empty = none).
  - `telegram.groups.<id>.allowFrom`: per-group sender allowlist override.
  - `telegram.groups.<id>.systemPrompt`: extra system prompt for the group.
  - `telegram.groups.<id>.enabled`: disable the group when `false`.
  - `telegram.groups.<id>.topics.<threadId>.*`: per-topic overrides (same fields as group).
  - `telegram.groups.<id>.topics.<threadId>.requireMention`: per-topic mention gating override.
- `telegram.replyToMode`: `off | first | all` (default: `first`).
- `telegram.textChunkLimit`: outbound chunk size (chars).
- `telegram.streamMode`: `off | partial | block` (draft streaming).
- `telegram.mediaMaxMb`: inbound/outbound media cap (MB).
- `telegram.retry`: retry policy for outbound Telegram API calls (attempts, minDelayMs, maxDelayMs, jitter).
- `telegram.proxy`: proxy URL for Bot API calls (SOCKS/HTTP).
- `telegram.webhookUrl`: enable webhook mode.
- `telegram.webhookSecret`: webhook secret (optional).
- `telegram.webhookPath`: local webhook path (default `/telegram-webhook`).
- `telegram.actions.reactions`: gate Telegram tool reactions.
- `telegram.actions.sendMessage`: gate Telegram tool message sends.

Related global options:
- `routing.groupChat.mentionPatterns` (mention gating patterns).
- `commands.native`, `commands.text`, `commands.useAccessGroups` (command behavior).
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`.
