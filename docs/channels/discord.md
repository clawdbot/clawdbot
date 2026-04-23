---
summary: "Discord bot support status, capabilities, and configuration"
read_when:
  - Working on Discord channel features
title: "Discord"
---

# Discord (Bot API)

Status: ready for DMs and guild channels via the official Discord gateway.

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
openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN --dry-run
openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN
openclaw config set channels.discord.enabled true --strict-json
openclaw gateway
```

    If OpenClaw is already running as a background service, restart it via the OpenClaw Mac app or by stopping and restarting the `openclaw gateway run` process.

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

        Plaintext `token` values are supported. SecretRef values are also supported for `channels.discord.token` across env/file/exec providers. See [Secrets Management](/gateway/secrets).

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
- By default (`session.dmScope=main`), direct chats share the agent main session (`agent:main:main`).
- Guild channels are isolated session keys (`agent:<agentId>:discord:channel:<channelId>`).
- Group DMs are ignored by default (`channels.discord.dm.groupEnabled=false`).
- Native slash commands run in isolated command sessions (`agent:<agentId>:discord:slash:<userId>`), while still carrying `CommandTargetSessionKey` to the routed conversation session.

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

The `/model` and `/models` slash commands open an interactive model picker with provider and model dropdowns plus a Submit step. Unless `commands.modelsWrite=false`, `/models add` also supports adding a new provider/model entry from chat, and newly added models show up without restarting the gateway. The picker reply is ephemeral and only the invoking user can use it.

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
    `channels.discord.dmPolicy` controls DM access (legacy: `channels.discord.dm.policy`):

    - `pairing` (default)
    - `allowlist`
    - `open` (requires `channels.discord.allowFrom` to include `"*"`; legacy: `channels.discord.dm.allowFrom`)
    - `disabled`

    If DM policy is not open, unknown users are blocked (or prompted for pairing in `pairing` mode).

    Multi-account precedence:

    - `channels.discord.accounts.default.allowFrom` applies only to the `default` account.
    - Named accounts inherit `channels.discord.allowFrom` when their own `allowFrom` is unset.
    - Named accounts do not inherit `channels.discord.accounts.default.allowFrom`.

    DM target format for delivery:

    - `user:<id>`
    - `<@id>` mention

    Bare numeric IDs are ambiguous and rejected unless an explicit user/channel target kind is provided.

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

## Developer Portal setup

<AccordionGroup>
  <Accordion title="Create app and bot">

    1. Discord Developer Portal -> **Applications** -> **New Application**
    2. **Bot** -> **Add Bot**
    3. Copy bot token

  </Accordion>

  <Accordion title="Privileged intents">
    In **Bot -> Privileged Gateway Intents**, enable:

    - Message Content Intent
    - Server Members Intent (recommended)

    Presence intent is optional and only required if you want to receive presence updates. Setting bot presence (`setPresence`) does not require enabling presence updates for members.

  </Accordion>

  <Accordion title="OAuth scopes and baseline permissions">
    OAuth URL generator:

    - scopes: `bot`, `applications.commands`

    Typical baseline permissions:

    **General Permissions**
      - View Channels
    **Text Permissions**
      - Send Messages
      - Read Message History
      - Embed Links
      - Attach Files
      - Add Reactions (optional)

    This is the baseline set for normal text channels. If you plan to post in Discord threads, including forum or media channel workflows that create or continue a thread, also enable **Send Messages in Threads**.
    Avoid `Administrator` unless explicitly needed.

  </Accordion>

  <Accordion title="Copy IDs">
    Enable Discord Developer Mode, then copy:

    - server ID
    - channel ID
    - user ID

    Prefer numeric IDs in OpenClaw config for reliable audits and probes.

  </Accordion>
</AccordionGroup>

## Native commands and command auth

- `commands.native` defaults to `"auto"` and is enabled for Discord.
- Per-channel override: `channels.discord.commands.native`.
- `commands.native=false` explicitly clears previously registered Discord native commands.
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
    OpenClaw can stream draft replies by sending a temporary message and editing it as text arrives. `channels.discord.streaming` takes `off` (default) | `partial` | `block` | `progress`. `progress` maps to `partial` on Discord; `streamMode` is a legacy alias and is auto-migrated.

    Default stays `off` because Discord preview edits hit rate limits quickly when multiple bots or gateways share an account.

```json5
{
  channels: {
    discord: {
      streaming: "block",
      draftChunk: {
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
      },
    },
  },
}
```

    - `partial` edits a single preview message as tokens arrive.
    - `block` emits draft-sized chunks (use `draftChunk` to tune size and breakpoints, clamped to `textChunkLimit`).
    - Media, error, and explicit-reply finals cancel pending preview edits.
    - `streaming.preview.toolProgress` (default `true`) controls whether tool/progress updates reuse the preview message.

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
        spawnSubagentSessions: false, // opt-in
      },
    },
  },
}
```

    Notes:

    - `session.threadBindings.*` sets global defaults.
    - `channels.discord.threadBindings.*` overrides Discord behavior.
    - `spawnSubagentSessions` must be true to auto-create/bind threads for `sessions_spawn({ thread: true })`.
    - `spawnAcpSessions` must be true to auto-create/bind threads for ACP (`/acp spawn ... --thread ...` or `sessions_spawn({ runtime: "acp", thread: true })`).
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
    - `spawnAcpSessions` is only required when OpenClaw needs to create/bind a child thread via `--thread auto|here`.

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

    When `target` is `channel` or `both`, the approval prompt is visible in the channel. Only resolved approvers can use the buttons; other users receive an ephemeral denial. Approval prompts include the command text, so only enable channel delivery in trusted channels. If the channel ID cannot be derived from the session key, OpenClaw falls back to DM delivery.

    Discord also renders the shared approval buttons used by other chat channels. The native Discord adapter mainly adds approver DM routing and channel fanout.
    When those buttons are present, they are the primary approval UX; OpenClaw
    should only include a manual `/approve` command when the tool result says
    chat approvals are unavailable or manual approval is the only path.

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

Requirements:

- Enable native commands (`commands.native` or `channels.discord.commands.native`).
- Configure `channels.discord.voice`.
- The bot needs Connect + Speak permissions in the target voice channel.

Use `/vc join|leave|status` to control sessions. The command uses the account default agent and follows the same allowlist and group policy rules as other Discord commands.

Auto-join example:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        autoJoin: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
          },
        ],
        daveEncryption: true,
        decryptionFailureTolerance: 24,
        tts: {
          provider: "openai",
          openai: { voice: "alloy" },
        },
      },
    },
  },
}
```

Notes:

- `voice.tts` overrides `messages.tts` for voice playback only.
- Voice transcript turns derive owner status from Discord `allowFrom` (or `dm.allowFrom`); non-owner speakers cannot access owner-only tools (for example `gateway` and `cron`).
- Voice is enabled by default; set `channels.discord.voice.enabled=false` to disable it.
- `voice.daveEncryption` and `voice.decryptionFailureTolerance` pass through to `@discordjs/voice` join options.
- `@discordjs/voice` defaults are `daveEncryption=true` and `decryptionFailureTolerance=24` if unset.
- OpenClaw also watches receive decrypt failures and auto-recovers by leaving/rejoining the voice channel after repeated failures in a short window.
- If receive logs repeatedly show `DecryptionFailed(UnencryptedWhenPassthroughDisabled)`, this may be the upstream `@discordjs/voice` receive bug tracked in [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419).

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

  <Accordion title="Long-running handlers time out or duplicate replies">

    Typical logs:

    - `Listener DiscordMessageListener timed out after 30000ms for event MESSAGE_CREATE`
    - `Slow listener detected ...`
    - `discord inbound worker timed out after ...`

    Listener budget knob:

    - single-account: `channels.discord.eventQueue.listenerTimeout`
    - multi-account: `channels.discord.accounts.<accountId>.eventQueue.listenerTimeout`

    Worker run timeout knob:

    - single-account: `channels.discord.inboundWorker.runTimeoutMs`
    - multi-account: `channels.discord.accounts.<accountId>.inboundWorker.runTimeoutMs`
    - default: `1800000` (30 minutes); set `0` to disable

    Recommended baseline:

```json5
{
  channels: {
    discord: {
      accounts: {
        default: {
          eventQueue: {
            listenerTimeout: 120000,
          },
          inboundWorker: {
            runTimeoutMs: 1800000,
          },
        },
      },
    },
  },
}
```

    Use `eventQueue.listenerTimeout` for slow listener setup and `inboundWorker.runTimeoutMs`
    only if you want a separate safety valve for queued agent turns.

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

  </Accordion>

  <Accordion title="Voice STT drops with DecryptionFailed(...)">

    - keep OpenClaw current (`openclaw update`) so the Discord voice receive recovery logic is present
    - confirm `channels.discord.voice.daveEncryption=true` (default)
    - start from `channels.discord.voice.decryptionFailureTolerance=24` (upstream default) and tune only if needed
    - watch logs for:
      - `discord voice: DAVE decrypt failures detected`
      - `discord voice: repeated decrypt failures; attempting rejoin`
    - if failures continue after automatic rejoin, collect logs and compare against [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419)

  </Accordion>
</AccordionGroup>

## Configuration reference pointers

Primary reference:

- [Configuration reference - Discord](/gateway/configuration-reference#discord)

High-signal Discord fields:

- startup/auth: `enabled`, `token`, `accounts.*`, `allowBots`
- policy: `groupPolicy`, `dm.*`, `guilds.*`, `guilds.*.channels.*`
- command: `commands.native`, `commands.useAccessGroups`, `configWrites`, `slashCommand.*`
- event queue: `eventQueue.listenerTimeout` (listener budget), `eventQueue.maxQueueSize`, `eventQueue.maxConcurrency`
- inbound worker: `inboundWorker.runTimeoutMs`
- reply/history: `replyToMode`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- delivery: `textChunkLimit`, `chunkMode`, `maxLinesPerMessage`
- streaming: `streaming` (legacy alias: `streamMode`), `streaming.preview.toolProgress`, `draftChunk`, `blockStreaming`, `blockStreamingCoalesce`
- media/retry: `mediaMaxMb`, `retry`
  - `mediaMaxMb` caps outbound Discord uploads (default: `100MB`)
- actions: `actions.*`
- presence: `activity`, `status`, `activityType`, `activityUrl`
- UI: `ui.components.accentColor`
- features: `threadBindings`, top-level `bindings[]` (`type: "acp"`), `pluralkit`, `execApprovals`, `intents`, `agentComponents`, `heartbeat`, `responsePrefix`

## Safety and operations

- Treat bot tokens as secrets (`DISCORD_BOT_TOKEN` preferred in supervised environments).
- Grant least-privilege Discord permissions.
- If command deploy/state is stale, restart gateway and re-check with `openclaw channels status --probe`.

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
- [Security](/gateway/security)
- [Multi-agent routing](/concepts/multi-agent)
- [Troubleshooting](/channels/troubleshooting)
- [Slash commands](/tools/slash-commands)
