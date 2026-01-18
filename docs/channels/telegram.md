---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
---
# Telegram (Bot API)


Status: production-ready for bot DMs + groups via grammY. Long-polling by default; webhook optional.

## Quick setup (beginner)
1) Create a bot with **@BotFather** and copy the token.
2) Set the token:
   - Env: `TELEGRAM_BOT_TOKEN=...`
   - Or config: `channels.telegram.botToken: "..."`.
   - If both are set, config takes precedence (env fallback is default-account only).
3) Start the gateway.
4) DM access is pairing by default; approve the pairing code on first contact.

Minimal config:
```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing"
    }
  }
}
```

## What it is
- A Telegram Bot API channel owned by the Gateway.
- Deterministic routing: replies go back to Telegram; the model never chooses channels.
- DMs share the agent's main session; groups stay isolated (`agent:<agentId>:telegram:group:<chatId>`).

## Setup (fast path)
### 1) Create a bot token (BotFather)
1) Open Telegram and chat with **@BotFather**.
2) Run `/newbot`, then follow the prompts (name + username ending in `bot`).
3) Copy the token and store it safely.

Optional BotFather settings:
- `/setjoingroups` — allow/deny adding the bot to groups.
- `/setprivacy` — control whether the bot sees all group messages.

### 2) Configure the token (env or config)
Example:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } }
    }
  }
}
```

Env option: `TELEGRAM_BOT_TOKEN=...` (works for the default account).
If both env and config are set, config takes precedence.

Multi-account support: use `channels.telegram.accounts` with per-account tokens and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

3) Start the gateway. Telegram starts when a token is resolved (config first, env fallback).
4) DM access defaults to pairing. Approve the code when the bot is first contacted.
5) For groups: add the bot, decide privacy/admin behavior (below), then set `channels.telegram.groups` to control mention gating + allowlists.

## Token + privacy + permissions (Telegram side)

### Token creation (BotFather)
- `/newbot` creates the bot and returns the token (keep it secret).
- If a token leaks, revoke/regenerate it via @BotFather and update your config.

### Group message visibility (Privacy Mode)
Telegram bots default to **Privacy Mode**, which limits which group messages they receive.
If your bot must see *all* group messages, you have two options:
- Disable privacy mode with `/setprivacy` **or**
- Add the bot as a group **admin** (admin bots receive all messages).

**Note:** When you toggle privacy mode, Telegram requires removing + re‑adding the bot
to each group for the change to take effect.

### Group permissions (admin rights)
Admin status is set inside the group (Telegram UI). Admin bots always receive all
group messages, so use admin if you need full visibility.

## How it works (behavior)
- Inbound messages are normalized into the shared channel envelope with reply context and media placeholders.
- Group replies require a mention by default (native @mention or `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).
- Multi-agent override: set per-agent patterns on `agents.list[].groupChat.mentionPatterns`.
- Replies always route back to the same Telegram chat.
- Long-polling uses grammY runner with per-chat sequencing; overall concurrency is capped by `agents.defaults.maxConcurrent`.
- Telegram Bot API does not support read receipts; there is no `sendReadReceipts` option.

## Formatting (Telegram HTML)
- Outbound Telegram text uses `parse_mode: "HTML"` (Telegram’s supported tag subset).
- Markdown-ish input is rendered into **Telegram-safe HTML** (bold/italic/strike/code/links); block elements are flattened to text with newlines/bullets.
- Raw HTML from models is escaped to avoid Telegram parse errors.
- If Telegram rejects the HTML payload, Clawdbot retries the same message as plain text.

## Commands (native + custom)
Clawdbot registers native commands (like `/status`, `/reset`, `/model`) with Telegram’s bot menu on startup.
You can add custom commands to the menu via config:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" }
      ]
    }
  }
}
```

Notes:
- Custom commands are **menu entries only**; Clawdbot does not implement them unless you handle them elsewhere.
- Command names are normalized (leading `/` stripped, lowercased) and must match `a-z`, `0-9`, `_` (1–32 chars).
- Custom commands **cannot override native commands**. Conflicts are ignored and logged.
- If `commands.native` is disabled, only custom commands are registered (or cleared if none).

## Limits
- Outbound text is chunked to `channels.telegram.textChunkLimit` (default 4000).
- Media downloads/uploads are capped by `channels.telegram.mediaMaxMb` (default 5).
- Telegram Bot API requests time out after `channels.telegram.timeoutSeconds` (default 500 via grammY). Set lower to avoid long hangs.
- Group history context uses `channels.telegram.historyLimit` (or `channels.telegram.accounts.*.historyLimit`), falling back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).
- DM history can be limited with `channels.telegram.dmHistoryLimit` (user turns). Per-user overrides: `channels.telegram.dms["<user_id>"].historyLimit`.

## Group activation modes

By default, the bot only responds to mentions in groups (`@botname` or patterns in `agents.list[].groupChat.mentionPatterns`). To change this behavior:

### Via config (recommended)

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }  // always respond in this group
      }
    }
  }
}
```

**Important:** Setting `channels.telegram.groups` creates an **allowlist** - only listed groups (or `"*"`) will be accepted.
Forum topics inherit their parent group config (allowFrom, requireMention, skills, prompts) unless you add per-topic overrides under `channels.telegram.groups.<groupId>.topics.<topicId>`.

To allow all groups with always-respond:
```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }  // all groups, always respond
      }
    }
  }
}
```

To keep mention-only for all groups (default behavior):
```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }  // or omit groups entirely
      }
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

**Tip:** For your own user ID, DM the bot and it will reply with your user ID (pairing message), or use `/whoami` once commands are enabled.

**Privacy note:** `@userinfobot` is a third-party bot. If you prefer, add the bot to the group, send a message, and use `clawdbot logs --follow` to read `chat.id`, or use the Bot API `getUpdates`.

## Config writes
By default, Telegram is allowed to write config updates triggered by channel events or `/config set|unset`.

This happens when:
- A group is upgraded to a supergroup and Telegram emits `migrate_to_chat_id` (chat ID changes). Clawdbot can migrate `channels.telegram.groups` automatically.
- You run `/config set` or `/config unset` in a Telegram chat (requires `commands.config: true`).

Disable with:
```json5
{
  channels: { telegram: { configWrites: false } }
}
```

## Topics (forum supergroups)
Telegram forum topics include a `message_thread_id` per message. Clawdbot:
- Appends `:topic:<threadId>` to the Telegram group session key so each topic is isolated.
- Sends typing indicators and replies with `message_thread_id` so responses stay in the topic.
- General topic (thread id `1`) is special: message sends omit `message_thread_id` (Telegram rejects it), but typing indicators still include it.
- Exposes `MessageThreadId` + `IsForum` in template context for routing/templating.
- Topic-specific configuration is available under `channels.telegram.groups.<chatId>.topics.<threadId>` (skills, allowlists, auto-reply, system prompts, disable).
- Topic configs inherit group settings (requireMention, allowlists, skills, prompts, enabled) unless overridden per topic.

Private chats can include `message_thread_id` in some edge cases. Clawdbot keeps the DM session key unchanged, but still uses the thread id for replies/draft streaming when it is present.

## Inline Buttons

Telegram supports inline keyboards with callback buttons.

```json5
{
  "channels": {
    "telegram": {
      "capabilities": {
        "inlineButtons": "allowlist"
      }
    }
  }
}
```

For per-account configuration:
```json5
{
  "channels": {
    "telegram": {
      "accounts": {
        "main": {
          "capabilities": {
            "inlineButtons": "allowlist"
          }
        }
      }
    }
  }
}
```

Scopes:
- `off` — inline buttons disabled
- `dm` — only DMs (group targets blocked)
- `group` — only groups (DM targets blocked)
- `all` — DMs + groups
- `allowlist` — DMs + groups, but only senders allowed by `allowFrom`/`groupAllowFrom` (same rules as control commands)

Default: `allowlist`.
Legacy: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.

### Sending buttons

Use the message tool with the `buttons` parameter:

```json5
{
  "action": "send",
  "channel": "telegram",
  "to": "123456789",
  "message": "Choose an option:",
  "buttons": [
    [
      {"text": "Yes", "callback_data": "yes"},
      {"text": "No", "callback_data": "no"}
    ],
    [
      {"text": "Cancel", "callback_data": "cancel"}
    ]
  ]
}
```

When a user clicks a button, the callback data is sent back to the agent as a message with the format:
`callback_data: value`

### Configuration options

Telegram capabilities can be configured at two levels (object form shown above; legacy string arrays still supported):

- `channels.telegram.capabilities`: Global default capability config applied to all Telegram accounts unless overridden.
- `channels.telegram.accounts.<account>.capabilities`: Per-account capabilities that override the global defaults for that specific account.

Use the global setting when all Telegram bots/accounts should behave the same. Use per-account configuration when different bots need different behaviors (for example, one account only handles DMs while another is allowed in groups).
## Access control (DMs + groups)

### DM access
- Default: `channels.telegram.dmPolicy = "pairing"`. Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).
- Approve via:
  - `clawdbot pairing list telegram`
  - `clawdbot pairing approve telegram <CODE>`
- Pairing is the default token exchange used for Telegram DMs. Details: [Pairing](/start/pairing)
- `channels.telegram.allowFrom` accepts numeric user IDs (recommended) or `@username` entries. It is **not** the bot username; use the human sender’s ID.

#### Finding your Telegram user ID
Safer (no third-party bot):
1) Start the gateway and DM your bot.
2) Run `clawdbot logs --follow` and look for `from.id`.

Alternate (official Bot API):
1) DM your bot.
2) Fetch updates with your bot token and read `message.from.id`:
   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

Third-party (less private):
- DM `@userinfobot` or `@getidsbot` and use the returned user id.

### Group access

Two independent controls:

**1. Which groups are allowed** (group allowlist via `channels.telegram.groups`):
- No `groups` config = all groups allowed
- With `groups` config = only listed groups or `"*"` are allowed
- Example: `"groups": { "-1001234567890": {}, "*": {} }` allows all groups

**2. Which senders are allowed** (sender filtering via `channels.telegram.groupPolicy`):
- `"open"` = all senders in allowed groups can message
- `"allowlist"` = only senders in `channels.telegram.groupAllowFrom` can message
- `"disabled"` = no group messages accepted at all
Default is `groupPolicy: "allowlist"` (blocked unless you add `groupAllowFrom`).

Most users want: `groupPolicy: "allowlist"` + `groupAllowFrom` + specific groups listed in `channels.telegram.groups`

## Long-polling vs webhook
- Default: long-polling (no public URL required).
- Webhook mode: set `channels.telegram.webhookUrl` (optionally `channels.telegram.webhookSecret` + `channels.telegram.webhookPath`).
  - The local listener binds to `0.0.0.0:8787` and serves `POST /telegram-webhook` by default.
  - If your public URL is different, use a reverse proxy and point `channels.telegram.webhookUrl` at the public endpoint.

## Reply threading
Telegram supports optional threaded replies via tags:
- `[[reply_to_current]]` -- reply to the triggering message.
- `[[reply_to:<id>]]` -- reply to a specific message id.

Controlled by `channels.telegram.replyToMode`:
- `first` (default), `all`, `off`.

## Audio messages (voice vs file)
Telegram distinguishes **voice notes** (round bubble) from **audio files** (metadata card).
Clawdbot defaults to audio files for backward compatibility.

To force a voice note bubble in agent replies, include this tag anywhere in the reply:
- `[[audio_as_voice]]` — send audio as a voice note instead of a file.

The tag is stripped from the delivered text. Other channels ignore this tag.

For message tool sends, set `asVoice: true` with a voice-compatible audio `media` URL
(`message` is optional when media is present):

```json5
{
  "action": "send",
  "channel": "telegram",
  "to": "123456789",
  "media": "https://example.com/voice.ogg",
  "asVoice": true
}
```

## Streaming (drafts)
Telegram can stream **draft bubbles** while the agent is generating a response.
Clawdbot uses Bot API `sendMessageDraft` (not real messages) and then sends the
final reply as a normal message.

Requirements (Telegram Bot API 9.3+):
- **Private chats with topics enabled** (forum topic mode for the bot).
- Incoming messages must include `message_thread_id` (private topic thread).
- Streaming is ignored for groups/supergroups/channels.

Config:
- `channels.telegram.streamMode: "off" | "partial" | "block"` (default: `partial`)
  - `partial`: update the draft bubble with the latest streaming text.
  - `block`: update the draft bubble in larger blocks (chunked).
  - `off`: disable draft streaming.
- Optional (only for `streamMode: "block"`):
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - defaults: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (clamped to `channels.telegram.textChunkLimit`).

Note: draft streaming is separate from **block streaming** (channel messages).
Block streaming is off by default and requires `channels.telegram.blockStreaming: true`
if you want early Telegram messages instead of draft updates.

Reasoning stream (Telegram only):
- `/reasoning stream` streams reasoning into the draft bubble while the reply is
  generating, then sends the final answer without reasoning.
- If `channels.telegram.streamMode` is `off`, reasoning stream is disabled.
More context: [Streaming + chunking](/concepts/streaming).

## Retry policy
Outbound Telegram API calls retry on transient network/429 errors with exponential backoff and jitter. Configure via `channels.telegram.retry`. See [Retry policy](/concepts/retry).

## Agent tool (messages + reactions)
- Tool: `telegram` with `sendMessage` action (`to`, `content`, optional `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- Tool: `telegram` with `react` action (`chatId`, `messageId`, `emoji`).
- Tool: `telegram` with `deleteMessage` action (`chatId`, `messageId`).
- Reaction removal semantics: see [/tools/reactions](/tools/reactions).
- Tool gating: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (default: enabled).

## Reaction notifications

**How reactions work:**
Telegram reactions arrive as **separate `message_reaction` events**, not as properties in message payloads. When a user adds a reaction, Clawdbot:

1. Receives the `message_reaction` update from Telegram API
2. Converts it to a **system event** with format: `"Telegram reaction added: {emoji} by {user} on msg {id}"`
3. Enqueues the system event using the **same session key** as regular messages
4. When the next message arrives in that conversation, system events are drained and prepended to the agent's context

The agent sees reactions as **system notifications** in the conversation history, not as message metadata.

**Configuration:**
- `channels.telegram.reactionNotifications`: Controls which reactions trigger notifications
  - `"off"` — ignore all reactions
  - `"own"` — notify when users react to bot messages (best-effort; in-memory) (default)
  - `"all"` — notify for all reactions

- `channels.telegram.reactionLevel`: Controls agent's reaction capability
  - `"off"` — agent cannot react to messages
  - `"ack"` — bot sends acknowledgment reactions (👀 while processing) (default)
  - `"minimal"` — agent can react sparingly (guideline: 1 per 5-10 exchanges)
  - `"extensive"` — agent can react liberally when appropriate

**Forum groups:** Reactions in forum groups include `message_thread_id` and use session keys like `agent:main:telegram:group:{chatId}:topic:{threadId}`. This ensures reactions and messages in the same topic stay together.

**Example config:**
```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all",  // See all reactions
      reactionLevel: "minimal"        // Agent can react sparingly
    }
  }
}
```

**Requirements:**
- Telegram bots must explicitly request `message_reaction` in `allowed_updates` (configured automatically by Clawdbot)
- For webhook mode, reactions are included in the webhook `allowed_updates`
- For polling mode, reactions are included in the `getUpdates` `allowed_updates`

## Delivery targets (CLI/cron)
- Use a chat id (`123456789`) or a username (`@name`) as the target.
- Example: `clawdbot message send --channel telegram --target 123456789 --message "hi"`.

## Troubleshooting

**Bot doesn’t respond to non-mention messages in a group:**
- If you set `channels.telegram.groups.*.requireMention=false`, Telegram’s Bot API **privacy mode** must be disabled.
  - BotFather: `/setprivacy` → **Disable** (then remove + re-add the bot to the group)
- `clawdbot channels status` shows a warning when config expects unmentioned group messages.
- `clawdbot channels status --probe` can additionally check membership for explicit numeric group IDs (it can’t audit wildcard `"*"` rules).
- Quick test: `/activation always` (session-only; use config for persistence)

**Bot not seeing group messages at all:**
- If `channels.telegram.groups` is set, the group must be listed or use `"*"`
- Check Privacy Settings in @BotFather → "Group Privacy" should be **OFF**
- Verify bot is actually a member (not just an admin with no read access)
- Check gateway logs: `clawdbot logs --follow` (look for "skipping group message")

**Bot responds to mentions but not `/activation always`:**
- The `/activation` command updates session state but doesn't persist to config
- For persistent behavior, add group to `channels.telegram.groups` with `requireMention: false`

**Commands like `/status` don't work:**
- Make sure your Telegram user ID is authorized (via pairing or `channels.telegram.allowFrom`)
- Commands require authorization even in groups with `groupPolicy: "open"`

**Bot starts, then silently stops responding (or logs `HttpError: Network request ... failed`):**
- Some hosts resolve `api.telegram.org` to IPv6 first. If your server does not have working IPv6 egress, grammY can get stuck on IPv6-only requests.
- Fix by enabling IPv6 egress **or** forcing IPv4 resolution for `api.telegram.org` (for example, add an `/etc/hosts` entry using the IPv4 A record, or prefer IPv4 in your OS DNS stack), then restart the gateway.
- Quick check: `dig +short api.telegram.org A` and `dig +short api.telegram.org AAAA` to confirm what DNS returns.

## Configuration reference (Telegram)
Full configuration: [Configuration](/gateway/configuration)

Provider options:
- `channels.telegram.enabled`: enable/disable channel startup.
- `channels.telegram.botToken`: bot token (BotFather).
- `channels.telegram.tokenFile`: read token from file path.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.telegram.allowFrom`: DM allowlist (ids/usernames). `open` requires `"*"`.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (default: allowlist).
- `channels.telegram.groupAllowFrom`: group sender allowlist (ids/usernames).
- `channels.telegram.groups`: per-group defaults + allowlist (use `"*"` for global defaults).
  - `channels.telegram.groups.<id>.requireMention`: mention gating default.
  - `channels.telegram.groups.<id>.skills`: skill filter (omit = all skills, empty = none).
  - `channels.telegram.groups.<id>.allowFrom`: per-group sender allowlist override.
  - `channels.telegram.groups.<id>.systemPrompt`: extra system prompt for the group.
  - `channels.telegram.groups.<id>.enabled`: disable the group when `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: per-topic overrides (same fields as group).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: per-topic mention gating override.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (default: allowlist).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: per-account override.
- `channels.telegram.replyToMode`: `off | first | all` (default: `first`).
- `channels.telegram.textChunkLimit`: outbound chunk size (chars).
- `channels.telegram.streamMode`: `off | partial | block` (draft streaming).
- `channels.telegram.mediaMaxMb`: inbound/outbound media cap (MB).
- `channels.telegram.retry`: retry policy for outbound Telegram API calls (attempts, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.proxy`: proxy URL for Bot API calls (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: enable webhook mode.
- `channels.telegram.webhookSecret`: webhook secret (optional).
- `channels.telegram.webhookPath`: local webhook path (default `/telegram-webhook`).
- `channels.telegram.actions.reactions`: gate Telegram tool reactions.
- `channels.telegram.actions.sendMessage`: gate Telegram tool message sends.
- `channels.telegram.actions.deleteMessage`: gate Telegram tool message deletes.
- `channels.telegram.reactionNotifications`: `off | own | all` — control which reactions trigger system events (default: `own` when not set).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — control agent's reaction capability (default: `minimal` when not set).

Related global options:
- `agents.list[].groupChat.mentionPatterns` (mention gating patterns).
- `messages.groupChat.mentionPatterns` (global fallback).
- `commands.native` (defaults to `"auto"` → on for Telegram/Discord, off for Slack), `commands.text`, `commands.useAccessGroups` (command behavior). Override with `channels.telegram.commands.native`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.
