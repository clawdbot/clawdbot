---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
title: "Telegram"
---

# Telegram (Bot API)

Status: production-ready for bot DMs + groups via grammY. Long polling is the default mode; webhook mode is optional.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Default DM policy for Telegram is pairing.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
  <Card title="Gateway configuration" icon="settings" href="/gateway/configuration">
    Full channel config patterns and examples.
  </Card>
</CardGroup>

## Quick setup

<Steps>
  <Step title="Create the bot token in BotFather">
    Open Telegram and chat with **@BotFather** (confirm the handle is exactly `@BotFather`).

    Run `/newbot`, follow prompts, and save the token.

  </Step>

  <Step title="Configure token and DM policy">

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

    Env fallback: `TELEGRAM_BOT_TOKEN=...` (default account only).
    Telegram does **not** use `openclaw channels login telegram`; configure token in config/env, then start gateway.

  </Step>

  <Step title="Start gateway and approve first DM">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    Pairing codes expire after 1 hour.

  </Step>

  <Step title="Add the bot to a group">
    Add the bot to your group, then set `channels.telegram.groups` and `groupPolicy` to match your access model.
  </Step>
</Steps>

<Note>
Token resolution order is account-aware. In practice, config values win over env fallback, and `TELEGRAM_BOT_TOKEN` only applies to the default account.
</Note>

## Telegram side settings

<AccordionGroup>
  <Accordion title="Privacy mode and group visibility">
    Telegram bots default to **Privacy Mode**, which limits what group messages they receive.

    If the bot must see all group messages, either:

    - disable privacy mode via `/setprivacy`, or
    - make the bot a group admin.

    When toggling privacy mode, remove + re-add the bot in each group so Telegram applies the change.

  </Accordion>

  <Accordion title="Group permissions">
    Admin status is controlled in Telegram group settings.

    Admin bots receive all group messages, which is useful for always-on group behavior.

  </Accordion>

  <Accordion title="Helpful BotFather toggles">

    - `/setjoingroups` to allow/deny group adds
    - `/setprivacy` for group visibility behavior

  </Accordion>
</AccordionGroup>

## Access control and activation

<Tabs>
  <Tab title="DM policy">
    `channels.telegram.dmPolicy` controls direct message access:

    - `pairing` (default)
    - `allowlist` (requires at least one sender ID in `allowFrom`)
    - `open` (requires `allowFrom` to include `"*"`)
    - `disabled`

    `channels.telegram.allowFrom` accepts numeric Telegram user IDs. `telegram:` / `tg:` prefixes are accepted and normalized.
    `dmPolicy: "allowlist"` with empty `allowFrom` blocks all DMs and is rejected by config validation.
    Setup asks for numeric user IDs only.
    If you upgraded and your config contains `@username` allowlist entries, run `openclaw doctor --fix` to resolve them (best-effort; requires a Telegram bot token).
    If you previously relied on pairing-store allowlist files, `openclaw doctor --fix` can recover entries into `channels.telegram.allowFrom` in allowlist flows (for example when `dmPolicy: "allowlist"` has no explicit IDs yet).

    For one-owner bots, prefer `dmPolicy: "allowlist"` with explicit numeric `allowFrom` IDs to keep access policy durable in config (instead of depending on previous pairing approvals).

    Common confusion: DM pairing approval does not mean "this sender is authorized everywhere".
    Pairing grants DM access only. Group sender authorization still comes from explicit config allowlists.
    If you want "I am authorized once and both DMs and group commands work", put your numeric Telegram user ID in `channels.telegram.allowFrom`.

    ### Finding your Telegram user ID

    Safer (no third-party bot):

    1. DM your bot.
    2. Run `openclaw logs --follow`.
    3. Read `from.id`.

    Official Bot API method:

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    Third-party method (less private): `@userinfobot` or `@getidsbot`.

  </Tab>

  <Tab title="Group policy and allowlists">
    Two controls apply together:

    1. **Which groups are allowed** (`channels.telegram.groups`)
       - no `groups` config:
         - with `groupPolicy: "open"`: any group can pass group-ID checks
         - with `groupPolicy: "allowlist"` (default): groups are blocked until you add `groups` entries (or `"*"`)
       - `groups` configured: acts as allowlist (explicit IDs or `"*"`)

    2. **Which senders are allowed in groups** (`channels.telegram.groupPolicy`)
       - `open`
       - `allowlist` (default)
       - `disabled`

    `groupAllowFrom` is used for group sender filtering. If not set, Telegram falls back to `allowFrom`.
    `groupAllowFrom` entries should be numeric Telegram user IDs (`telegram:` / `tg:` prefixes are normalized).
    Do not put Telegram group or supergroup chat IDs in `groupAllowFrom`. Negative chat IDs belong under `channels.telegram.groups`.
    Non-numeric entries are ignored for sender authorization.
    Security boundary (`2026.2.25+`): group sender auth does **not** inherit DM pairing-store approvals.
    Pairing stays DM-only. For groups, set `groupAllowFrom` or per-group/per-topic `allowFrom`.
    If `groupAllowFrom` is unset, Telegram falls back to config `allowFrom`, not the pairing store.
    Practical pattern for one-owner bots: set your user ID in `channels.telegram.allowFrom`, leave `groupAllowFrom` unset, and allow the target groups under `channels.telegram.groups`.
    Runtime note: if `channels.telegram` is completely missing, runtime defaults to fail-closed `groupPolicy="allowlist"` unless `channels.defaults.groupPolicy` is explicitly set.

    Example: allow any member in one specific group:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

    Example: allow only specific users inside one specific group:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          requireMention: true,
          allowFrom: ["8734062810", "745123456"],
        },
      },
    },
  },
}
```

    <Warning>
      Common mistake: `groupAllowFrom` is not a Telegram group allowlist.

      - Put negative Telegram group or supergroup chat IDs like `-1001234567890` under `channels.telegram.groups`.
      - Put Telegram user IDs like `8734062810` under `groupAllowFrom` when you want to limit which people inside an allowed group can trigger the bot.
      - Use `groupAllowFrom: ["*"]` only when you want any member of an allowed group to be able to talk to the bot.
    </Warning>

  </Tab>

  <Tab title="Mention behavior">
    Group replies require mention by default.

    Mention can come from:

    - native `@botusername` mention, or
    - mention patterns in:
      - `agents.list[].groupChat.mentionPatterns`
      - `messages.groupChat.mentionPatterns`

    Session-level command toggles:

    - `/activation always`
    - `/activation mention`

    These update session state only. Use config for persistence.

    Persistent config example:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

    Getting the group chat ID:

    - forward a group message to `@userinfobot` / `@getidsbot`
    - or read `chat.id` from `openclaw logs --follow`
    - or inspect Bot API `getUpdates`

  </Tab>
</Tabs>

## Runtime behavior

- Telegram is owned by the gateway process.
- Routing is deterministic: Telegram inbound replies back to Telegram (the model does not pick channels).
- Inbound messages normalize into the shared channel envelope with reply metadata and media placeholders.
- Group sessions are isolated by group ID. Forum topics append `:topic:<threadId>` to keep topics isolated.
- DM messages can carry `message_thread_id`; OpenClaw routes them with thread-aware session keys and preserves thread ID for replies.
- Long polling uses grammY runner with per-chat/per-thread sequencing. Overall runner sink concurrency uses `agents.defaults.maxConcurrent`.
- Long-polling watchdog restarts trigger after 120 seconds without completed `getUpdates` liveness by default. Increase `channels.telegram.pollingStallThresholdMs` only if your deployment still sees false polling-stall restarts during long-running work. The value is in milliseconds and is allowed from `30000` to `600000`; per-account overrides are supported.
- Telegram Bot API has no read-receipt support (`sendReadReceipts` does not apply).

## Feature reference

<AccordionGroup>
  <Accordion title="Live stream preview (message edits)">
    OpenClaw can stream partial replies in real time:

    - direct chats: preview message + `editMessageText`
    - groups/topics: preview message + `editMessageText`

    Requirement:

    - `channels.telegram.streaming` is `off | partial | block | progress` (default: `partial`)
    - `progress` maps to `partial` on Telegram (compat with cross-channel naming)
    - `streaming.preview.toolProgress` controls whether tool/progress updates reuse the same edited preview message (default: `true`). Set `false` to keep separate tool/progress messages.
    - legacy `channels.telegram.streamMode` and boolean `streaming` values are auto-mapped

    For text-only replies:

    - DM: OpenClaw keeps the same preview message and performs a final edit in place (no second message)
    - group/topic: OpenClaw keeps the same preview message and performs a final edit in place (no second message)

    For complex replies (for example media payloads), OpenClaw falls back to normal final delivery and then cleans up the preview message.

    Preview streaming is separate from block streaming. When block streaming is explicitly enabled for Telegram, OpenClaw skips the preview stream to avoid double-streaming.

    If native draft transport is unavailable/rejected, OpenClaw automatically falls back to `sendMessage` + `editMessageText`.

    Telegram-only reasoning stream:

    - `/reasoning stream` sends reasoning to the live preview while generating
    - final answer is sent without reasoning text

  </Accordion>

  <Accordion title="Formatting and HTML fallback">
    Outbound text uses Telegram `parse_mode: "HTML"`.

    - Markdown-ish text is rendered to Telegram-safe HTML.
    - Raw model HTML is escaped to reduce Telegram parse failures.
    - If Telegram rejects parsed HTML, OpenClaw retries as plain text.

    Link previews are enabled by default and can be disabled with `channels.telegram.linkPreview: false`.

  </Accordion>

  <Accordion title="Native commands and custom commands">
    Telegram command menu registration is handled at startup with `setMyCommands`.

    Native command defaults:

    - `commands.native: "auto"` enables native commands for Telegram

    Add custom command menu entries:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

    Rules:

    - names are normalized (strip leading `/`, lowercase)
    - valid pattern: `a-z`, `0-9`, `_`, length `1..32`
    - custom commands cannot override native commands
    - conflicts/duplicates are skipped and logged

    Notes:

    - custom commands are menu entries only; they do not auto-implement behavior
    - plugin/skill commands can still work when typed even if not shown in Telegram menu

    If native commands are disabled, built-ins are removed. Custom/plugin commands may still register if configured.

    Common setup failures:

    - `setMyCommands failed` with `BOT_COMMANDS_TOO_MUCH` means the Telegram menu still overflowed after trimming; reduce plugin/skill/custom commands or disable `channels.telegram.commands.native`.
    - `setMyCommands failed` with network/fetch errors usually means outbound DNS/HTTPS to `api.telegram.org` is blocked.

    ### Device pairing commands (`device-pair` plugin)

    When the `device-pair` plugin is installed:

    1. `/pair` generates setup code
    2. paste code in iOS app
    3. `/pair pending` lists pending requests (including role/scopes)
    4. approve the request:
       - `/pair approve <requestId>` for explicit approval
       - `/pair approve` when there is only one pending request
       - `/pair approve latest` for most recent

    The setup code carries a short-lived bootstrap token. Built-in bootstrap handoff keeps the primary node token at `scopes: []`; any handed-off operator token stays bounded to `operator.approvals`, `operator.read`, `operator.talk.secrets`, and `operator.write`. Bootstrap scope checks are role-prefixed, so that operator allowlist only satisfies operator requests; non-operator roles still need scopes under their own role prefix.

    If a device retries with changed auth details (for example role/scopes/public key), the previous pending request is superseded and the new request uses a different `requestId`. Re-run `/pair pending` before approving.

    More details: [Pairing](/channels/pairing#pair-via-telegram-recommended-for-ios).

  </Accordion>

  <Accordion title="Inline buttons">
    Configure inline keyboard scope:

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

    Per-account override:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

    Scopes:

    - `off`
    - `dm`
    - `group`
    - `all`
    - `allowlist` (default)

    Legacy `capabilities: ["inlineButtons"]` maps to `inlineButtons: "all"`.

    Message action example:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

    Callback clicks are passed to the agent as text:
    `callback_data: <value>`

  </Accordion>

  <Accordion title="Telegram message actions for agents and automation">
    Telegram tool actions include:

    - `sendMessage` (`to`, `content`, optional `mediaUrl`, `replyToMessageId`, `messageThreadId`)
    - `react` (`chatId`, `messageId`, `emoji`)
    - `deleteMessage` (`chatId`, `messageId`)
    - `editMessage` (`chatId`, `messageId`, `content`)
    - `createForumTopic` (`chatId`, `name`, optional `iconColor`, `iconCustomEmojiId`)

    Channel message actions expose ergonomic aliases (`send`, `react`, `delete`, `edit`, `sticker`, `sticker-search`, `topic-create`).

    Gating controls:

    - `channels.telegram.actions.sendMessage`
    - `channels.telegram.actions.deleteMessage`
    - `channels.telegram.actions.reactions`
    - `channels.telegram.actions.sticker` (default: disabled)

    Note: `edit` and `topic-create` are currently enabled by default and do not have separate `channels.telegram.actions.*` toggles.
    Runtime sends use the active config/secrets snapshot (startup/reload), so action paths do not perform ad-hoc SecretRef re-resolution per send.

    Reaction removal semantics: [/tools/reactions](/tools/reactions)

  </Accordion>

  <Accordion title="Reply threading tags">
    Telegram supports explicit reply threading tags in generated output:

    - `[[reply_to_current]]` replies to the triggering message
    - `[[reply_to:<id>]]` replies to a specific Telegram message ID

    `channels.telegram.replyToMode` controls handling:

    - `off` (default)
    - `first`
    - `all`

    Note: `off` disables implicit reply threading. Explicit `[[reply_to_*]]` tags are still honored.

  </Accordion>

  <Accordion title="Forum topics and thread behavior">
    Forum supergroups:

    - topic session keys append `:topic:<threadId>`
    - replies and typing target the topic thread
    - topic config path:
      `channels.telegram.groups.<chatId>.topics.<threadId>`

    General topic (`threadId=1`) special-case:

    - message sends omit `message_thread_id` (Telegram rejects `sendMessage(...thread_id=1)`)
    - typing actions still include `message_thread_id`

    Topic inheritance: topic entries inherit group settings unless overridden (`requireMention`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`).
    `agentId` is topic-only and does not inherit from group defaults.

    **Per-topic agent routing**: Each topic can route to a different agent by setting `agentId` in the topic config. This gives each topic its own isolated workspace, memory, and session. Example:

    ```json5
    {
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "1": { agentId: "main" },      // General topic → main agent
                "3": { agentId: "zu" },        // Dev topic → zu agent
                "5": { agentId: "coder" }      // Code review → coder agent
              }
            }
          }
        }
      }
    }
    ```

    Each topic then has its own session key: `agent:zu:telegram:group:-1001234567890:topic:3`

    **Persistent ACP topic binding**: Forum topics can pin ACP harness sessions through top-level typed ACP bindings:

    - `bindings[]` with `type: "acp"` and `match.channel: "telegram"`

    Example:

    ```json5
    {
      agents: {
        list: [
          {
            id: "codex",
            runtime: {
              type: "acp",
              acp: {
                agent: "codex",
                backend: "acpx",
                mode: "persistent",
                cwd: "/workspace/openclaw",
              },
            },
          },
        ],
      },
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "-1001234567890:topic:42" },
          },
        },
      ],
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    }
    ```

    This is currently scoped to forum topics in groups and supergroups.

    **Thread-bound ACP spawn from chat**:

    - `/acp spawn <agent> --thread here|auto` can bind the current Telegram topic to a new ACP session.
    - Follow-up topic messages route to the bound ACP session directly (no `/acp steer` required).
    - OpenClaw pins the spawn confirmation message in-topic after a successful bind.
    - Requires `channels.telegram.threadBindings.spawnAcpSessions=true`.

    Template context includes:

    - `MessageThreadId`
    - `IsForum`

    DM thread behavior:

    - private chats with `message_thread_id` keep DM routing but use thread-aware session keys/reply targets.

  </Accordion>

  <Accordion title="Audio, video, and stickers">
    ### Audio messages

    Telegram distinguishes voice notes vs audio files.

    - default: audio file behavior
    - tag `[[audio_as_voice]]` in agent reply to force voice-note send

    Message action example:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

    ### Video messages

    Telegram distinguishes video files vs video notes.

    Message action example:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

    Video notes do not support captions; provided message text is sent separately.

    ### Stickers

    Inbound sticker handling:

    - static WEBP: downloaded and processed (placeholder `<media:sticker>`)
    - animated TGS: skipped
    - video WEBM: skipped

    Sticker context fields:

    - `Sticker.emoji`
    - `Sticker.setName`
    - `Sticker.fileId`
    - `Sticker.fileUniqueId`
    - `Sticker.cachedDescription`

    Sticker cache file:

    - `~/.openclaw/telegram/sticker-cache.json`

    Stickers are described once (when possible) and cached to reduce repeated vision calls.

    Enable sticker actions:

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

    Send sticker action:

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

    Search cached stickers:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

  </Accordion>

  <Accordion title="Reaction notifications">
    Telegram reactions arrive as `message_reaction` updates (separate from message payloads).

    When enabled, OpenClaw enqueues system events like:

    - `Telegram reaction added: 👍 by Alice (@alice) on msg 42`

    Config:

    - `channels.telegram.reactionNotifications`: `off | own | all` (default: `own`)
    - `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` (default: `minimal`)

    Notes:

    - `own` means user reactions to bot-sent messages only (best-effort via sent-message cache).
    - Reaction events still respect Telegram access controls (`dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`); unauthorized senders are dropped.
    - Telegram does not provide thread IDs in reaction updates.
      - non-forum groups route to group chat session
      - forum groups route to the group general-topic session (`:topic:1`), not the exact originating topic

    `allowed_updates` for polling/webhook include `message_reaction` automatically.

  </Accordion>

  <Accordion title="Ack reactions">
    `ackReaction` sends an acknowledgement emoji while OpenClaw is processing an inbound message.

    Resolution order:

    - `channels.telegram.accounts.<accountId>.ackReaction`
    - `channels.telegram.ackReaction`
    - `messages.ackReaction`
    - agent identity emoji fallback (`agents.list[].identity.emoji`, else "👀")

    Notes:

    - Telegram expects unicode emoji (for example "👀").
    - Use `""` to disable the reaction for a channel or account.

  </Accordion>

  <Accordion title="Config writes from Telegram events and commands">
    Channel config writes are enabled by default (`configWrites !== false`).

    Telegram-triggered writes include:

    - group migration events (`migrate_to_chat_id`) to update `channels.telegram.groups`
    - `/config set` and `/config unset` (requires command enablement)

    Disable:

```json5
{
  channels: {
    telegram: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Long polling vs webhook">
    Default: long polling.

    Webhook mode:

    - set `channels.telegram.webhookUrl`
    - set `channels.telegram.webhookSecret` (required when webhook URL is set)
    - optional `channels.telegram.webhookPath` (default `/telegram-webhook`)
    - optional `channels.telegram.webhookHost` (default `127.0.0.1`)
    - optional `channels.telegram.webhookPort` (default `8787`)

    Default local listener for webhook mode binds to `127.0.0.1:8787`.

    If your public endpoint differs, place a reverse proxy in front and point `webhookUrl` at the public URL.
    Set `webhookHost` (for example `0.0.0.0`) when you intentionally need external ingress.

  </Accordion>

  <Accordion title="Limits, retry, and CLI targets">
    - `channels.telegram.textChunkLimit` default is 4000.
    - `channels.telegram.chunkMode="newline"` prefers paragraph boundaries (blank lines) before length splitting.
    - `channels.telegram.mediaMaxMb` (default 100) caps inbound and outbound Telegram media size.
    - `channels.telegram.timeoutSeconds` overrides Telegram API client timeout (if unset, grammY default applies).
    - `channels.telegram.pollingStallThresholdMs` defaults to `120000`; tune between `30000` and `600000` only for false-positive polling-stall restarts.
    - group context history uses `channels.telegram.historyLimit` or `messages.groupChat.historyLimit` (default 50); `0` disables.
    - reply/quote/forward supplemental context is currently passed as received.
    - Telegram allowlists primarily gate who can trigger the agent, not a full supplemental-context redaction boundary.
    - DM history controls:
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - `channels.telegram.retry` config applies to Telegram send helpers (CLI/tools/actions) for recoverable outbound API errors.

    CLI send target can be numeric chat ID or username:

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
```

    Telegram polls use `openclaw message poll` and support forum topics:

```bash
openclaw message poll --channel telegram --target 123456789 \
  --poll-question "Ship it?" --poll-option "Yes" --poll-option "No"
openclaw message poll --channel telegram --target -1001234567890:topic:42 \
  --poll-question "Pick a time" --poll-option "10am" --poll-option "2pm" \
  --poll-duration-seconds 300 --poll-public
```

    Telegram-only poll flags:

    - `--poll-duration-seconds` (5-600)
    - `--poll-anonymous`
    - `--poll-public`
    - `--thread-id` for forum topics (or use a `:topic:` target)

    Telegram send also supports:

    - `--buttons` for inline keyboards when `channels.telegram.capabilities.inlineButtons` allows it
    - `--force-document` to send outbound images and GIFs as documents instead of compressed photo or animated-media uploads

    Action gating:

    - `channels.telegram.actions.sendMessage=false` disables outbound Telegram messages, including polls
    - `channels.telegram.actions.poll=false` disables Telegram poll creation while leaving regular sends enabled

  </Accordion>

  <Accordion title="Exec approvals in Telegram">
    Telegram supports exec approvals in approver DMs and can optionally post approval prompts in the originating chat or topic.

    Config path:

    - `channels.telegram.execApprovals.enabled`
    - `channels.telegram.execApprovals.approvers` (optional; falls back to numeric owner IDs inferred from `allowFrom` and direct `defaultTo` when possible)
    - `channels.telegram.execApprovals.target` (`dm` | `channel` | `both`, default: `dm`)
    - `agentFilter`, `sessionFilter`

    Approvers must be numeric Telegram user IDs. Telegram auto-enables native exec approvals when `enabled` is unset or `"auto"` and at least one approver can be resolved, either from `execApprovals.approvers` or from the account's numeric owner config (`allowFrom` and direct-message `defaultTo`). Set `enabled: false` to disable Telegram as a native approval client explicitly. Approval requests otherwise fall back to other configured approval routes or the exec approval fallback policy.

    Telegram also renders the shared approval buttons used by other chat channels. The native Telegram adapter mainly adds approver DM routing, channel/topic fanout, and typing hints before delivery.
    When those buttons are present, they are the primary approval UX; OpenClaw
    should only include a manual `/approve` command when the tool result says
    chat approvals are unavailable or manual approval is the only path.

    Delivery rules:

    - `target: "dm"` sends approval prompts only to resolved approver DMs
    - `target: "channel"` sends the prompt back to the originating Telegram chat/topic
    - `target: "both"` sends to approver DMs and the originating chat/topic

    Only resolved approvers can approve or deny. Non-approvers cannot use `/approve` and cannot use Telegram approval buttons.

    Approval resolution behavior:

    - IDs prefixed with `plugin:` always resolve through plugin approvals.
    - Other approval IDs try `exec.approval.resolve` first.
    - If Telegram is also authorized for plugin approvals and the gateway says
      the exec approval is unknown/expired, Telegram retries once through
      `plugin.approval.resolve`.
    - Real exec approval denials/errors do not silently fall through to plugin
      approval resolution.

    Channel delivery shows the command text in the chat, so only enable `channel` or `both` in trusted groups/topics. When the prompt lands in a forum topic, OpenClaw preserves the topic for both the approval prompt and the post-approval follow-up. Exec approvals expire after 30 minutes by default.

    Inline approval buttons also depend on `channels.telegram.capabilities.inlineButtons` allowing the target surface (`dm`, `group`, or `all`).

    Related docs: [Exec approvals](/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## Error reply controls

When the agent encounters a delivery or provider error, Telegram can either reply with the error text or suppress it. Two config keys control this behavior:

| Key                                 | Values            | Default | Description                                                                                     |
| ----------------------------------- | ----------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `channels.telegram.errorPolicy`     | `reply`, `silent` | `reply` | `reply` sends a friendly error message to the chat. `silent` suppresses error replies entirely. |
| `channels.telegram.errorCooldownMs` | number (ms)       | `60000` | Minimum time between error replies to the same chat. Prevents error spam during outages.        |

Per-account, per-group, and per-topic overrides are supported (same inheritance as other Telegram config keys).

```json5
{
  channels: {
    telegram: {
      errorPolicy: "reply",
      errorCooldownMs: 120000,
      groups: {
        "-1001234567890": {
          errorPolicy: "silent", // suppress errors in this group
        },
      },
    },
  },
}
```

## Troubleshooting

<AccordionGroup>
  <Accordion title="Bot does not respond to non mention group messages">

    - If `requireMention=false`, Telegram privacy mode must allow full visibility.
      - BotFather: `/setprivacy` -> Disable
      - then remove + re-add bot to group
    - `openclaw channels status` warns when config expects unmentioned group messages.
    - `openclaw channels status --probe` can check explicit numeric group IDs; wildcard `"*"` cannot be membership-probed.
    - quick session test: `/activation always`.

  </Accordion>

  <Accordion title="Bot not seeing group messages at all">

    - when `channels.telegram.groups` exists, group must be listed (or include `"*"`)
    - verify bot membership in group
    - review logs: `openclaw logs --follow` for skip reasons

  </Accordion>

  <Accordion title="Commands work partially or not at all">

    - authorize your sender identity (pairing and/or numeric `allowFrom`)
    - command authorization still applies even when group policy is `open`
    - `setMyCommands failed` with `BOT_COMMANDS_TOO_MUCH` means the native menu has too many entries; reduce plugin/skill/custom commands or disable native menus
    - `setMyCommands failed` with network/fetch errors usually indicates DNS/HTTPS reachability issues to `api.telegram.org`

  </Accordion>

  <Accordion title="Polling or network instability">

    - Node 22+ + custom fetch/proxy can trigger immediate abort behavior if AbortSignal types mismatch.
    - Some hosts resolve `api.telegram.org` to IPv6 first; broken IPv6 egress can cause intermittent Telegram API failures.
    - If logs include `TypeError: fetch failed` or `Network request for 'getUpdates' failed!`, OpenClaw now retries these as recoverable network errors.
    - If logs include `Polling stall detected`, OpenClaw restarts polling and rebuilds the Telegram transport after 120 seconds without completed long-poll liveness by default.
    - Increase `channels.telegram.pollingStallThresholdMs` only when long-running `getUpdates` calls are healthy but your host still reports false polling-stall restarts. Persistent stalls usually point to proxy, DNS, IPv6, or TLS egress issues between the host and `api.telegram.org`.
    - On VPS hosts with unstable direct egress/TLS, route Telegram API calls through `channels.telegram.proxy`:

```yaml
channels:
  telegram:
    proxy: socks5://<user>:<password>@proxy-host:1080
```

    - Node 22+ defaults to `autoSelectFamily=true` (except WSL2) and `dnsResultOrder=ipv4first`.
    - If your host is WSL2 or explicitly works better with IPv4-only behavior, force family selection:

```yaml
channels:
  telegram:
    network:
      autoSelectFamily: false
```

    - RFC 2544 benchmark-range answers (`198.18.0.0/15`) are already allowed
      for Telegram media downloads by default. If a trusted fake-IP or
      transparent proxy rewrites `api.telegram.org` to some other
      private/internal/special-use address during media downloads, you can opt
      in to the Telegram-only bypass:

```yaml
channels:
  telegram:
    network:
      dangerouslyAllowPrivateNetwork: true
```

    - The same opt-in is available per account at
      `channels.telegram.accounts.<accountId>.network.dangerouslyAllowPrivateNetwork`.
    - If your proxy resolves Telegram media hosts into `198.18.x.x`, leave the
      dangerous flag off first. Telegram media already allows the RFC 2544
      benchmark range by default.

    <Warning>
      `channels.telegram.network.dangerouslyAllowPrivateNetwork` weakens Telegram
      media SSRF protections. Use it only for trusted operator-controlled proxy
      environments such as Clash, Mihomo, or Surge fake-IP routing when they
      synthesize private or special-use answers outside the RFC 2544 benchmark
      range. Leave it off for normal public internet Telegram access.
    </Warning>

    - Environment overrides (temporary):
      - `OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1`
      - `OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY=1`
      - `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first`
    - Validate DNS answers:

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

More help: [Channel troubleshooting](/channels/troubleshooting).

## Telegram config reference pointers

Primary reference:

- `channels.telegram.enabled`: enable/disable channel startup.
- `channels.telegram.botToken`: bot token (BotFather).
- `channels.telegram.tokenFile`: read token from a regular file path. Symlinks are rejected.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.telegram.allowFrom`: DM allowlist (numeric Telegram user IDs). `allowlist` requires at least one sender ID. `open` requires `"*"`. `openclaw doctor --fix` can resolve legacy `@username` entries to IDs and can recover allowlist entries from pairing-store files in allowlist migration flows.
- `channels.telegram.actions.poll`: enable or disable Telegram poll creation (default: enabled; still requires `sendMessage`).
- `channels.telegram.defaultTo`: default Telegram target used by CLI `--deliver` when no explicit `--reply-to` is provided.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (default: allowlist).
- `channels.telegram.groupAllowFrom`: group sender allowlist (numeric Telegram user IDs). `openclaw doctor --fix` can resolve legacy `@username` entries to IDs. Non-numeric entries are ignored at auth time. Group auth does not use DM pairing-store fallback (`2026.2.25+`).
- Multi-account precedence:
  - When two or more account IDs are configured, set `channels.telegram.defaultAccount` (or include `channels.telegram.accounts.default`) to make default routing explicit.
  - If neither is set, OpenClaw falls back to the first normalized account ID and `openclaw doctor` warns.
  - `channels.telegram.accounts.default.allowFrom` and `channels.telegram.accounts.default.groupAllowFrom` apply only to the `default` account.
  - Named accounts inherit `channels.telegram.allowFrom` and `channels.telegram.groupAllowFrom` when account-level values are unset.
  - Named accounts do not inherit `channels.telegram.accounts.default.allowFrom` / `groupAllowFrom`.
- `channels.telegram.groups`: per-group defaults + allowlist (use `"*"` for global defaults).
  - `channels.telegram.groups.<id>.groupPolicy`: per-group override for groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: mention gating default.
  - `channels.telegram.groups.<id>.skills`: skill filter (omit = all skills, empty = none).
  - `channels.telegram.groups.<id>.allowFrom`: per-group sender allowlist override.
  - `channels.telegram.groups.<id>.systemPrompt`: extra system prompt for the group.
  - `channels.telegram.groups.<id>.enabled`: disable the group when `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: per-topic overrides (group fields + topic-only `agentId`).
  - `channels.telegram.groups.<id>.topics.<threadId>.agentId`: route this topic to a specific agent (overrides group-level and binding routing).
- `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: per-topic override for groupPolicy (`open | allowlist | disabled`).
- `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: per-topic mention gating override.
- top-level `bindings[]` with `type: "acp"` and canonical topic id `chatId:topic:topicId` in `match.peer.id`: persistent ACP topic binding fields (see [ACP Agents](/tools/acp-agents#channel-specific-settings)).
- `channels.telegram.direct.<id>.topics.<threadId>.agentId`: route DM topics to a specific agent (same behavior as forum topics).
- `channels.telegram.execApprovals.enabled`: enable Telegram as a chat-based exec approval client for this account.
- `channels.telegram.execApprovals.approvers`: Telegram user IDs allowed to approve or deny exec requests. Optional when `channels.telegram.allowFrom` or a direct `channels.telegram.defaultTo` already identifies the owner.
- `channels.telegram.execApprovals.target`: `dm | channel | both` (default: `dm`). `channel` and `both` preserve the originating Telegram topic when present.
- `channels.telegram.execApprovals.agentFilter`: optional agent ID filter for forwarded approval prompts.
- `channels.telegram.execApprovals.sessionFilter`: optional session key filter (substring or regex) for forwarded approval prompts.
- `channels.telegram.accounts.<account>.execApprovals`: per-account override for Telegram exec approval routing and approver authorization.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (default: allowlist).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: per-account override.
- `channels.telegram.commands.nativeSkills`: enable/disable Telegram native skills commands.
- `channels.telegram.replyToMode`: `off | first | all` (default: `off`).
- `channels.telegram.textChunkLimit`: outbound chunk size (chars).
- `channels.telegram.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.
- `channels.telegram.linkPreview`: toggle link previews for outbound messages (default: true).
- `channels.telegram.streaming`: `off | partial | block | progress` (live stream preview; default: `partial`; `progress` maps to `partial`; `block` is legacy preview mode compatibility). Telegram preview streaming uses a single preview message that is edited in place.
- `channels.telegram.streaming.preview.toolProgress`: reuse the live preview message for tool/progress updates when preview streaming is active (default: `true`). Set `false` to keep separate tool/progress messages.
- `channels.telegram.mediaMaxMb`: inbound/outbound Telegram media cap (MB, default: 100).
- `channels.telegram.retry`: retry policy for Telegram send helpers (CLI/tools/actions) on recoverable outbound API errors (attempts, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: override Node autoSelectFamily (true=enable, false=disable). Defaults to enabled on Node 22+, with WSL2 defaulting to disabled.
- `channels.telegram.network.dnsResultOrder`: override DNS result order (`ipv4first` or `verbatim`). Defaults to `ipv4first` on Node 22+.
- `channels.telegram.network.dangerouslyAllowPrivateNetwork`: dangerous opt-in for trusted fake-IP or transparent-proxy environments where Telegram media downloads resolve `api.telegram.org` to private/internal/special-use addresses outside the default RFC 2544 benchmark-range allowance.
- `channels.telegram.proxy`: proxy URL for Bot API calls (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: enable webhook mode (requires `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret`: webhook secret (required when webhookUrl is set).
- `channels.telegram.webhookPath`: local webhook path (default `/telegram-webhook`).
- `channels.telegram.webhookHost`: local webhook bind host (default `127.0.0.1`).
- `channels.telegram.webhookPort`: local webhook bind port (default `8787`).
- `channels.telegram.actions.reactions`: gate Telegram tool reactions.
- `channels.telegram.actions.sendMessage`: gate Telegram tool message sends.
- `channels.telegram.actions.deleteMessage`: gate Telegram tool message deletes.
- `channels.telegram.actions.sticker`: gate Telegram sticker actions — send and search (default: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — control which reactions trigger system events (default: `own` when not set).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — control agent's reaction capability (default: `minimal` when not set).
- `channels.telegram.errorPolicy`: `reply | silent` — control error reply behavior (default: `reply`). Per-account/group/topic overrides supported.
- `channels.telegram.errorCooldownMs`: minimum ms between error replies to the same chat (default: `60000`). Prevents error spam during outages.

- [Configuration reference - Telegram](/gateway/configuration-reference#telegram)

Telegram-specific high-signal fields:

- startup/auth: `enabled`, `botToken`, `tokenFile`, `accounts.*` (`tokenFile` must point to a regular file; symlinks are rejected)
- access control: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `groups.*.topics.*`, top-level `bindings[]` (`type: "acp"`)
- exec approvals: `execApprovals`, `accounts.*.execApprovals`
- command/menu: `commands.native`, `commands.nativeSkills`, `customCommands`
- threading/replies: `replyToMode`
- streaming: `streaming` (preview), `streaming.preview.toolProgress`, `blockStreaming`
- formatting/delivery: `textChunkLimit`, `chunkMode`, `linkPreview`, `responsePrefix`
- media/network: `mediaMaxMb`, `timeoutSeconds`, `pollingStallThresholdMs`, `retry`, `network.autoSelectFamily`, `network.dangerouslyAllowPrivateNetwork`, `proxy`
- webhook: `webhookUrl`, `webhookSecret`, `webhookPath`, `webhookHost`
- actions/capabilities: `capabilities.inlineButtons`, `actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- reactions: `reactionNotifications`, `reactionLevel`
- errors: `errorPolicy`, `errorCooldownMs`
- writes/history: `configWrites`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Security](/gateway/security)
- [Channel routing](/channels/channel-routing)
- [Multi-agent routing](/concepts/multi-agent)
- [Troubleshooting](/channels/troubleshooting)
