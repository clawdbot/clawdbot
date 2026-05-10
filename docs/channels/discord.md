---
summary: "Discord bot support status, capabilities, and configuration"
read_when:
  - Working on Discord channel features
title: "Discord"
---

Ready for DMs and guild channels via the official Discord gateway.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Discord DMs default to pairing mode.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Native command behavior and command catalog.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair flow.
  </Card>
</CardGroup>

## Quick setup

You will need to create a new application with a bot, add the bot to your server, and pair it to OpenClaw. We recommend adding your bot to your own private server. If you don't have one yet, [create one first](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server) (choose **Create My Own > For me and my friends**).

<Steps>
  <Step title="Create a Discord application and bot">
    Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it something like "OpenClaw".

    Click **Bot** on the sidebar. Set the **Username** to whatever you call your OpenClaw agent.

  </Step>

  <Step title="Enable privileged intents">
    Still on the **Bot** page, scroll down to **Privileged Gateway Intents** and enable:

    - **Message Content Intent** (required)
    - **Server Members Intent** (recommended; required for role allowlists and name-to-ID matching)
    - **Presence Intent** (optional; only needed for presence updates)

  </Step>

  <Step title="Copy your bot token">
    Scroll back up on the **Bot** page and click **Reset Token**.

    <Note>
    Despite the name, this generates your first token — nothing is being "reset."
    </Note>

    Copy the token and save it somewhere. This is your **Bot Token** and you will need it shortly.

  </Step>

  <Step title="Generate an invite URL and add the bot to your server">
    Click **OAuth2** on the sidebar. You'll generate an invite URL with the right permissions to add the bot to your server.

    Scroll down to **OAuth2 URL Generator** and enable:

    - `bot`
    - `applications.commands`

    A **Bot Permissions** section will appear below. Enable at least:

    **General Permissions**
      - View Channels
    **Text Permissions**
      - Send Messages
      - Read Message History
      - Embed Links
      - Attach Files
      - Add Reactions (optional)

    This is the baseline set for normal text channels. If you plan to post in Discord threads, including forum or media channel workflows that create or continue a thread, also enable **Send Messages in Threads**.
    Copy the generated URL at the bottom, paste it into your browser, select your server, and click **Continue** to connect. You should now see your bot in the Discord server.

  </Step>

  <Step title="Enable Developer Mode and collect your IDs">
    Back in the Discord app, you need to enable Developer Mode so you can copy internal IDs.

    1. Click **User Settings** (gear icon next to your avatar) → **Advanced** → toggle on **Developer Mode**
    2. Right-click your **server icon** in the sidebar → **Copy Server ID**
    3. Right-click your **own avatar** → **Copy User ID**

    Save your **Server ID** and **User ID** alongside your Bot Token — you'll send all three to OpenClaw in the next step.

  </Step>

  <Step title="Allow DMs from server members">
    For pairing to work, Discord needs to allow your bot to DM you. Right-click your **server icon** → **Privacy Settings** → toggle on **Direct Messages**.

    This lets server members (including bots) send you DMs. Keep this enabled if you want to use Discord DMs with OpenClaw. If you only plan to use guild channels, you can disable DMs after pairing.

  </Step>

  <Step title="Set your bot token securely (do not send it in chat)">
    Your Discord bot token is a secret (like a password). Set it on the machine running OpenClaw before messaging your agent.

```bash
export DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN"
cat > discord.patch.json5 <<'JSON5'
{
  channels: {
    discord: {
      enabled: true,
      token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
    },
  },
}
JSON5
openclaw config patch --file ./discord.patch.json5 --dry-run
openclaw config patch --file ./discord.patch.json5
openclaw gateway
```

    If OpenClaw is already running as a background service, restart it via the OpenClaw Mac app or by stopping and restarting the `openclaw gateway run` process.
    For managed service installs, run `openclaw gateway install` from a shell where `DISCORD_BOT_TOKEN` is present, or store the variable in `~/.openclaw/.env`, so the service can resolve the env SecretRef after restart.
    If your host is blocked or rate-limited by Discord's startup application lookup, set the Discord application/client ID from the Developer Portal so startup can skip that REST call. Use `channels.discord.applicationId` for the default account, or `channels.discord.accounts.<accountId>.applicationId` when you run multiple Discord bots.

  </Step>

  <Step title="Configure OpenClaw and pair">

    <Tabs>
      <Tab title="Ask your agent">
        Chat with your OpenClaw agent on any existing channel (e.g. Telegram) and tell it. If Discord is your first channel, use the CLI / config tab instead.

        > "I already set my Discord bot token in config. Please finish Discord setup with User ID `<user_id>` and Server ID `<server_id>`."
      </Tab>
      <Tab title="CLI / config">
        If you prefer file-based config, set:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: {
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      },
    },
  },
}
```

        Env fallback for the default account:

```bash
DISCORD_BOT_TOKEN=...
```

        For scripted or remote setup, write the same JSON5 block with `openclaw config patch --file ./discord.patch.json5 --dry-run` and then rerun without `--dry-run`. Plaintext `token` values are supported. SecretRef values are also supported for `channels.discord.token` across env/file/exec providers. See [Secrets Management](/gateway/secrets).

        For multiple Discord bots, keep each bot token and application ID under its account. A top-level `channels.discord.applicationId` is inherited by accounts, so only set it there when every account should use the same application ID.

```json5
{
  channels: {
    discord: {
      enabled: true,
      accounts: {
        personal: {
          token: { source: "env", provider: "default", id: "DISCORD_PERSONAL_TOKEN" },
          applicationId: "111111111111111111",
        },
        work: {
          token: { source: "env", provider: "default", id: "DISCORD_WORK_TOKEN" },
          applicationId: "222222222222222222",
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="Approve first DM pairing">
    Wait until the gateway is running, then DM your bot in Discord. It will respond with a pairing code.

    <Tabs>
      <Tab title="Ask your agent">
        Send the pairing code to your agent on your existing channel:

        > "Approve this Discord pairing code: `<CODE>`"
      </Tab>
      <Tab title="CLI">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

      </Tab>
    </Tabs>

    Pairing codes expire after 1 hour.

    You should now be able to chat with your agent in Discord via DM.

  </Step>
</Steps>

<Note>
Token resolution is account-aware. Config token values win over env fallback. `DISCORD_BOT_TOKEN` is only used for the default account.
If two enabled Discord accounts resolve to the same bot token, OpenClaw starts only one gateway monitor for that token. A config-sourced token wins over the default env fallback; otherwise the first enabled account wins and the duplicate account is reported disabled.
For advanced outbound calls (message tool/channel actions), an explicit per-call `token` is used for that call. This applies to send and read/probe-style actions (for example read/search/fetch/thread/pins/permissions). Account policy/retry settings still come from the selected account in the active runtime snapshot.
</Note>

## Recommended: Set up a guild workspace

Once DMs are working, you can set up your Discord server as a full workspace where each channel gets its own agent session with its own context. This is recommended for private servers where it's just you and your bot.

<Steps>
  <Step title="Add your server to the guild allowlist">
    This enables your agent to respond in any channel on your server, not just DMs.

    <Tabs>
      <Tab title="Ask your agent">
        > "Add my Discord Server ID `<server_id>` to the guild allowlist"
      </Tab>
      <Tab title="Config">

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: true,
          users: ["YOUR_USER_ID"],
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="Allow responses without @mention">
    By default, your agent only responds in guild channels when @mentioned. For a private server, you probably want it to respond to every message.

    In guild channels, normal assistant final replies stay private by default. Visible Discord output must be sent explicitly with the `message` tool, so the agent can lurk by default and only post when it decides a channel reply is useful.

    This means the selected model must reliably call tools. If Discord shows typing and the logs show token usage but no posted message, check the session log for assistant text with `didSendViaMessagingTool: false`. That means the model produced a private final answer instead of calling `message(action=send)`. Switch to a stronger tool-calling model, or use the config below to restore legacy automatic final replies.

    <Tabs>
      <Tab title="Ask your agent">
        > "Allow my agent to respond on this server without having to be @mentioned"
      </Tab>
      <Tab title="Config">
        Set `requireMention: false` in your guild config:

```json5
{
  channels: {
    discord: {
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: false,
        },
      },
    },
  },
}
```

        To restore legacy automatic final replies for group/channel rooms, set `messages.groupChat.visibleReplies: "automatic"`.

      </Tab>
    </Tabs>

  </Step>

  <Step title="Plan for memory in guild channels">
    By default, long-term memory (MEMORY.md) only loads in DM sessions. Guild channels do not auto-load MEMORY.md.

    <Tabs>
      <Tab title="Ask your agent">
        > "When I ask questions in Discord channels, use memory_search or memory_get if you need long-term context from MEMORY.md."
      </Tab>
      <Tab title="Manual">
        If you need shared context in every channel, put the stable instructions in `AGENTS.md` or `USER.md` (they are injected for every session). Keep long-term notes in `MEMORY.md` and access them on demand with memory tools.
      </Tab>
    </Tabs>

  </Step>
</Steps>

Now create some channels on your Discord server and start chatting. Your agent can see the channel name, and each channel gets its own isolated session — so you can set up `#coding`, `#home`, `#research`, or whatever fits your workflow.

## Runtime model

- Gateway owns the Discord connection.
- Reply routing is deterministic: Discord inbound replies back to Discord.
- Discord guild/channel metadata is added to the model prompt as untrusted
  context, not as a user-visible reply prefix. If a model copies that envelope
  back, OpenClaw strips the copied metadata from outbound replies and from
  future replay context.
- By default (`session.dmScope=main`), direct chats share the agent main session (`agent:main:main`).
- Guild channels are isolated session keys (`agent:<agentId>:discord:channel:<channelId>`).
- Group DMs are ignored by default (`channels.discord.dm.groupEnabled=false`).
- Native slash commands run in isolated command sessions (`agent:<agentId>:discord:slash:<userId>`), while still carrying `CommandTargetSessionKey` to the routed conversation session.
- Text-only cron/heartbeat announce delivery to Discord uses the final
  assistant-visible answer once. Media and structured component payloads remain
  multi-message when the agent emits multiple deliverable payloads.

## Forum channels

Discord forum and media channels only accept thread posts. OpenClaw supports two ways to create them:

- Send a message to the forum parent (`channel:<forumId>`) to auto-create a thread. The thread title uses the first non-empty line of your message.
- Use `openclaw message thread create` to create a thread directly. Do not pass `--message-id` for forum channels.

Example: send to forum parent to create a thread

```bash
openclaw message send --channel discord --target channel:<forumId> \
  --message "Topic title\nBody of the post"
```

Example: create a forum thread explicitly

```bash
openclaw message thread create --channel discord --target channel:<forumId> \
  --thread-name "Topic title" --message "Body of the post"
```

Forum parents do not accept Discord components. If you need components, send to the thread itself (`channel:<threadId>`).

## Interactive components

OpenClaw supports Discord components v2 containers for agent messages. Use the message tool with a `components` payload. Interaction results are routed back to the agent as normal inbound messages and follow the existing Discord `replyToMode` settings.

Supported blocks:

- `text`, `section`, `separator`, `actions`, `media-gallery`, `file`
- Action rows allow up to 5 buttons or a single select menu
- Select types: `string`, `user`, `role`, `mentionable`, `channel`

By default, components are single use. Set `components.reusable=true` to allow buttons, selects, and forms to be used multiple times until they expire.

To restrict who can click a button, set `allowedUsers` on that button (Discord user IDs, tags, or `*`). When configured, unmatched users receive an ephemeral denial.

The `/model` and `/models` slash commands open an interactive model picker with provider, model, and compatible runtime dropdowns plus a Submit step. `/models add` is deprecated and now returns a deprecation message instead of registering models from chat. The picker reply is ephemeral and only the invoking user can use it. Discord select menus are limited to 25 options, so add `provider/*` entries to `agents.defaults.models` when you want the picker to show dynamically discovered models only for selected providers such as `openai-codex` or `vllm`.

File attachments:

- `file` blocks must point to an attachment reference (`attachment://<filename>`)
- Provide the attachment via `media`/`path`/`filePath` (single file); use `media-gallery` for multiple files
- Use `filename` to override the upload name when it should match the attachment reference

Modal forms:

- Add `components.modal` with up to 5 fields
- Field types: `text`, `checkbox`, `radio`, `select`, `role-select`, `user-select`
- OpenClaw adds a trigger button automatically

Example:

```json5
{
  channel: "discord",
  action: "send",
  to: "channel:123456789012345678",
  message: "Optional fallback text",
  components: {
    reusable: true,
    text: "Choose a path",
    blocks: [
      {
        type: "actions",
        buttons: [
          {
            label: "Approve",
            style: "success",
            allowedUsers: ["123456789012345678"],
          },
          { label: "Decline", style: "danger" },
        ],
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "Pick an option",
          options: [
            { label: "Option A", value: "a" },
            { label: "Option B", value: "b" },
          ],
        },
      },
    ],
    modal: {
      title: "Details",
      triggerLabel: "Open form",
      fields: [
        { type: "text", label: "Requester" },
        {
          type: "select",
          label: "Priority",
          options: [
            { label: "Low", value: "low" },
            { label: "High", value: "high" },
          ],
        },
      ],
    },
  },
}
```

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.discord.dmPolicy` controls DM access. `channels.discord.allowFrom` is the canonical DM allowlist.

    - `pairing` (default)
    - `allowlist`
    - `open` (requires `channels.discord.allowFrom` to include `"*"`)
    - `disabled`

    If DM policy is not open, unknown users are blocked (or prompted for pairing in `pairing` mode).

    Multi-account precedence:

    - `channels.discord.accounts.default.allowFrom` applies only to the `default` account.
    - For one account, `allowFrom` takes precedence over legacy `dm.allowFrom`.
    - Named accounts inherit `channels.discord.allowFrom` when their own `allowFrom` and legacy `dm.allowFrom` are unset.
    - Named accounts do not inherit `channels.discord.accounts.default.allowFrom`.

    Legacy `channels.discord.dm.policy` and `channels.discord.dm.allowFrom` still read for compatibility. `openclaw doctor --fix` migrates them to `dmPolicy` and `allowFrom` when it can do so without changing access.

    DM target format for delivery:

    - `user:<id>`
    - `<@id>` mention

    Bare numeric IDs normally resolve as channel IDs when a channel default is active, but IDs listed in the account's effective DM `allowFrom` are treated as user DM targets for compatibility.

  </Tab>

  <Tab title="Access groups">
    Discord DMs and text command authorization can use dynamic `accessGroup:<name>` entries in `channels.discord.allowFrom`.

    Access group names are shared across message channels. Use `type: "message.senders"` for a static group whose members are expressed in each channel's normal `allowFrom` syntax, or `type: "discord.channelAudience"` when a Discord channel's current `ViewChannel` audience should define membership dynamically. Shared access-group behavior is documented here: [Access groups](/channels/access-groups).

```json5
{
  accessGroups: {
    operators: {
      type: "message.senders",
      members: {
        "*": ["global-owner-id"],
        discord: ["discord:123456789012345678"],
        telegram: ["987654321"],
      },
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:operators"],
    },
  },
}
```

    A Discord text channel has no separate member list. `type: "discord.channelAudience"` models membership as: the DM sender is a member of the configured guild and currently has effective `ViewChannel` permission on the configured channel after role and channel overwrites are applied.

    Example: allow anyone who can see `#maintainers` to DM the bot, while keeping DMs closed to everyone else.

```json5
{
  accessGroups: {
    maintainers: {
      type: "discord.channelAudience",
      guildId: "1456350064065904867",
      channelId: "1456744319972282449",
      membership: "canViewChannel",
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:maintainers"],
    },
  },
}
```

    You can mix dynamic and static entries:

```json5
{
  accessGroups: {
    maintainers: {
      type: "discord.channelAudience",
      guildId: "1456350064065904867",
      channelId: "1456744319972282449",
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:maintainers", "discord:123456789012345678"],
    },
  },
}
```

    Lookups fail closed. If Discord returns `Missing Access`, the member lookup fails, or the channel belongs to a different guild, the DM sender is treated as unauthorized.

    Enable the Discord Developer Portal **Server Members Intent** for the bot when using channel-audience access groups. DMs do not include guild member state, so OpenClaw resolves the member through Discord REST at authorization time.

  </Tab>

  <Tab title="Guild policy">
    Guild handling is controlled by `channels.discord.groupPolicy`:

    - `open`
    - `allowlist`
    - `disabled`

    Secure baseline when `channels.discord` exists is `allowlist`.

    `allowlist` behavior:

    - guild must match `channels.discord.guilds` (`id` preferred, slug accepted)
    - optional sender allowlists: `users` (stable IDs recommended) and `roles` (role IDs only); if either is configured, senders are allowed when they match `users` OR `roles`
    - direct name/tag matching is disabled by default; enable `channels.discord.dangerouslyAllowNameMatching: true` only as break-glass compatibility mode
    - names/tags are supported for `users`, but IDs are safer; `openclaw security audit` warns when name/tag entries are used
    - if a guild has `channels` configured, non-listed channels are denied
    - if a guild has no `channels` block, all channels in that allowlisted guild are allowed

    Example:

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          ignoreOtherMentions: true,
          users: ["987654321098765432"],
          roles: ["123456789012345678"],
          channels: {
            general: { allow: true },
            help: { allow: true, requireMention: true },
          },
        },
      },
    },
  },
}
```

    If you only set `DISCORD_BOT_TOKEN` and do not create a `channels.discord` block, runtime fallback is `groupPolicy="allowlist"` (with a warning in logs), even if `channels.defaults.groupPolicy` is `open`.

  </Tab>

  <Tab title="Mentions and group DMs">
    Guild messages are mention-gated by default.

    Mention detection includes:

    - explicit bot mention
    - configured mention patterns (`agents.list[].groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
    - implicit reply-to-bot behavior in supported cases

    When writing outbound Discord messages, use canonical mention syntax: `<@USER_ID>` for users, `<#CHANNEL_ID>` for channels, and `<@&ROLE_ID>` for roles. Do not use the legacy `<@!USER_ID>` nickname mention form.

    `requireMention` is configured per guild/channel (`channels.discord.guilds...`).
    `ignoreOtherMentions` optionally drops messages that mention another user/role but not the bot (excluding @everyone/@here).

    Group DMs:

    - default: ignored (`dm.groupEnabled=false`)
    - optional allowlist via `dm.groupChannels` (channel IDs or slugs)

  </Tab>
</Tabs>

### Role-based agent routing

Use `bindings[].match.roles` to route Discord guild members to different agents by role ID. Role-based bindings accept role IDs only and are evaluated after peer or parent-peer bindings and before guild-only bindings. If a binding also sets other match fields (for example `peer` + `guildId` + `roles`), all configured fields must match.

```json5
{
  bindings: [
    {
      agentId: "opus",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
        roles: ["111111111111111111"],
      },
    },
    {
      agentId: "sonnet",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
      },
    },
  ],
}
```

## Native commands and command auth

- `commands.native` defaults to `"auto"` and is enabled for Discord.
- Per-channel override: `channels.discord.commands.native`.
- `commands.native=false` skips Discord slash-command registration and cleanup during startup. Previously registered commands may remain visible in Discord until you remove them from the Discord app.
- Native command auth uses the same Discord allowlists/policies as normal message handling.
- Commands may still be visible in Discord UI for users who are not authorized; execution still enforces OpenClaw auth and returns "not authorized".

See [Slash commands](/tools/slash-commands) for command catalog and behavior.

Default slash command settings:

- `ephemeral: true`

## Feature details

<AccordionGroup>
  <Accordion title="Reply tags and native replies">
    Discord supports reply tags in agent output:

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    Controlled by `channels.discord.replyToMode`:

    - `off` (default)
    - `first`
    - `all`
    - `batched`

    Note: `off` disables implicit reply threading. Explicit `[[reply_to_*]]` tags are still honored.
    `first` always attaches the implicit native reply reference to the first outbound Discord message for the turn.
    `batched` only attaches Discord's implicit native reply reference when the
    inbound turn was a debounced batch of multiple messages. This is useful
    when you want native replies mainly for ambiguous bursty chats, not every
    single-message turn.

    Message IDs are surfaced in context/history so agents can target specific messages.

  </Accordion>

  <Accordion title="Live stream preview">
    OpenClaw can stream draft replies by sending a temporary message and editing it as text arrives. `channels.discord.streaming` takes `off` | `partial` | `block` | `progress` (default). `progress` keeps one editable status draft and updates it with tool progress until final delivery; the shared starter label is a rolling line, so it scrolls away like the rest once enough work appears. `streamMode` is a legacy runtime alias. Run `openclaw doctor --fix` to rewrite persisted config to the canonical key.

    Set `channels.discord.streaming.mode` to `off` to disable Discord preview edits. If Discord block streaming is explicitly enabled, OpenClaw skips the preview stream to avoid double-streaming.

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          label: "auto",
          maxLines: 8,
          toolProgress: true,
        },
      },
    },
  },
}
```

    - `partial` edits a single preview message as tokens arrive.
    - `block` emits draft-sized chunks (use `draftChunk` to tune size and breakpoints, clamped to `textChunkLimit`).
    - Media, error, and explicit-reply finals cancel pending preview edits.
    - `streaming.preview.toolProgress` (default `true`) controls whether tool/progress updates reuse the preview message.
    - Tool/progress rows render as compact emoji + title + detail when available, for example `🛠️ Bash: run tests` or `🔎 Web Search: for "query"`.
    - `streaming.preview.commandText` / `streaming.progress.commandText` controls command/exec detail in compact progress lines: `raw` (default) or `status` (tool label only).

    Hide raw command/exec text while keeping compact progress lines:

    ```json
    {
      "channels": {
        "discord": {
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

    Preview streaming is text-only; media replies fall back to normal delivery. When `block` streaming is explicitly enabled, OpenClaw skips the preview stream to avoid double-streaming.

  </Accordion>

  <Accordion title="History, context, and thread behavior">
    Guild history context:

    - `channels.discord.historyLimit` default `20`
    - fallback: `messages.groupChat.historyLimit`
    - `0` disables

    DM history controls:

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    Thread behavior:

    - Discord threads route as channel sessions and inherit parent channel config unless overridden.
    - Thread sessions inherit the parent channel's session-level `/model` selection as a model-only fallback; thread-local `/model` selections still take precedence and parent transcript history is not copied unless transcript inheritance is enabled.
    - `channels.discord.thread.inheritParent` (default `false`) opts new auto-threads into seeding from the parent transcript. Per-account overrides live under `channels.discord.accounts.<id>.thread.inheritParent`.
    - Message-tool reactions can resolve `user:<id>` DM targets.
    - `guilds.<guild>.channels.<channel>.requireMention: false` is preserved during reply-stage activation fallback.

    Channel topics are injected as **untrusted** context. Allowlists gate who can trigger the agent, not a full supplemental-context redaction boundary.

  </Accordion>

  <Accordion title="Thread-bound sessions for subagents">
    Discord can bind a thread to a session target so follow-up messages in that thread keep routing to the same session (including subagent sessions).

    Commands:

    - `/focus <target>` bind current/new thread to a subagent/session target
    - `/unfocus` remove current thread binding
    - `/agents` show active runs and binding state
    - `/session idle <duration|off>` inspect/update inactivity auto-unfocus for focused bindings
    - `/session max-age <duration|off>` inspect/update hard max age for focused bindings

    Config:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0,
        spawnSessions: true,
        defaultSpawnContext: "fork",
      },
    },
  },
}
```

    Notes:

    - `session.threadBindings.*` sets global defaults.
    - `channels.discord.threadBindings.*` overrides Discord behavior.
    - `spawnSessions` controls auto-create/bind threads for `sessions_spawn({ thread: true })` and ACP thread spawns. Default: `true`.
    - `defaultSpawnContext` controls native subagent context for thread-bound spawns. Default: `"fork"`.
    - Deprecated `spawnSubagentSessions`/`spawnAcpSessions` keys are migrated by `openclaw doctor --fix`.
    - If thread bindings are disabled for an account, `/focus` and related thread binding operations are unavailable.

    See [Sub-agents](/tools/subagents), [ACP Agents](/tools/acp-agents), and [Configuration Reference](/gateway/configuration-reference).

  </Accordion>

  <Accordion title="Persistent ACP channel bindings">
    For stable "always-on" ACP workspaces, configure top-level typed ACP bindings targeting Discord conversations.

    Config path:

    - `bindings[]` with `type: "acp"` and `match.channel: "discord"`

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
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "222222222222222222" },
      },
      acp: { label: "codex-main" },
    },
  ],
  channels: {
    discord: {
      guilds: {
        "111111111111111111": {
          channels: {
            "222222222222222222": {
              requireMention: false,
            },
          },
        },
      },
    },
  },
}
```

    Notes:

    - `/acp spawn codex --bind here` binds the current channel or thread in place and keeps future messages on the same ACP session. Thread messages inherit the parent channel binding.
    - In a bound channel or thread, `/new` and `/reset` reset the same ACP session in place. Temporary thread bindings can override target resolution while active.
    - `spawnSessions` gates child thread creation/binding via `--thread auto|here`.

    See [ACP Agents](/tools/acp-agents) for binding behavior details.

  </Accordion>

  <Accordion title="Reaction notifications">
    Per-guild reaction notification mode:

    - `off`
    - `own` (default)
    - `all`
    - `allowlist` (uses `guilds.<id>.users`)

    Reaction events are turned into system events and attached to the routed Discord session.

  </Accordion>

  <Accordion title="Ack reactions">
    `ackReaction` sends an acknowledgement emoji while OpenClaw is processing an inbound message.

    Resolution order:

    - `channels.discord.accounts.<accountId>.ackReaction`
    - `channels.discord.ackReaction`
    - `messages.ackReaction`
    - agent identity emoji fallback (`agents.list[].identity.emoji`, else "👀")

    Notes:

    - Discord accepts unicode emoji or custom emoji names.
    - Use `""` to disable the reaction for a channel or account.

  </Accordion>

  <Accordion title="Config writes">
    Channel-initiated config writes are enabled by default.

    This affects `/config set|unset` flows (when command features are enabled).

    Disable:

```json5
{
  channels: {
    discord: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Gateway proxy">
    Route Discord gateway WebSocket traffic and startup REST lookups (application ID + allowlist resolution) through an HTTP(S) proxy with `channels.discord.proxy`.

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    Per-account override:

```json5
{
  channels: {
    discord: {
      accounts: {
        primary: {
          proxy: "http://proxy.example:8080",
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="PluralKit support">
    Enable PluralKit resolution to map proxied messages to system member identity:

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; needed for private systems
      },
    },
  },
}
```

    Notes:

    - allowlists can use `pk:<memberId>`
    - member display names are matched by name/slug only when `channels.discord.dangerouslyAllowNameMatching: true`
    - lookups use original message ID and are time-window constrained
    - if lookup fails, proxied messages are treated as bot messages and dropped unless `allowBots=true`

  </Accordion>

  <Accordion title="Outbound mention aliases">
    Use `mentionAliases` when agents need deterministic outbound mentions for known Discord users. Keys are handles without the leading `@`; values are Discord user IDs. Unknown handles, `@everyone`, `@here`, and mentions inside Markdown code spans are left unchanged.

```json5
{
  channels: {
    discord: {
      mentionAliases: {
        Vladislava: "123456789012345678",
      },
      accounts: {
        ops: {
          mentionAliases: {
            OpsLead: "234567890123456789",
          },
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="Presence configuration">
    Presence updates are applied when you set a status or activity field, or when you enable auto presence.

    Status only example:

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    Activity example (custom status is the default activity type):

```json5
{
  channels: {
    discord: {
      activity: "Focus time",
      activityType: 4,
    },
  },
}
```

    Streaming example:

```json5
{
  channels: {
    discord: {
      activity: "Live coding",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    },
  },
}
```

    Activity type map:

    - 0: Playing
    - 1: Streaming (requires `activityUrl`)
    - 2: Listening
    - 3: Watching
    - 4: Custom (uses the activity text as the status state; emoji is optional)
    - 5: Competing

    Auto presence example (runtime health signal):

```json5
{
  channels: {
    discord: {
      autoPresence: {
        enabled: true,
        intervalMs: 30000,
        minUpdateIntervalMs: 15000,
        exhaustedText: "token exhausted",
      },
    },
  },
}
```

    Auto presence maps runtime availability to Discord status: healthy => online, degraded or unknown => idle, exhausted or unavailable => dnd. Optional text overrides:

    - `autoPresence.healthyText`
    - `autoPresence.degradedText`
    - `autoPresence.exhaustedText` (supports `{reason}` placeholder)

  </Accordion>

  <Accordion title="Approvals in Discord">
    Discord supports button-based approval handling in DMs and can optionally post approval prompts in the originating channel.

    Config path:

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers` (optional; falls back to `commands.ownerAllowFrom` when possible)
    - `channels.discord.execApprovals.target` (`dm` | `channel` | `both`, default: `dm`)
    - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

    Discord auto-enables native exec approvals when `enabled` is unset or `"auto"` and at least one approver can be resolved, either from `execApprovals.approvers` or from `commands.ownerAllowFrom`. Discord does not infer exec approvers from channel `allowFrom`, legacy `dm.allowFrom`, or direct-message `defaultTo`. Set `enabled: false` to disable Discord as a native approval client explicitly.

    For sensitive owner-only group commands such as `/diagnostics` and `/export-trajectory`, OpenClaw sends approval prompts and final results privately. It tries Discord DM first when the invoking owner has a Discord owner route; if that is not available, it falls back to the first available owner route from `commands.ownerAllowFrom`, such as Telegram.

    When `target` is `channel` or `both`, the approval prompt is visible in the channel. Only resolved approvers can use the buttons; other users receive an ephemeral denial. Approval prompts include the command text, so only enable channel delivery in trusted channels. If the channel ID cannot be derived from the session key, OpenClaw falls back to DM delivery.

    Discord also renders the shared approval buttons used by other chat channels. The native Discord adapter mainly adds approver DM routing and channel fanout.
    When those buttons are present, they are the primary approval UX; OpenClaw
    should only include a manual `/approve` command when the tool result says
    chat approvals are unavailable or manual approval is the only path.
    If the Discord native approval runtime is not active, OpenClaw keeps the
    local deterministic `/approve <id> <decision>` prompt visible. If the
    runtime is active but a native card cannot be delivered to any target,
    OpenClaw sends a same-chat fallback notice with the exact `/approve`
    command from the pending approval.

    Gateway auth and approval resolution follow the shared Gateway client contract (`plugin:` IDs resolve through `plugin.approval.resolve`; other IDs through `exec.approval.resolve`). Approvals expire after 30 minutes by default.

    See [Exec approvals](/tools/exec-approvals).

  </Accordion>
</AccordionGroup>

## Tools and action gates

Discord message actions include messaging, channel admin, moderation, presence, and metadata actions.

Core examples:

- messaging: `sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- reactions: `react`, `reactions`, `emojiList`
- moderation: `timeout`, `kick`, `ban`
- presence: `setPresence`

The `event-create` action accepts an optional `image` parameter (URL or local file path) to set the scheduled event cover image.

Action gates live under `channels.discord.actions.*`.

Default gate behavior:

| Action group                                                                                                                                                             | Default  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| reactions, messages, threads, pins, polls, search, memberInfo, roleInfo, channelInfo, channels, voiceStatus, events, stickers, emojiUploads, stickerUploads, permissions | enabled  |
| roles                                                                                                                                                                    | disabled |
| moderation                                                                                                                                                               | disabled |
| presence                                                                                                                                                                 | disabled |

## Components v2 UI

OpenClaw uses Discord components v2 for exec approvals and cross-context markers. Discord message actions can also accept `components` for custom UI (advanced; requires constructing a component payload via the discord tool), while legacy `embeds` remain available but are not recommended.

- `channels.discord.ui.components.accentColor` sets the accent color used by Discord component containers (hex).
- Set per account with `channels.discord.accounts.<id>.ui.components.accentColor`.
- `embeds` are ignored when components v2 are present.

Example:

```json5
{
  channels: {
    discord: {
      ui: {
        components: {
          accentColor: "#5865F2",
        },
      },
    },
  },
}
```

## Voice

Discord has two distinct voice surfaces: realtime **voice channels** (continuous conversations) and **voice message attachments** (the waveform preview format). The gateway supports both.

### Voice channels

Setup checklist:

1. Enable Message Content Intent in the Discord Developer Portal.
2. Enable Server Members Intent when role/user allowlists are used.
3. Invite the bot with `bot` and `applications.commands` scopes.
4. Grant Connect, Speak, Send Messages, and Read Message History in the target voice channel.
5. Enable native commands (`commands.native` or `channels.discord.commands.native`).
6. Configure `channels.discord.voice`.

Use `/vc join|leave|status` to control sessions. The command uses the account default agent and follows the same allowlist and group policy rules as other Discord commands.

```bash
/vc join channel:<voice-channel-id>
/vc status
/vc leave
```

To inspect the bot's effective permissions before joining, run:

```bash
openclaw channels capabilities --channel discord --target channel:<voice-channel-id>
```

Auto-join example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        model: "openai-codex/gpt-5.5",
        autoJoin: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
          },
        ],
        daveEncryption: true,
        decryptionFailureTolerance: 24,
        connectTimeoutMs: 30000,
        reconnectGraceMs: 15000,
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          voice: "cedar",
        },
      },
    },
  },
}
```

Notes:

- `voice.tts` overrides `messages.tts` for `stt-tts` voice playback only. Realtime modes use `voice.realtime.voice`.
- `voice.mode` controls the conversation path. The default is `agent-proxy`: a realtime voice front end handles turn timing, interruption, and playback, delegates substantive work to the routed OpenClaw agent through `openclaw_agent_consult`, and treats the result like a typed Discord prompt from that speaker. `stt-tts` keeps the older batch STT plus TTS flow. `bidi` lets the realtime model converse directly while exposing `openclaw_agent_consult` for the OpenClaw brain.
- `voice.agentSession` controls which OpenClaw conversation receives voice turns. Leave it unset for the voice channel's own session, or set `{ mode: "target", target: "channel:<text-channel-id>" }` to make the voice channel act as the microphone/speaker extension of an existing Discord text channel session such as `#maintainers`.
- `voice.model` overrides the OpenClaw agent brain for Discord voice responses and realtime consults. Leave it unset to inherit the routed agent model. It is separate from `voice.realtime.model`.
- `agent-proxy` routes speech through `discord-voice`, which preserves normal owner/tool authorization for the speaker and target session but hides the agent `tts` tool because Discord voice owns playback. By default, `agent-proxy` gives the consult full owner-equivalent tool access for owner speakers (`voice.realtime.toolPolicy: "owner"`) and strongly prefers consulting the OpenClaw agent before substantive answers (`voice.realtime.consultPolicy: "always"`). In that default `always` mode, the realtime layer does not auto-speak filler before the consult answer; it captures and transcribes speech, then speaks the routed OpenClaw answer. If multiple forced consult answers finish while Discord is still playing the first answer, later exact-speech answers are queued until playback idles instead of replacing speech mid-sentence.
- In `stt-tts` mode, STT uses `tools.media.audio`; `voice.model` does not affect transcription.
- In realtime modes, `voice.realtime.provider`, `voice.realtime.model`, and `voice.realtime.voice` configure the realtime audio session. For OpenAI Realtime 2 plus the Codex brain, use `voice.realtime.model: "gpt-realtime-2"` and `voice.model: "openai-codex/gpt-5.5"`.
- The OpenAI realtime provider accepts current Realtime 2 event names and legacy Codex-compatible aliases for output audio and transcript events, so compatible provider snapshots can drift without dropping assistant audio.
- `voice.realtime.bargeIn` controls whether Discord speaker-start events interrupt active realtime playback. If unset, it follows the realtime provider's input-audio interruption setting.
- `voice.realtime.minBargeInAudioEndMs` controls the minimum assistant playback duration before an OpenAI realtime barge-in truncates audio. Default: `250`. Set `0` for immediate interruption in low-echo rooms, or raise it for echo-heavy speaker setups.
- For an OpenAI voice on Discord playback, set `voice.tts.provider: "openai"` and choose a Text-to-speech voice under `voice.tts.openai.voice` or `voice.tts.providers.openai.voice`. `cedar` is a good masculine-sounding choice on the current OpenAI TTS model.
- Per-channel Discord `systemPrompt` overrides apply to voice transcript turns for that voice channel.
- Voice transcript turns derive owner status from Discord `allowFrom` (or `dm.allowFrom`); non-owner speakers cannot access owner-only tools (for example `gateway` and `cron`).
- Discord voice is opt-in for text-only configs; set `channels.discord.voice.enabled=true` (or keep an existing `channels.discord.voice` block) to enable `/vc` commands, the voice runtime, and the `GuildVoiceStates` gateway intent.
- `channels.discord.intents.voiceStates` can explicitly override voice-state intent subscription. Leave it unset for the intent to follow effective voice enablement.
- If `voice.autoJoin` has multiple entries for the same guild, OpenClaw joins the last configured channel for that guild.
- `voice.daveEncryption` and `voice.decryptionFailureTolerance` pass through to `@discordjs/voice` join options.
- `@discordjs/voice` defaults are `daveEncryption=true` and `decryptionFailureTolerance=24` if unset.
- OpenClaw defaults to the pure-JS `opusscript` decoder for Discord voice receive. The optional native `@discordjs/opus` package is ignored by the repo pnpm install policy so normal installs, Docker lanes, and unrelated tests do not compile a native addon. Dedicated voice-performance hosts can opt in with `OPENCLAW_DISCORD_OPUS_DECODER=native` after installing the native addon.
- `voice.connectTimeoutMs` controls the initial `@discordjs/voice` Ready wait for `/vc join` and auto-join attempts. Default: `30000`.
- `voice.reconnectGraceMs` controls how long OpenClaw waits for a disconnected voice session to begin reconnecting before destroying it. Default: `15000`.
- In `stt-tts` mode, voice playback does not stop just because another user starts speaking. To avoid feedback loops, OpenClaw ignores new voice capture while TTS is playing; speak after playback finishes for the next turn. Realtime modes forward speaker starts as barge-in signals to the realtime provider.
- In realtime modes, echo from speakers into an open mic can look like barge-in and interrupt playback. For echo-heavy Discord rooms, set `voice.realtime.providers.openai.interruptResponseOnInputAudio: false` to keep OpenAI from auto-interrupting on input audio. Add `voice.realtime.bargeIn: true` if you still want Discord speaker-start events to interrupt active playback. The OpenAI realtime bridge ignores playback truncations shorter than `voice.realtime.minBargeInAudioEndMs` as likely echo/noise and logs them as skipped instead of clearing Discord playback.
- `voice.captureSilenceGraceMs` controls how long OpenClaw waits after Discord reports a speaker has stopped before finalizing that audio segment for STT. Default: `2500`; raise this if Discord splits normal pauses into choppy partial transcripts.
- When ElevenLabs is the selected TTS provider, Discord voice playback uses streaming TTS and starts from the provider response stream. Providers without streaming support fall back to the synthesized temp-file path.
- OpenClaw also watches receive decrypt failures and auto-recovers by leaving/rejoining the voice channel after repeated failures in a short window.
- If receive logs repeatedly show `DecryptionFailed(UnencryptedWhenPassthroughDisabled)` after updating, collect a dependency report and logs. The bundled `@discordjs/voice` line includes the upstream padding fix from discord.js PR #11449, which closed discord.js issue #11419.
- `The operation was aborted` receive events are expected when OpenClaw finalizes a captured speaker segment; they are verbose diagnostics, not warnings.
- Verbose Discord voice logs include a bounded one-line STT transcript preview for each accepted speaker segment, so debugging shows both the user side and the agent reply side without dumping unbounded transcript text.
- In `agent-proxy` mode, forced consult fallback skips likely incomplete transcript fragments such as text ending in `...` or a trailing connector like `and`, plus obvious non-actionable closings like “be right back” or “bye”. Logs show `forced agent consult skipped reason=...` when this prevents a stale queued answer.

Native opus setup for source checkouts:

```bash
pnpm install
mise exec node@22 -- pnpm discord:opus:install
```

Use Node 22 for the gateway when you want the upstream macOS arm64 prebuilt native addon. If you use another Node runtime, the opt-in installer may need a local `node-gyp` source-build toolchain.

After installing the native addon, start the Gateway with:

```bash
OPENCLAW_DISCORD_OPUS_DECODER=native pnpm gateway:watch
```

Verbose voice logs should show `discord voice: opus decoder: @discordjs/opus`. Without the env opt-in, or if the native addon is missing or cannot load on the host, OpenClaw logs `discord voice: opus decoder: opusscript` and keeps receiving voice through the pure-JS fallback.

STT plus TTS pipeline:

- Discord PCM capture is converted to a WAV temp file.
- `tools.media.audio` handles STT, for example `openai/gpt-4o-mini-transcribe`.
- The transcript is sent through Discord ingress and routing while the response LLM runs with a voice-output policy that hides the agent `tts` tool and asks for returned text, because Discord voice owns final TTS playback.
- `voice.model`, when set, overrides only the response LLM for this voice-channel turn.
- `voice.tts` is merged over `messages.tts`; streaming-capable providers feed the player directly, otherwise the resulting audio file is played in the joined channel.

Default agent-proxy voice-channel session example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        model: "openai-codex/gpt-5.5",
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          voice: "cedar",
        },
      },
    },
  },
}
```

With no `voice.agentSession` block, each voice channel gets its own routed OpenClaw session. For example, `/vc join channel:234567890123456789` talks to the session for that Discord voice channel. The realtime model is only the voice front end; substantive requests are handed to the configured OpenClaw agent. If the realtime model produces a final transcript without calling the consult tool, OpenClaw forces the consult as a fallback so the default still behaves like talking to the agent.

Legacy STT plus TTS example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        mode: "stt-tts",
        model: "openai/gpt-5.4-mini",
        tts: {
          provider: "openai",
          openai: {
            model: "gpt-4o-mini-tts",
            voice: "cedar",
          },
        },
      },
    },
  },
}
```

Realtime bidi example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        mode: "bidi",
        model: "openai-codex/gpt-5.5",
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          voice: "cedar",
          toolPolicy: "safe-read-only",
          consultPolicy: "always",
        },
      },
    },
  },
}
```

Voice as an extension of an existing Discord channel session:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        mode: "agent-proxy",
        model: "openai-codex/gpt-5.5",
        agentSession: {
          mode: "target",
          target: "channel:123456789012345678",
        },
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          voice: "cedar",
        },
      },
    },
  },
}
```

In `agent-proxy` mode the bot joins the configured voice channel, but OpenClaw agent turns use the target channel's normal routed session and agent. The realtime voice session speaks the returned result back into the voice channel. The supervisor agent can still use normal message tools according to its tool policy, including sending a separate Discord message if that is the right action.

Useful target forms:

- `target: "channel:123456789012345678"` routes through a Discord text channel session.
- `target: "123456789012345678"` is treated as a channel target.
- `target: "dm:123456789012345678"` or `target: "user:123456789012345678"` routes through that direct-message session.

Echo-heavy OpenAI Realtime example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        mode: "bidi",
        model: "openai-codex/gpt-5.5",
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          voice: "cedar",
          bargeIn: true,
          minBargeInAudioEndMs: 500,
          consultPolicy: "always",
          providers: {
            openai: {
              interruptResponseOnInputAudio: false,
            },
          },
        },
      },
    },
  },
}
```

Use this when the model hears its own Discord playback through an open mic, but you still want to interrupt it by speaking. OpenClaw keeps OpenAI from auto-interrupting on raw input audio, while `bargeIn: true` lets Discord speaker-start events and already-active speaker audio cancel active realtime responses before the next captured turn reaches OpenAI. Very early barge-in signals with `audioEndMs` below `minBargeInAudioEndMs` are treated as likely echo/noise and ignored so the model does not cut off at the first playback frame.

Expected voice logs:

- On join: `discord voice: joining ... voiceSession=... supervisorSession=... agentSessionMode=... voiceModel=... realtimeModel=...`
- On realtime start: `discord voice: realtime bridge starting ... autoRespond=false interruptResponse=false bargeIn=false minBargeInAudioEndMs=...`
- On speaker audio: `discord voice: realtime speaker turn opened ...`, `discord voice: realtime input audio started ... outputAudioMs=... outputActive=...`, and `discord voice: realtime speaker turn closed ... chunks=... discordBytes=... realtimeBytes=... interruptedPlayback=...`
- On skipped stale speech: `discord voice: realtime forced agent consult skipped reason=incomplete-transcript ...` or `reason=non-actionable-closing ...`
- On realtime response completion: `discord voice: realtime audio playback finishing reason=response.done ... audioMs=... chunks=...`
- On playback stop/reset: `discord voice: realtime audio playback stopped reason=... audioMs=... elapsedMs=... chunks=...`
- On realtime consult: `discord voice: realtime consult requested ... voiceSession=... supervisorSession=... question=...`
- On agent answer: `discord voice: agent turn answer ...`
- On queued exact speech: `discord voice: realtime exact speech queued ... queued=... outputAudioMs=... outputActive=...`, followed by `discord voice: realtime exact speech dequeued reason=player-idle ...`
- On barge-in detection: `discord voice: realtime barge-in detected source=speaker-start ...` or `discord voice: realtime barge-in detected source=active-speaker-audio ...`, followed by `discord voice: realtime barge-in requested reason=... outputAudioMs=... outputActive=...`
- On realtime interruption: `discord voice: realtime model interrupt requested client:response.cancel reason=barge-in`, followed by either `discord voice: realtime model audio truncated client:conversation.item.truncate reason=barge-in audioEndMs=...` or `discord voice: realtime model interrupt confirmed server:response.done status=cancelled ...`
- On ignored echo/noise: `discord voice: realtime model interrupt ignored client:conversation.item.truncate.skipped reason=barge-in audioEndMs=0 minAudioEndMs=250`
- On disabled barge-in: `discord voice: realtime capture ignored during playback (barge-in disabled) ...`
- On idle playback: `discord voice: realtime barge-in ignored reason=... outputActive=false ... playbackChunks=0`

To debug cut-off audio, read the realtime voice logs as a timeline:

1. `realtime audio playback started` means Discord has begun playing assistant audio. The bridge starts counting assistant output chunks, Discord PCM bytes, provider realtime bytes, and synthesized audio duration from this point.
2. `realtime speaker turn opened` marks a Discord speaker becoming active. If playback is already active and `bargeIn` is enabled, this can be followed by `barge-in detected source=speaker-start`.
3. `realtime input audio started` marks the first actual audio frame received for that speaker turn. `outputActive=true` or a nonzero `outputAudioMs` here means the mic is sending input while assistant playback is still active.
4. `barge-in detected source=active-speaker-audio` means OpenClaw saw live speaker audio while assistant playback was active. This is useful for distinguishing a real interruption from a Discord speaker-start event with no useful audio.
5. `barge-in requested reason=...` means OpenClaw asked the realtime provider to cancel or truncate the active response. It includes `outputAudioMs`, `outputActive`, and `playbackChunks` so you can see how much assistant audio had actually played before the interruption.
6. `realtime audio playback stopped reason=...` is the local Discord playback reset point. The reason says who stopped playback: `barge-in`, `player-idle`, `provider-clear-audio`, `forced-agent-consult`, `stream-close`, or `session-close`.
7. `realtime speaker turn closed` summarizes the captured input turn. `chunks=0` or `hasAudio=false` means the speaker turn opened but no usable audio reached the realtime bridge. `interruptedPlayback=true` means that input turn overlapped assistant output and triggered barge-in logic.

Useful fields:

- `outputAudioMs`: assistant audio duration generated by the realtime provider before the log line.
- `audioMs`: assistant audio duration that OpenClaw counted before playback stopped.
- `elapsedMs`: wall-clock time between opening and closing the playback stream or speaker turn.
- `discordBytes`: 48 kHz stereo PCM bytes sent to or received from Discord voice.
- `realtimeBytes`: provider-format PCM bytes sent to or received from the realtime provider.
- `playbackChunks`: assistant audio chunks forwarded to Discord for the active response.
- `sinceLastAudioMs`: gap between the last captured speaker audio frame and the speaker turn closing.

Common patterns:

- Immediate cut-off with `source=active-speaker-audio`, small `outputAudioMs`, and the same user nearby usually points to speaker echo entering the mic. Raise `voice.realtime.minBargeInAudioEndMs`, lower speaker volume, use headphones, or set `voice.realtime.providers.openai.interruptResponseOnInputAudio: false`.
- `source=speaker-start` followed by `speaker turn closed ... hasAudio=false` means Discord reported a speaker start but no audio reached OpenClaw. That can be a transient Discord voice event, noise gate behavior, or a client briefly keying the mic.
- `audio playback stopped reason=stream-close` without a nearby barge-in or `provider-clear-audio` means the local Discord playback stream ended unexpectedly. Check the preceding provider and Discord player logs.
- `capture ignored during playback (barge-in disabled)` means OpenClaw intentionally dropped input while assistant audio was active. Enable `voice.realtime.bargeIn` if you want speech to interrupt playback.
- `barge-in ignored ... outputActive=false` means Discord or provider VAD reported speech, but OpenClaw had no active playback to interrupt. This should not cut off audio.

Credentials are resolved per component: LLM route auth for `voice.model`, STT auth for `tools.media.audio`, TTS auth for `messages.tts`/`voice.tts`, and realtime provider auth for `voice.realtime.providers` or the provider's normal auth config.

### Voice messages

Discord voice messages show a waveform preview and require OGG/Opus audio. OpenClaw generates the waveform automatically, but needs `ffmpeg` and `ffprobe` on the gateway host to inspect and convert.

- Provide a **local file path** (URLs are rejected).
- Omit text content (Discord rejects text + voice message in the same payload).
- Any audio format is accepted; OpenClaw converts to OGG/Opus as needed.

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```

## Troubleshooting

<AccordionGroup>
  <Accordion title="Used disallowed intents or bot sees no guild messages">

    - enable Message Content Intent
    - enable Server Members Intent when you depend on user/member resolution
    - restart gateway after changing intents

  </Accordion>

  <Accordion title="Guild messages blocked unexpectedly">

    - verify `groupPolicy`
    - verify guild allowlist under `channels.discord.guilds`
    - if guild `channels` map exists, only listed channels are allowed
    - verify `requireMention` behavior and mention patterns

    Useful checks:

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="Require mention false but still blocked">
    Common causes:

    - `groupPolicy="allowlist"` without matching guild/channel allowlist
    - `requireMention` configured in the wrong place (must be under `channels.discord.guilds` or channel entry)
    - sender blocked by guild/channel `users` allowlist

  </Accordion>

  <Accordion title="Long-running Discord turns or duplicate replies">

    Typical logs:

    - `Slow listener detected ...`
    - `stuck session: sessionKey=agent:...:discord:... state=processing ...`

    Discord gateway queue knobs:

    - single-account: `channels.discord.eventQueue.listenerTimeout`
    - multi-account: `channels.discord.accounts.<accountId>.eventQueue.listenerTimeout`
    - this only controls Discord gateway listener work, not agent turn lifetime

    Discord does not apply a channel-owned timeout to queued agent turns. Message listeners hand off immediately, and queued Discord runs preserve per-session ordering until the session/tool/runtime lifecycle completes or aborts the work.

```json5
{
  channels: {
    discord: {
      accounts: {
        default: {
          eventQueue: {
            listenerTimeout: 120000,
          },
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="Gateway metadata lookup timeout warnings">
    OpenClaw fetches Discord `/gateway/bot` metadata before connecting. Transient failures fall back to Discord's default gateway URL and are rate-limited in logs.

    Metadata timeout knobs:

    - single-account: `channels.discord.gatewayInfoTimeoutMs`
    - multi-account: `channels.discord.accounts.<accountId>.gatewayInfoTimeoutMs`
    - env fallback when config is unset: `OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS`
    - default: `30000` (30 seconds), max: `120000`

  </Accordion>

  <Accordion title="Gateway READY timeout restarts">
    OpenClaw waits for Discord's gateway `READY` event during startup and after runtime reconnects. Multi-account setups with startup staggering can need a longer startup READY window than the default.

    READY timeout knobs:

    - startup single-account: `channels.discord.gatewayReadyTimeoutMs`
    - startup multi-account: `channels.discord.accounts.<accountId>.gatewayReadyTimeoutMs`
    - startup env fallback when config is unset: `OPENCLAW_DISCORD_READY_TIMEOUT_MS`
    - startup default: `15000` (15 seconds), max: `120000`
    - runtime single-account: `channels.discord.gatewayRuntimeReadyTimeoutMs`
    - runtime multi-account: `channels.discord.accounts.<accountId>.gatewayRuntimeReadyTimeoutMs`
    - runtime env fallback when config is unset: `OPENCLAW_DISCORD_RUNTIME_READY_TIMEOUT_MS`
    - runtime default: `30000` (30 seconds), max: `120000`

  </Accordion>

  <Accordion title="Permissions audit mismatches">
    `channels status --probe` permission checks only work for numeric channel IDs.

    If you use slug keys, runtime matching can still work, but probe cannot fully verify permissions.

  </Accordion>

  <Accordion title="DM and pairing issues">

    - DM disabled: `channels.discord.dm.enabled=false`
    - DM policy disabled: `channels.discord.dmPolicy="disabled"` (legacy: `channels.discord.dm.policy`)
    - awaiting pairing approval in `pairing` mode

  </Accordion>

  <Accordion title="Bot to bot loops">
    By default bot-authored messages are ignored.

    If you set `channels.discord.allowBots=true`, use strict mention and allowlist rules to avoid loop behavior.
    Prefer `channels.discord.allowBots="mentions"` to only accept bot messages that mention the bot.

```json5
{
  channels: {
    discord: {
      accounts: {
        mantis: {
          // Mantis listens to other bots only when they mention her.
          allowBots: "mentions",
        },
        molty: {
          // Molty listens to all bot-authored Discord messages.
          allowBots: true,
          mentionAliases: {
            // Lets Molty write "@Mantis" and send a real Discord mention.
            Mantis: "MANTIS_DISCORD_USER_ID",
          },
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="Voice STT drops with DecryptionFailed(...)">

    - keep OpenClaw current (`openclaw update`) so the Discord voice receive recovery logic is present
    - confirm `channels.discord.voice.daveEncryption=true` (default)
    - start from `channels.discord.voice.decryptionFailureTolerance=24` (upstream default) and tune only if needed
    - watch logs for:
      - `discord voice: DAVE decrypt failures detected`
      - `discord voice: repeated decrypt failures; attempting rejoin`
    - if failures continue after automatic rejoin, collect logs and compare against the upstream DAVE receive history in [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419) and [discord.js #11449](https://github.com/discordjs/discord.js/pull/11449)

  </Accordion>
</AccordionGroup>

## Configuration reference

Primary reference: [Configuration reference - Discord](/gateway/config-channels#discord).

<Accordion title="High-signal Discord fields">

- startup/auth: `enabled`, `token`, `accounts.*`, `allowBots`
- policy: `groupPolicy`, `dm.*`, `guilds.*`, `guilds.*.channels.*`
- command: `commands.native`, `commands.useAccessGroups`, `configWrites`, `slashCommand.*`
- event queue: `eventQueue.listenerTimeout` (listener budget), `eventQueue.maxQueueSize`, `eventQueue.maxConcurrency`
- gateway: `gatewayInfoTimeoutMs`, `gatewayReadyTimeoutMs`, `gatewayRuntimeReadyTimeoutMs`
- reply/history: `replyToMode`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- delivery: `textChunkLimit`, `chunkMode`, `maxLinesPerMessage`
- streaming: `streaming` (legacy alias: `streamMode`), `streaming.preview.toolProgress`, `draftChunk`, `blockStreaming`, `blockStreamingCoalesce`
- media/retry: `mediaMaxMb` (caps outbound Discord uploads, default `100MB`), `retry`
- actions: `actions.*`
- presence: `activity`, `status`, `activityType`, `activityUrl`
- UI: `ui.components.accentColor`
- features: `threadBindings`, top-level `bindings[]` (`type: "acp"`), `pluralkit`, `execApprovals`, `intents`, `agentComponents`, `heartbeat`, `responsePrefix`

</Accordion>

## Safety and operations

- Treat bot tokens as secrets (`DISCORD_BOT_TOKEN` preferred in supervised environments).
- Grant least-privilege Discord permissions.
- If command deploy/state is stale, restart gateway and re-check with `openclaw channels status --probe`.

## Related

<CardGroup cols={2}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Pair a Discord user to the gateway.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Group chat and allowlist behavior.
  </Card>
  <Card title="Channel routing" icon="route" href="/channels/channel-routing">
    Route inbound messages to agents.
  </Card>
  <Card title="Security" icon="shield" href="/gateway/security">
    Threat model and hardening.
  </Card>
  <Card title="Multi-agent routing" icon="sitemap" href="/concepts/multi-agent">
    Map guilds and channels to agents.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Native command behavior.
  </Card>
</CardGroup>
