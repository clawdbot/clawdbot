---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
title: "Telegram"
---

Production-ready for bot DMs and groups via grammY. Long polling is the default transport; webhook mode is optional.

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
    Both flows end with a token you paste into OpenClaw — pick one:

    - **Chat flow**: open Telegram, chat with **@BotFather** (confirm the handle is exactly `@BotFather`), run `/newbot`, follow the prompts, and save the token.
    - **Web flow**: open [BotFather's web app](https://t.me/BotFather?startapp) — it runs in every Telegram client, including [web.telegram.org](https://web.telegram.org) — create the bot in the UI, and copy its token.

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

    Env fallback: `TELEGRAM_BOT_TOKEN` (default account only; named accounts must use `botToken` or `tokenFile`).
    Telegram does **not** use `openclaw channels login telegram`; set the token in config/env, then start the gateway.

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
    Add the bot to your group, then get the two IDs group access needs:

    - your Telegram user ID, for `allowFrom` / `groupAllowFrom`
    - the Telegram group chat ID, as the key under `channels.telegram.groups`

    Get the group chat ID from `openclaw logs --follow`, a forwarded-ID bot, or Bot API `getUpdates`. After the group is allowed, `/whoami@<bot_username>` confirms the user and group IDs.

    Negative supergroup IDs starting with `-100` are group chat IDs. They go under `channels.telegram.groups`, not `groupAllowFrom`.

  </Step>
</Steps>

<Note>
Token resolution is account-aware: `tokenFile` beats `botToken` beats env, and config always wins over `TELEGRAM_BOT_TOKEN` (which only resolves for the default account). After a successful startup, OpenClaw caches the bot identity for up to 24 hours so restarts skip an extra `getMe` call; changing or removing the token clears that cache.
</Note>

## Telegram side settings

<AccordionGroup>
  <Accordion title="Privacy mode and group visibility">
    Telegram bots default to **Privacy Mode**, which limits which group messages they receive.

    To see all group messages, either:

    - disable privacy mode via `/setprivacy`, or
    - make the bot a group admin.

    After toggling privacy mode, remove and re-add the bot in each group so Telegram applies the change.

  </Accordion>

  <Accordion title="Group permissions">
    Admin status is controlled in Telegram group settings. Admin bots receive all group messages, useful for always-on group behavior.
  </Accordion>

  <Accordion title="Helpful BotFather toggles">

    - `/setjoingroups` — allow/deny group adds
    - `/setprivacy` — group visibility behavior

    The same settings are available in [BotFather's web app](https://t.me/BotFather?startapp) if you prefer a UI over chat commands.

  </Accordion>
</AccordionGroup>

## Dashboard Mini App

Run `/dashboard` in a DM with the bot to open the OpenClaw dashboard inside Telegram.

Requirements:

- `gateway.tailscale.mode: "serve"` or `"funnel"` for the published HTTPS Mini App URL.
- Your numeric Telegram user ID must be in the selected account's effective `allowFrom` or in `commands.ownerAllowFrom`.
- Use a DM. In groups, `/dashboard` replies with `open this in a DM with the bot` and sends no button.
- Docker installs: Serve/Funnel modes require the gateway to bind loopback next to `tailscaled`, which bridge networking with published ports cannot satisfy. Run the gateway container with `network_mode: host` and mount the host `tailscaled` socket (`/var/run/tailscale`) plus the `tailscale` CLI into the container.

The Mini App is a Tailscale-only v1 path and does not support Telegram Web iframe.

## Access control and activation

### Group bot identity

In groups and forum topics, an explicit mention of the configured bot handle (for example `@my_bot`) addresses the selected OpenClaw agent, even when the agent persona name differs from the Telegram username. Group silence policy still applies to unrelated traffic, but the bot handle itself is never "someone else."

<Tabs>
  <Tab title="DM policy">
    `channels.telegram.dmPolicy` controls direct message access:

    - `pairing` (default)
    - `allowlist` (requires at least one sender ID in `allowFrom`)
    - `open` (requires `allowFrom` to include `"*"`)
    - `disabled`

    `dmPolicy: "open"` with `allowFrom: ["*"]` lets any Telegram account that finds or guesses the bot username command the bot. Use it only for intentionally public bots with tightly restricted tools; one-owner bots should use `allowlist` with numeric user IDs.

    `channels.telegram.allowFrom` accepts numeric Telegram user IDs. `telegram:` / `tg:` prefixes are accepted and normalized.
    In multi-account configs, a restrictive top-level `channels.telegram.allowFrom` is a safety boundary: an account-level `allowFrom: ["*"]` does not make that account public unless the merged effective allowlist still contains an explicit wildcard.
    `dmPolicy: "allowlist"` with empty `allowFrom` blocks all DMs and is rejected by config validation.
    Setup asks for numeric user IDs only. If your config has `@username` allowlist entries from an older setup, run `openclaw doctor --fix` to resolve them to numeric IDs (best-effort; requires a Telegram bot token).
    If you previously relied on pairing-store allowlist files, `openclaw doctor --fix` can recover entries into `channels.telegram.allowFrom` for allowlist flows (for example when `dmPolicy: "allowlist"` has no explicit IDs yet).

    For one-owner bots, prefer `dmPolicy: "allowlist"` with explicit numeric `allowFrom` IDs over depending on previous pairing approvals.

    Common confusion: DM pairing approval does not mean "this sender is authorized everywhere." Pairing grants DM access only. If no command owner exists yet, the first approved pairing also sets `commands.ownerAllowFrom`, giving owner-only commands and exec approvals an explicit operator account. Group sender authorization still comes from explicit config allowlists.
    To be authorized for both DMs and group commands with one identity: put your numeric Telegram user ID in `channels.telegram.allowFrom`, and for owner-only commands make sure `commands.ownerAllowFrom` contains `telegram:<your user id>`.

    ### Finding your Telegram user ID

    Safer (no third-party bot): DM your bot, run `openclaw logs --follow`, read `from.id`.

    Official Bot API method:

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    Third-party (less private): `@userinfobot` or `@getidsbot`.

  </Tab>

  <Tab title="Group policy and allowlists">
    Two controls apply together:

    1. **Which groups are allowed** (`channels.telegram.groups`)
       - no `groups` config, `groupPolicy: "open"`: any group passes group-ID checks
       - no `groups` config, `groupPolicy: "allowlist"` (default): all groups blocked until you add `groups` entries (or `"*"`)
       - `groups` configured: acts as an allowlist (explicit IDs or `"*"`)

    2. **Which senders are allowed in groups** (`channels.telegram.groupPolicy`)
       - `open` / `allowlist` (default) / `disabled`

    `groupAllowFrom` filters group senders; if unset, Telegram falls back to `allowFrom` (not the pairing store — group sender auth never inherits DM pairing-store approvals, a security boundary since `2026.2.25`).
    `groupAllowFrom` entries should be numeric Telegram user IDs (`telegram:` / `tg:` prefixes are normalized); non-numeric entries are ignored. Do not put group or supergroup chat IDs here — negative chat IDs belong under `channels.telegram.groups`.
    Practical pattern for one-owner bots: set your user ID in `channels.telegram.allowFrom`, leave `groupAllowFrom` unset, and allow the target groups under `channels.telegram.groups`.
    If `channels.telegram` is entirely missing from config, runtime defaults to fail-closed `groupPolicy="allowlist"` unless `channels.defaults.groupPolicy` is explicitly set.

    Owner-only group setup:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      dmPolicy: "pairing",
      allowFrom: ["<YOUR_TELEGRAM_USER_ID>"],
      groupPolicy: "allowlist",
      groups: {
        "<GROUP_CHAT_ID>": {
          requireMention: true,
        },
      },
    },
  },
}
```

    Test from the group with `@<bot_username> ping`. Plain group messages do not trigger the bot while `requireMention: true`.

    Allow any member in one specific group:

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

    Allow only specific users inside one specific group:

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
      Common mistake: `groupAllowFrom` is not a group allowlist.

      - Negative Telegram group/supergroup chat IDs (`-1001234567890`) go under `channels.telegram.groups`.
      - Telegram user IDs (`8734062810`) go under `groupAllowFrom` to limit which people inside an allowed group can trigger the bot.
      - Use `groupAllowFrom: ["*"]` only to let any member of an allowed group talk to the bot.

    </Warning>

  </Tab>

  <Tab title="Mention behavior">
    Group replies require mention by default. A mention can come from:

    - a native `@botusername` mention, or
    - a mention pattern in `agents.list[].groupChat.mentionPatterns` or `messages.groupChat.mentionPatterns`

    Session-level toggles (state only, not persisted): `/activation always`, `/activation mention`. Use config for persistence:

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

    Group history context is always on and bounded by `historyLimit`. Set `channels.telegram.historyLimit: 0` to disable the group history window. `openclaw doctor --fix` removes the retired `includeGroupHistoryContext` key.

    Getting the group chat ID: forward a group message to `@userinfobot` / `@getidsbot`, read `chat.id` from `openclaw logs --follow`, inspect Bot API `getUpdates`, or (once the group is allowed) run `/whoami@<bot_username>`.

  </Tab>
</Tabs>

## Runtime behavior

- Telegram runs inside the gateway process.
- Routing is deterministic: Telegram inbound replies back to Telegram (the model does not pick channels).
- Inbound messages normalize into the shared channel envelope with reply metadata, media placeholders, and persisted reply-chain context for replies the gateway has observed.
- Group sessions are isolated by group ID. Forum topics append `:topic:<threadId>`.
- DM messages can carry `message_thread_id`; OpenClaw preserves it for replies. DM topic sessions split only when Telegram `getMe` reports `has_topics_enabled: true` for the bot; otherwise DMs stay on the flat session.
- Long polling uses the grammY runner with per-chat/per-thread sequencing. Runner sink concurrency uses `agents.defaults.maxConcurrent`.
- Multi-account startup bounds concurrent `getMe` probes so large bot fleets do not fan out every account probe at once.
- Each gateway process guards long polling so only one active poller can use a bot token at a time. Persistent `getUpdates` 409 conflicts point to another OpenClaw gateway, script, or external poller using the same token.
- The polling watchdog restarts after 120 seconds without completed `getUpdates` liveness by default. Raise `channels.telegram.pollingStallThresholdMs` (30000-600000, per-account overrides supported) only if your deployment sees false polling-stall restarts during long-running work.
- Telegram Bot API has no read-receipt support (`sendReadReceipts` does not apply).

<Note>
  `channels.telegram.dm.threadReplies` and `channels.telegram.direct.<chatId>.threadReplies` were removed. Run `openclaw doctor --fix` after upgrading if your config still has those keys. DM topic routing now follows Telegram `getMe.has_topics_enabled` (controlled by BotFather threaded mode): topics-enabled bots use thread-scoped DM sessions when Telegram sends `message_thread_id`; other DMs stay on the flat session.
</Note>

## Feature reference

<AccordionGroup>
  <Accordion title="Live stream preview (message edits)">
    OpenClaw streams partial replies in real time in direct chats, groups, and topics: send a preview message, then `editMessageText` repeatedly, finalizing in place.

    - `channels.telegram.streaming` is `off | partial | block | progress` (default: `partial`)
    - short initial answer previews are debounced, then materialized after a bounded delay if the run is still active
    - `progress` keeps one editable status draft for tool progress, shows the stable status label when answer activity arrives before tool progress, clears it at completion, and sends the final answer as a normal message
    - `streaming.preview.toolProgress` controls whether tool/progress updates reuse the same edited preview message (default: `true` when preview streaming is active)
    - `streaming.preview.commandText` controls command/exec detail inside those lines: `raw` (default) or `status` (tool label only)
    - `streaming.progress.commentary` (default: `false`) opts into assistant commentary/preamble text in the temporary progress draft
    - legacy `channels.telegram.streamMode`, boolean `streaming` values, and retired native draft preview keys are detected; run `openclaw doctor --fix` to migrate them

    Tool-progress lines are the short status updates shown while tools run (command execution, file reads, planning updates, patch summaries, Codex preamble/commentary in app-server mode). Telegram keeps these on by default (matches released behavior from `v2026.4.22`+).

    Keep answer-preview edits but hide tool-progress lines:

    ```json
    {
      "channels": {
        "telegram": {
          "streaming": {
            "mode": "partial",
            "preview": { "toolProgress": false }
          }
        }
      }
    }
    ```

    Keep tool-progress visible but hide command/exec text:

    ```json
    {
      "channels": {
        "telegram": {
          "streaming": {
            "mode": "partial",
            "preview": { "commandText": "status" }
          }
        }
      }
    }
    ```

    `progress` mode shows tool progress without editing the final answer into that message. Put the command-text policy under `streaming.progress`:

    ```json
    {
      "channels": {
        "telegram": {
          "streaming": {
            "mode": "progress",
            "progress": {
              "toolProgress": true,
              "commandText": "status"
            }
          }
        }
      }
    }
    ```

    `streaming.mode: "off"` disables preview edits and suppresses generic tool/progress chatter instead of sending it as standalone status messages; approval prompts, media, and errors still route through normal final delivery. `streaming.preview.toolProgress: false` keeps only answer-preview edits.

    <Note>
      Selected quote replies are the exception. When `replyToMode` is `first`, `all`, or `batched` and the inbound message has selected quote text, OpenClaw sends the final answer through Telegram's native quote-reply path instead of editing the answer preview, so `streaming.preview.toolProgress` cannot show status lines that turn. Current-message replies without selected quote text still stream. Set `replyToMode: "off"` when tool-progress visibility matters more than native quote replies, or `streaming.preview.toolProgress: false` to accept that trade-off.
    </Note>

    For text-only replies: short previews get the final edit in place; long finals that split into multiple messages reuse the preview as the first chunk, then send only the remainder; progress-mode finals clear the status draft and use normal final delivery; if the final edit fails before completion is confirmed, OpenClaw falls back to normal final delivery and cleans up the stale preview. For complex replies (media payloads), OpenClaw always falls back to normal final delivery and cleans up the preview.

    Preview streaming and block streaming are mutually exclusive — when block streaming is explicitly enabled, OpenClaw skips the preview stream to avoid double-streaming.

    Reasoning: `/reasoning stream` streams reasoning into the live preview while generating, then deletes the reasoning preview after final delivery (use `/reasoning on` to keep it visible). The final answer is sent without reasoning text.

  </Accordion>

  <Accordion title="Rich message formatting">
    Outbound text uses standard Telegram HTML messages by default, readable across current clients: bold, italic, links, code, spoilers, quotes — not Bot API 10.2 rich-only blocks (native tables, details, rich media, formulas).

    Opt into Bot API 10.2 rich messages:

```json5
{
  channels: {
    telegram: {
      richMessages: true,
    },
  },
}
```

    When enabled: the agent is told rich messages are available for this bot/account (with the supported Markdown + HTML-island authoring contract); Markdown text renders through OpenClaw's Markdown IR as typed Bot API 10.2 rich blocks (headings, tables, details, checklists, rich media, formulas, maps, collages); media captions still use Telegram HTML captions (rich messages do not replace captions, and captions cap at 1024 characters).

    This keeps model text away from Telegram's rich-Markdown sigils, so currency like `$400-600K` is not parsed as math. Long rich text splits automatically across Telegram's limits. Tables over the 20-column limit fall back to a code block.

    Default: off, for client compatibility — some current Desktop, Web, Android, and third-party clients render accepted rich messages as unsupported. Keep this off unless every client used with the bot can render them. `/status` shows whether the current session has rich messages on or off.

    Link previews are on by default. `channels.telegram.linkPreview: false` disables automatic entity detection for rich text.

  </Accordion>

  <Accordion title="Native commands and custom commands">
    Telegram's command menu is registered at startup with `setMyCommands`. `commands.native: "auto"` enables native commands for Telegram.

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

    Rules: names are normalized (strip leading `/`, lowercase); valid pattern `a-z`, `0-9`, `_`, length 1-32; custom commands cannot override native commands; conflicts/duplicates are skipped and logged.

    Custom commands are menu entries only — they do not auto-implement behavior. Plugin/skill commands can still work when typed even if not shown in the Telegram menu. If native commands are disabled, built-ins are removed; custom/plugin commands may still register if configured.

    Common setup failures:

    - `setMyCommands failed` with `BOT_COMMANDS_TOO_MUCH` after a trim retry means the menu still overflows; reduce plugin/skill/custom commands or disable `channels.telegram.commands.native`.
    - `deleteWebhook`, `deleteMyCommands`, or `setMyCommands` failing with `404: Not Found` while direct Bot API curl commands work usually means `channels.telegram.apiRoot` was set to the full `/bot<TOKEN>` endpoint. `apiRoot` must be the Bot API root only; `openclaw doctor --fix` removes an accidental trailing `/bot<TOKEN>`.
    - `getMe returned 401` means Telegram rejected the configured bot token. Update `botToken`, `tokenFile`, or `TELEGRAM_BOT_TOKEN` (default account) with the current BotFather token; OpenClaw stops before polling so this is not reported as a webhook cleanup failure.
    - `setMyCommands failed` with network/fetch errors usually means outbound DNS/HTTPS to `api.telegram.org` is blocked.

    ### Device pairing commands (`device-pair` plugin)

    When installed:

    1. `/pair` generates a setup code
    2. paste the code in the iOS app
    3. `/pair pending` lists pending requests (including role/scopes)
    4. approve: `/pair approve <requestId>`, `/pair approve` (only pending request), or `/pair approve latest`

    If a device retries with changed auth details (role, scopes, public key), the previous pending request is superseded with a new `requestId`; re-run `/pair pending` before approving.

    More detail: [Pairing](/channels/pairing#pair-via-telegram).

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

    Scopes: `off`, `dm`, `group`, `all`, `allowlist` (default). Legacy `capabilities: ["inlineButtons"]` maps to `"all"`.

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

    Mini App button example:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Open app:",
  presentation: {
    blocks: [
      {
        type: "buttons",
        buttons: [{ label: "Launch", web_app: { url: "https://example.com/app" } }],
      },
    ],
  },
}
```

    `web_app` buttons only work in private chats between a user and the bot.

    Callback clicks not claimed by a registered plugin interactive handler are passed to the agent as text: `callback_data: <value>`.

  </Accordion>

  <Accordion title="Telegram message actions for agents and automation">
    Actions:

    - `sendMessage` (`to`, `content`, optional `mediaUrl`, `replyToMessageId`, `messageThreadId`)
    - `react` (`chatId`, `messageId`, `emoji`)
    - `deleteMessage` (`chatId`, `messageId`)
    - `editMessage` (`chatId`, `messageId`, `content` or `caption`, optional `presentation` inline buttons; button-only edits update reply markup)
    - `createForumTopic` (`chatId`, `name`, optional `iconColor`, `iconCustomEmojiId`)

    Ergonomic aliases: `send`, `react`, `delete`, `edit`, `sticker`, `sticker-search`, `topic-create`.

    Gating: `channels.telegram.actions.sendMessage`, `deleteMessage`, `reactions`, `sticker` (default: disabled). `edit`, `createForumTopic`, and `editForumTopic` are enabled by default with no dedicated toggle.
    Runtime sends use the active config/secrets snapshot from startup/reload, so action paths do not re-resolve `SecretRef` values per send.

    Reaction removal semantics: [/tools/reactions](/tools/reactions).

  </Accordion>

  <Accordion title="Reply threading tags">
    Explicit reply threading tags in generated output:

    - `[[reply_to_current]]` — replies to the triggering message
    - `[[reply_to:<id>]]` — replies to a specific message ID

    `channels.telegram.replyToMode`: `off` (default), `first`, `all`.

    When reply threading is enabled and the original text/caption is available, OpenClaw adds a native quote excerpt automatically. Telegram caps native quote text at 1024 UTF-16 code units; longer messages are quoted from the start and fall back to a plain reply if Telegram rejects the quote.

    `off` disables implicit reply threading only; explicit `[[reply_to_*]]` tags are still honored.

  </Accordion>

  <Accordion title="Forum topics and thread behavior">
    Forum supergroups: topic session keys append `:topic:<threadId>`; replies and typing target the topic thread; topic config path is `channels.telegram.groups.<chatId>.topics.<threadId>`.

    General topic (`threadId=1`) is a special case: message sends omit `message_thread_id` (Telegram rejects `sendMessage(...thread_id=1)` with "thread not found"), but typing actions still include `message_thread_id` (empirically required for the typing indicator to appear).

    Topic entries inherit group settings unless overridden (`requireMention`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`). `agentId` is topic-only and does not inherit from group defaults. `topics."*"` sets defaults for every topic in that group; exact topic IDs still win over `"*"`.

    **Per-topic agent routing**: each topic can route to a different agent via `agentId` in the topic config, giving it its own workspace, memory, and session:

    ```json5
    {
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "1": { agentId: "main" },      // General topic -> main agent
                "3": { agentId: "zu" },        // Dev topic -> zu agent
                "5": { agentId: "coder" }      // Code review -> coder agent
              }
            }
          }
        }
      }
    }
    ```

    Each topic then has its own session key, for example `agent:zu:telegram:group:-1001234567890:topic:3`.

    **Persistent ACP topic binding**: forum topics can pin ACP harness sessions through top-level typed bindings (`bindings[]` with `type: "acp"`, `match.channel: "telegram"`, `peer.kind: "group"`, and a topic-qualified id like `-1001234567890:topic:42`). Currently scoped to forum topics in groups/supergroups. See [ACP Agents](/tools/acp-agents).

    **Thread-bound ACP spawn from chat**: `/acp spawn <agent> --thread here|auto` binds the current topic to a new ACP session; follow-ups route there directly, and OpenClaw pins the spawn confirmation in-topic. Requires `channels.telegram.threadBindings.spawnSessions` (default: `true`).

    Template context exposes `MessageThreadId` and `IsForum`. DM chats with `message_thread_id` keep reply metadata but only use thread-aware session keys when Telegram `getMe` reports `has_topics_enabled: true`.
    The retired `dm.threadReplies` and `direct.*.threadReplies` overrides are gone; BotFather threaded mode is the single source of truth. Run `openclaw doctor --fix` to remove stale config keys.

  </Accordion>

  <Accordion title="Audio, video, and stickers">
    ### Audio messages

    Telegram distinguishes voice notes from audio files. Default: audio-file behavior; tag `[[audio_as_voice]]` in the agent reply to force a voice-note send. Inbound voice-note transcripts are framed as machine-generated, untrusted text in agent context, but mention detection still uses the raw transcript so mention-gated voice messages keep working.

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

    Telegram distinguishes video files from video notes. Video notes do not support captions; provided message text sends separately.

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

    ### Locations and venues

    Use the existing `send` action with one standalone `location` object. Coordinates send a native pin; adding both `name` and `address` sends a native venue card. Location sends cannot be combined with message text or media.

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  location: {
    latitude: 48.858844,
    longitude: 2.294351,
    accuracy: 12,
    name: "Eiffel Tower",
    address: "Champ de Mars, Paris",
  },
}
```

    ### Stickers

    Inbound: static WEBP is downloaded and processed (placeholder `<media:sticker>`); animated TGS and video WEBM are skipped.

    Sticker context fields: `Sticker.emoji`, `Sticker.setName`, `Sticker.fileId`, `Sticker.fileUniqueId`, `Sticker.cachedDescription`. Descriptions are cached in OpenClaw SQLite plugin state to reduce repeated vision calls.

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

    Send:

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
    Telegram reactions arrive as `message_reaction` updates, separate from message payloads. When enabled, OpenClaw enqueues system events like `Telegram reaction added: 👍 by Alice (@alice) on msg 42`.

    - `channels.telegram.reactionNotifications`: `off | own | all` (default: `own`)
    - `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` (default: `minimal`)

    `own` means user reactions to bot-sent messages only (best-effort via a sent-message cache). Reaction events still respect Telegram access controls (`dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`); unauthorized senders are dropped.

    Telegram does not provide thread IDs in reaction updates: non-forum groups route to the group chat session; forum groups route to the general-topic session (`:topic:1`), not the exact originating topic.

    `allowed_updates` for polling/webhook include `message_reaction` automatically.

  </Accordion>

  <Accordion title="Ack reactions">
    `ackReaction` sends an acknowledgement emoji while OpenClaw processes an inbound message. `messages.ackReactionScope` decides *when* it is sent.

    **Emoji resolution order:**

    - `channels.telegram.accounts.<accountId>.ackReaction`
    - `channels.telegram.ackReaction`
    - `messages.ackReaction`
    - agent identity emoji fallback (`agents.list[].identity.emoji`, else "👀")

    Telegram expects a unicode emoji (for example "👀"); use `""` to disable the reaction for a channel or account.

    **Scope (`messages.ackReactionScope`, default `"group-mentions"`; no Telegram-account or Telegram-channel override today):**

    `all` (DMs + groups, including ambient room events), `direct` (DMs only), `group-all` (every group message except ambient room events, no DMs), `group-mentions` (groups when the bot is mentioned; **no DMs** — default), `off` / `none` (disabled).

    <Note>
    The default scope (`group-mentions`) does not fire ack reactions in DMs or ambient room events. Use `direct` or `all` for DMs; only `all` acknowledges ambient room events. This value is read at Telegram provider startup, so a gateway restart is needed for the change to take effect.
    </Note>

  </Accordion>

  <Accordion title="Config writes from Telegram events and commands">
    Channel config writes are enabled by default (`configWrites !== false`). Telegram-triggered writes include group migration events (`migrate_to_chat_id`, updates `channels.telegram.groups`) and `/config set` / `/config unset` (requires command enablement).

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
    Default is long polling. For webhook mode, set `channels.telegram.webhookUrl` and `channels.telegram.webhookSecret`; optional `webhookPath` (default `/telegram-webhook`), `webhookHost` (default `127.0.0.1`), `webhookPort` (default `8787`), `webhookCertPath` (self-signed cert PEM for direct-IP or no-domain setups).

    In long-polling mode, OpenClaw persists its restart watermark only after an update dispatches successfully; a failed handler leaves that update retryable in the same process instead of marking it completed.

    The local listener binds to `127.0.0.1:8787` by default. For public ingress, put a reverse proxy in front of the local port, or set `webhookHost: "0.0.0.0"` intentionally.

    Webhook mode validates request guards, the Telegram secret token, and the JSON body, then commits the update to its durable ingress queue before returning an empty `200`. Successful durable adoption includes `x-openclaw-delivery-accepted: durable`; health, routing, authentication, validation, and storage-error responses omit this header. Reverse proxies and host controllers can require the header to distinguish OpenClaw adoption from a generic empty `200` without inferring acceptance from response timing.

    After the durable write, OpenClaw claims and processes updates through the core channel-ingress drain (per-chat/per-topic lanes, complete at turn adoption, pre-adoption stall timeout). Slow agent turns do not hold Telegram's delivery ACK.

  </Accordion>

  <Accordion title="Limits, retry, and CLI targets">
    - `channels.telegram.textChunkLimit` default 4000; `streaming.chunkMode="newline"` prefers paragraph boundaries (blank lines) before length splitting.
    - `channels.telegram.mediaMaxMb` (default 100) caps inbound and outbound media size.
    - `channels.telegram.mediaGroupFlushMs` (default 500, range 10-60000) controls how long albums/media groups are buffered before OpenClaw dispatches them as one inbound message. Increase it if album parts arrive late; decrease it to reduce album reply latency.
    - `channels.telegram.timeoutSeconds` overrides the API client timeout (grammY default applies if unset). Bot clients clamp configured values below the 60-second outbound text/typing request guard so grammY does not abort visible reply delivery before OpenClaw's transport guard and fallback can run. Long polling still uses a 45-second `getUpdates` request guard so idle polls are not abandoned indefinitely.
    - `channels.telegram.pollingStallThresholdMs` defaults to 120000; tune between 30000 and 600000 only for false-positive polling-stall restarts.
    - group context history uses `channels.telegram.historyLimit` or `messages.groupChat.historyLimit` (default 50); `0` disables.
    - reply/quote/forward supplemental context normalizes into one selected conversation context window when the gateway has observed the parent messages; the observed-message cache lives in OpenClaw SQLite plugin state, and `openclaw doctor --fix` imports legacy sidecars. Telegram only includes one shallow `reply_to_message` per update, so chains older than the cache are limited to that payload.
    - Telegram allowlists primarily gate who can trigger the agent, not a full supplemental-context redaction boundary.
    - DM history: `channels.telegram.dmHistoryLimit`, `channels.telegram.dms["<user_id>"].historyLimit`.
    - `channels.telegram.retry` applies to Telegram send helpers (CLI/tools/actions) for recoverable outbound API errors. Inbound final-reply delivery uses a bounded safe-send retry for pre-connect failures, but does not retry ambiguous post-send network envelopes that could duplicate visible messages.

    CLI and message-tool send targets accept a numeric chat ID, username, or forum topic target:

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
openclaw message send --channel telegram --target -1001234567890:topic:42 --message "hi topic"
```

    Polls use `openclaw message poll` and support forum topics:

```bash
openclaw message poll --channel telegram --target 123456789 \
  --poll-question "Ship it?" --poll-option "Yes" --poll-option "No"
openclaw message poll --channel telegram --target -1001234567890:topic:42 \
  --poll-question "Pick a time" --poll-option "10am" --poll-option "2pm" \
  --poll-duration-seconds 300 --poll-public
```

    Telegram-only poll flags: `--poll-duration-seconds` (5-600), `--poll-anonymous`, `--poll-public`, `--thread-id` (or a `:topic:` target). `--poll-option` repeats 2-12 times (Telegram's option cap).

    Telegram send also supports `--presentation` with `buttons` blocks for inline keyboards (when `channels.telegram.capabilities.inlineButtons` allows it), `--pin` or `--delivery '{"pin":true}'` to request pinned delivery when the bot can pin in that chat, and `--force-document` to send outbound images, GIFs, and videos as documents instead of compressed/animated/video uploads.

    Action gating: `channels.telegram.actions.sendMessage=false` disables all outbound messages including polls; `channels.telegram.actions.poll=false` disables poll creation while leaving regular sends enabled.

  </Accordion>

  <Accordion title="Exec approvals in Telegram">
    Telegram supports exec approvals in approver DMs and can optionally post prompts in the originating chat or topic. Approvers must be numeric Telegram user IDs.

    - `channels.telegram.execApprovals.enabled` (`"auto"` enables when at least one approver is resolvable)
    - `channels.telegram.execApprovals.approvers` (falls back to numeric owner IDs from `commands.ownerAllowFrom`)
    - `channels.telegram.execApprovals.target`: `dm` (default) | `channel` | `both`
    - `agentFilter`, `sessionFilter`

    `channels.telegram.allowFrom`, `groupAllowFrom`, and `defaultTo` control who can talk to the bot and where it sends normal replies — they do not make someone an exec approver. The first approved DM pairing bootstraps `commands.ownerAllowFrom` when no command owner exists yet, so one-owner setups work without duplicating IDs under `execApprovals.approvers`.

    Channel delivery shows the command text in the chat; only enable `channel` or `both` in trusted groups/topics. When the prompt lands in a forum topic, OpenClaw preserves the topic for the approval prompt and follow-up. Exec approvals expire after 30 minutes by default.

    Inline approval buttons also require `channels.telegram.capabilities.inlineButtons` to allow the target surface (`dm`, `group`, or `all`). Approval IDs prefixed with `plugin:` resolve through plugin approvals; others resolve through exec approvals first.

    See [Exec approvals](/tools/exec-approvals).

  </Accordion>
</AccordionGroup>

## Error reply controls

When the agent hits a delivery or provider error, the error policy controls whether error messages reach the Telegram chat:

| Key                                 | Values                     | Default         | Description                                                                                                                                                                                              |
| ----------------------------------- | -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels.telegram.errorPolicy`     | `always`, `once`, `silent` | `always`        | `always` sends every error message to the chat. `once` sends each unique error message once per cooldown window (suppresses repeated identical errors). `silent` never sends error messages to the chat. |
| `channels.telegram.errorCooldownMs` | number (ms)                | `14400000` (4h) | Cooldown window for the `once` policy. After an error is sent, the same message is suppressed until this interval elapses. Prevents error spam during outages.                                           |

Per-account, per-group, and per-topic overrides are supported (same inheritance as other Telegram config keys).

```json5
{
  channels: {
    telegram: {
      errorPolicy: "always",
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

    - If `requireMention=false`, Telegram privacy mode must allow full visibility: BotFather `/setprivacy` -> Disable, then remove + re-add the bot to the group.
    - `openclaw channels status` warns when config expects unmentioned group messages.
    - `openclaw channels status --probe` checks explicit numeric group IDs; wildcard `"*"` cannot be membership-probed.
    - Quick session test: `/activation always`.

  </Accordion>

  <Accordion title="Bot not seeing group messages at all">

    - When `channels.telegram.groups` exists, the group must be listed (or include `"*"`).
    - Verify bot membership in the group.
    - Review `openclaw logs --follow` for skip reasons.

  </Accordion>

  <Accordion title="Commands work partially or not at all">

    - Authorize your sender identity (pairing and/or numeric `allowFrom`); command authorization still applies even when group policy is `open`.
    - `setMyCommands failed` with `BOT_COMMANDS_TOO_MUCH` means the native menu has too many entries; reduce plugin/skill/custom commands or disable native menus.
    - `deleteMyCommands` / `setMyCommands` startup calls and `sendChatAction` typing calls are bounded and retry once through Telegram's transport fallback on request timeout. Persistent network/fetch errors usually mean DNS/HTTPS to `api.telegram.org` is unreachable.

  </Accordion>

  <Accordion title="Startup reports unauthorized token">

    - `getMe returned 401` is a Telegram auth failure for the configured bot token. Re-copy or regenerate the token in BotFather, then update `channels.telegram.botToken`, `tokenFile`, `accounts.<id>.botToken`, or `TELEGRAM_BOT_TOKEN` (default account).
    - `deleteWebhook 401 Unauthorized` during startup is also an auth failure; treating it as "no webhook exists" would only defer the same bad-token failure to a later API call.

  </Accordion>

  <Accordion title="Polling or network instability">

    - Node 22+ with a custom fetch/proxy can trigger immediate abort behavior if `AbortSignal` types mismatch.
    - Some hosts resolve `api.telegram.org` to IPv6 first; broken IPv6 egress causes intermittent API failures.
    - Logs with `TypeError: fetch failed` or `Network request for 'getUpdates' failed!` are retried as recoverable network errors.
    - During polling startup, OpenClaw reuses the successful startup `getMe` probe for grammY so the runner does not need a second `getMe` before the first `getUpdates`.
    - If `deleteWebhook` fails with a transient network error during polling startup, OpenClaw continues into long polling instead of making another pre-poll control-plane call. A still-active webhook then surfaces as a `getUpdates` conflict; OpenClaw rebuilds the transport and retries webhook cleanup.
    - If Telegram sockets recycle on a short fixed cadence, check for a low `channels.telegram.timeoutSeconds` — bot clients clamp configured values below the outbound and `getUpdates` request guards, but older releases could abort every poll or reply when this was set below those guards.
    - `Polling stall detected` in logs means OpenClaw restarts polling and rebuilds the transport after 120 seconds without completed long-poll liveness by default.
    - `openclaw channels status --probe` and `openclaw doctor` warn when a running polling account has not completed `getUpdates` after startup grace, a running webhook account has not completed `setWebhook` after startup grace, or the last successful polling transport activity is stale.
    - Raise `channels.telegram.pollingStallThresholdMs` only when long-running `getUpdates` calls are healthy but your host still reports false polling-stall restarts. Persistent stalls usually point to proxy, DNS, IPv6, or TLS egress issues to `api.telegram.org`.
    - Telegram honors process proxy env for Bot API transport: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and lowercase variants. `NO_PROXY` / `no_proxy` can still bypass `api.telegram.org`.
    - If `OPENCLAW_PROXY_URL` is set for a service environment and no standard proxy env is present, Telegram uses that URL for Bot API transport too.
    - On VPS hosts with unstable direct egress/TLS, route Telegram API calls through a proxy:

```yaml
channels:
  telegram:
    proxy: socks5://<user>:<password>@proxy-host:1080
```

    - Node 22+ defaults to `autoSelectFamily=true` (except WSL2). Telegram DNS result order honors `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER`, then `channels.telegram.network.dnsResultOrder`, then the process default (for example `NODE_OPTIONS=--dns-result-order=ipv4first`), falling back to `ipv4first` on Node 22+ if none applies.
    - On WSL2, or when IPv4-only behavior works better, force family selection:

```yaml
channels:
  telegram:
    network:
      autoSelectFamily: false
```

    - RFC 2544 benchmark-range answers (`198.18.0.0/15`) are already allowed for Telegram media downloads by default. If a trusted fake-IP or transparent proxy rewrites `api.telegram.org` to some other private/internal/special-use address during media downloads, opt in to the Telegram-only bypass:

```yaml
channels:
  telegram:
    network:
      dangerouslyAllowPrivateNetwork: true
```

    - The same opt-in is available per account at `channels.telegram.accounts.<accountId>.network.dangerouslyAllowPrivateNetwork`.
    - If your proxy resolves Telegram media hosts into `198.18.x.x`, leave the dangerous flag off first — that range is already allowed by default.

    <Warning>
      `channels.telegram.network.dangerouslyAllowPrivateNetwork` weakens Telegram media SSRF protections. Use it only for trusted operator-controlled proxy environments (Clash, Mihomo, Surge fake-IP routing) that synthesize private or special-use answers outside the RFC 2544 benchmark range. Leave it off for normal public internet Telegram access.
    </Warning>

    - Temporary environment overrides: `OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1`, `OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY=1`, `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first`.
    - Validate DNS answers:

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

More help: [Channel troubleshooting](/channels/troubleshooting).

## Configuration reference

Primary reference: [Configuration reference - Telegram](/gateway/config-channels#telegram).

<Accordion title="High-signal Telegram fields">

- startup/auth: `enabled`, `botToken`, `tokenFile` (must be a regular file; symlinks are rejected), `accounts.*`
- access control: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `groups.*.topics.*`, top-level `bindings[]` (`type: "acp"`)
- topic defaults: `groups.<chatId>.topics."*"` applies to unmatched forum topics; exact topic IDs override it
- exec approvals: `execApprovals`, `accounts.*.execApprovals`
- command/menu: `commands.native`, `commands.nativeSkills`, `customCommands`
- threading/replies: `replyToMode`, `threadBindings`
- streaming: `streaming` (modes `off | partial | block | progress`), `streaming.preview.toolProgress`
- formatting/delivery: `textChunkLimit`, `streaming.chunkMode`, `richMessages`, `markdown.tables` (`off | bullets | code | block`), `linkPreview`, `responsePrefix`
- media/network: `mediaMaxMb`, `mediaGroupFlushMs`, `timeoutSeconds`, `pollingStallThresholdMs`, `retry`, `network.autoSelectFamily`, `network.dangerouslyAllowPrivateNetwork`, `proxy`
- custom API root: `apiRoot` (Bot API root only; do not include `/bot<TOKEN>`), `trustedLocalFileRoots` (self-hosted Bot API absolute `file_path` roots)
- webhook: `webhookUrl`, `webhookSecret`, `webhookPath`, `webhookHost`, `webhookPort`, `webhookCertPath`
- actions/capabilities: `capabilities.inlineButtons`, `actions.sendMessage|editMessage|deleteMessage|reactions|sticker|createForumTopic|editForumTopic`
- reactions: `reactionNotifications`, `reactionLevel`
- errors: `errorPolicy`, `errorCooldownMs`, `silentErrorReplies`
- writes/history: `configWrites`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`

</Accordion>

<Note>
Multi-account precedence: with two or more account IDs configured, set `channels.telegram.defaultAccount` (or include `channels.telegram.accounts.default`) to make default routing explicit. Otherwise OpenClaw falls back to the first normalized account ID and `openclaw doctor` warns. Named accounts inherit `channels.telegram.allowFrom` / `groupAllowFrom`, but not `accounts.default.*` values.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Pair a Telegram user to the gateway.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Group and topic allowlist behavior.
  </Card>
  <Card title="Channel routing" icon="route" href="/channels/channel-routing">
    Route inbound messages to agents.
  </Card>
  <Card title="Security" icon="shield" href="/gateway/security">
    Threat model and hardening.
  </Card>
  <Card title="Multi-agent routing" icon="sitemap" href="/concepts/multi-agent">
    Map groups and topics to agents.
  </Card>
  <Card title="Troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics.
  </Card>
</CardGroup>
