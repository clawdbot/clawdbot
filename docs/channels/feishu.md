---
summary: "Feishu bot overview, features, and configuration"
read_when:
  - You want to connect a Feishu/Lark bot
  - You are configuring the Feishu channel
title: Feishu
---

OpenClaw connects to Feishu/Lark (the all-in-one collaboration platform) through the official `@openclaw/feishu` plugin: bot DMs, group chats, streaming card replies, and Feishu doc/wiki/drive/Bitable tools.

**Status:** production-ready for bot DMs + group chats. WebSocket is the default event transport (no public URL needed); webhook mode is optional.

## Quick start

<Note>
Requires OpenClaw 2026.5.29 or above. Run `openclaw --version` to check. Upgrade with `openclaw update`.
</Note>

<Steps>
  <Step title="Run the channel setup wizard">
  ```bash
  openclaw channels login --channel feishu
  ```
  This installs the `@openclaw/feishu` plugin if it is missing, then walks through setup:

- **Manual setup**: paste an App ID and App Secret from Feishu Open Platform (`https://open.feishu.cn`) or Lark Developer (`https://open.larksuite.com`).
- **QR setup**: scan a QR code in the Feishu app to create a bot automatically. This flow locks DMs to your own account (`dmPolicy: "allowlist"` with your `open_id`).

The wizard also asks for the API domain (Feishu vs Lark) and the group policy. If the domestic Feishu mobile app does not react to the QR code, rerun setup and choose manual setup.
</Step>

  <Step title="After setup completes, restart the gateway to apply the changes">
  ```bash
  openclaw gateway restart
  ```
  </Step>
</Steps>

## Inbound durability

OpenClaw durably queues authenticated `im.message.receive_v1` and `drive.notice.comment_add_v1` envelopes before agent dispatch. Pending or retryable events survive a Gateway restart, remain serialized per chat or document, and use Feishu's event ID to suppress duplicate queue entries while the active or retained completion record exists.

If a WebSocket event cannot be persisted after bounded retries, OpenClaw closes that socket and forces a fresh authenticated connection instead of continuing past an uncommitted turn. Other Feishu event types, including reactions and VC meeting invitations, use their normal event paths and do not receive this durable-queue guarantee.

## Access control

### Direct messages

Configure `channels.feishu.dmPolicy` (default: `pairing`) to control who can DM the bot:

| Value         | Behavior                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `"pairing"`   | Unknown users receive a pairing code; approve via CLI                                                         |
| `"allowlist"` | Only users listed in `allowFrom` can chat                                                                     |
| `"open"`      | Public DMs; config validation requires `allowFrom` to include `"*"`. Non-wildcard entries still narrow access |

**Approve a pairing request:**

```bash
openclaw pairing list feishu
openclaw pairing approve feishu <CODE>
```

### Group chats

**Group policy** (`channels.feishu.groupPolicy`, default: `allowlist`):

| Value         | Behavior                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- |
| `"open"`      | Respond to all messages in groups                                                            |
| `"allowlist"` | Only respond to groups in `groupAllowFrom` or explicitly configured under `groups.<chat_id>` |
| `"disabled"`  | Disable all group messages; explicit `groups.<chat_id>` entries do not override this         |

**Mention requirement** (`channels.feishu.requireMention`):

- Default: @mention required, except when the effective group policy is `"open"`; there it defaults to `false` so messages that cannot carry mentions (for example images) still reach the agent.
- Set `true` or `false` explicitly to override; per-group override: `channels.feishu.groups.<chat_id>.requireMention`.
- Broadcast-only `@all` and `@_all` are not treated as bot mentions. A message that mentions both `@all` and the bot directly still counts as a bot mention.

## Group configuration examples

### Allow all groups, no @mention required

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open", // requireMention defaults to false under "open"
    },
  },
}
```

### Allow all groups, still require @mention

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      requireMention: true,
    },
  },
}
```

### Allow specific groups only

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      // Group IDs look like: oc_xxx
      groupAllowFrom: ["oc_xxx", "oc_yyy"],
    },
  },
}
```

In `allowlist` mode, you can also admit a group by adding an explicit `groups.<chat_id>` entry. Explicit entries do not override `groupPolicy: "disabled"`. Wildcard defaults under `groups.*` configure matching groups, but they do not admit groups by themselves.

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groups: {
        oc_xxx: {
          requireMention: false,
        },
      },
    },
  },
}
```

### Restrict senders within a group

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["oc_xxx"],
      groups: {
        oc_xxx: {
          // User open_ids look like: ou_xxx
          allowFrom: ["ou_user1", "ou_user2"],
        },
      },
    },
  },
}
```

`channels.feishu.groupSenderAllowFrom` sets the same sender allowlist for all groups; a per-group `allowFrom` takes precedence.

### Bot-authored messages

Feishu ignores messages authored by other bots by default. To allow bot-to-bot group conversations, grant the app the `im:message.group_at_msg.include_bot:readonly` and `im:message:readonly` scopes, then set `allowBots`:

```json5
{
  channels: {
    feishu: {
      allowBots: true,
    },
  },
}
```

Feishu only delivers bot-authored group events when another bot mentions this bot. Existing group policy, sender allowlists, and mention requirements still apply. OpenClaw drops self-authored messages, mentions the peer bot on every text or card reply, and applies the shared [`channels.defaults.botLoopProtection`](/channels/bot-loop-protection) guard.

<a id="get-groupuser-ids"></a>

## Get group/user IDs

### Group IDs (`chat_id`, format: `oc_xxx`)

Open the group in Feishu/Lark, click the menu icon in the top-right corner, and go to **Settings**. The group ID (`chat_id`) is listed on the settings page.

![Get Group ID](/images/feishu-get-group-id.png)

### User IDs (`open_id`, format: `ou_xxx`)

Start the gateway, send a DM to the bot, then check the logs:

```bash
openclaw logs --follow
```

Look for `open_id` in the log output. You can also check pending pairing requests:

```bash
openclaw pairing list feishu
```

## Common commands

| Command   | Description                 |
| --------- | --------------------------- |
| `/status` | Show bot status             |
| `/reset`  | Reset the current session   |
| `/model`  | Show or switch the AI model |

<Note>
Feishu/Lark does not support native slash-command menus, so send these as plain text messages.
</Note>

## Troubleshooting

### Bot does not respond in group chats

1. Ensure the bot is added to the group
2. Ensure you @mention the bot (required by default)
3. Verify `groupPolicy` is not `"disabled"`
4. Check logs: `openclaw logs --follow`

### Bot does not receive messages

1. Ensure the bot is published and approved in Feishu Open Platform / Lark Developer
2. Ensure event subscription includes `im.message.receive_v1`
3. For meeting invite auto-join, also subscribe to `vc.bot.meeting_invited_v1`
4. Ensure **persistent connection** (WebSocket) is selected
5. Ensure all required permission scopes are granted
6. Ensure the gateway is running: `openclaw gateway status`
7. Check logs: `openclaw logs --follow`

Subscribing to `vc.bot.meeting_invited_v1` only delivers the event. Automatic joins are
default-off. To enable them globally:

```json5
{
  channels: {
    feishu: {
      vcAutoJoin: true,
    },
  },
}
```

To enable only one account, omit the top-level switch and set the account override:

```json5
{
  channels: {
    feishu: {
      accounts: {
        meetings: { vcAutoJoin: true },
      },
    },
  },
}
```

Inviters still pass through the normal Feishu DM policy, allowlist/pairing, session, and reply
routing before the agent receives a join turn. Joining also requires an available Feishu VC join
tool configured for app identity with the
`vc:meeting.bot.join:write` scope. For example, the official
[`lark-cli` VC agent skill](https://github.com/larksuite/cli/tree/main/skills/lark-vc-agent)
provides `vc +meeting-join`.

<Warning>
The official `lark-cli` VC agent skill currently marks meeting-bot actions as a limited beta. If the tool returns `ErrNotInGray` or error code `20017`, the app or tenant has not been enabled for that beta; use the early-access guidance in the linked skill before troubleshooting ordinary scope grants.
</Warning>

### QR setup does not react in the Feishu mobile app

1. Rerun setup: `openclaw channels login --channel feishu`
2. Choose manual setup
3. In Feishu Open Platform, create a self-built app and copy its App ID and App Secret
4. Paste those credentials into the setup wizard

### App Secret leaked

1. Reset the App Secret in Feishu Open Platform / Lark Developer
2. Update the value in your config
3. Restart the gateway: `openclaw gateway restart`

## Advanced configuration

### Multiple accounts

```json5
{
  channels: {
    feishu: {
      defaultAccount: "main",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          name: "Primary bot",
          tts: {
            providers: {
              openai: { voice: "shimmer" },
            },
          },
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          name: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

`defaultAccount` controls which account is used when outbound APIs do not specify an `accountId`. Account entries inherit top-level settings; most top-level keys can be overridden per account.
`accounts.<id>.tts` uses the same shape as `messages.tts` and deep-merges over global TTS config, so multi-bot Feishu setups can keep shared provider credentials globally while overriding only voice, model, persona, or auto mode per account.

### Message limits

- `textChunkLimit` - outbound text chunk size (default: `4000` chars)
- `streaming.chunkMode` - `"length"` (default) splits at the limit; `"newline"` prefers newline boundaries
- `mediaMaxMb` - media upload/download limit (default: `30` MB)

### Streaming

Feishu/Lark supports streaming replies via interactive cards (Card Kit streaming API). When enabled, the bot updates the card in real time as it generates text.

```json5
{
  channels: {
    feishu: {
      streaming: {
        mode: "partial", // streaming card output (default: "partial")
        block: { enabled: true }, // opt into completed-block streaming
      },
    },
  },
}
```

Set `streaming.mode: "off"` to send the complete reply in one message; `renderMode: "raw"` (plain text instead of cards) also disables streaming cards. `streaming.block.enabled` is off by default; enable it only when you want completed assistant blocks flushed before the final reply. Legacy boolean `streaming` and the flat `blockStreaming` / `blockStreamingCoalesce` / `chunkMode` keys migrate to this nested shape via `openclaw doctor --fix`.

### Quota optimization

Reduce the number of Feishu/Lark API calls with two optional flags:

- `typingIndicator` (default `true`): set `false` to skip typing reaction calls
- `resolveSenderNames` (default `true`): set `false` to skip sender profile lookups

```json5
{
  channels: {
    feishu: {
      typingIndicator: false,
      resolveSenderNames: false,
    },
  },
}
```

### Group session scope and topic threads

`channels.feishu.groupSessionScope` (top-level, per account, or per group) controls how group messages map to agent sessions:

| Value                  | Session                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `"group"` (default)    | One session per group chat                                       |
| `"group_sender"`       | One session per (group + sender)                                 |
| `"group_topic"`        | One session per topic thread; falls back to the group session    |
| `"group_topic_sender"` | One session per (topic + sender); falls back to (group + sender) |

For the topic scopes, native Feishu/Lark topic groups use the event `thread_id` (`omt_*`) as the canonical topic session key. If a native topic starter event omits `thread_id`, OpenClaw hydrates it from Feishu before routing the turn. Normal group replies that OpenClaw turns into threads keep using the reply root message ID (`om_*`) so the first turn and follow-up turns stay in the same session.

Set `replyInThread: "enabled"` (top-level or per group) to make bot replies create or continue a Feishu topic thread instead of replying inline. `topicSessionMode` is the deprecated predecessor of `groupSessionScope`; prefer `groupSessionScope`.

### Feishu workspace tools

The plugin ships agent tools for Feishu documents, chats, knowledge base, cloud storage, permissions, and Bitable, plus matching skills (`feishu-doc`, `feishu-drive`, `feishu-perm`, `feishu-wiki`). Tool families are gated by `channels.feishu.tools`:

| Key             | Tools                                         | Default             |
| --------------- | --------------------------------------------- | ------------------- |
| `tools.doc`     | `feishu_doc` document operations              | `true`              |
| `tools.chat`    | `feishu_chat` chat info + member queries      | `true`              |
| `tools.wiki`    | `feishu_wiki` knowledge base (requires `doc`) | `true`              |
| `tools.drive`   | `feishu_drive` cloud storage                  | `true`              |
| `tools.perm`    | `feishu_perm` permission management           | `false` (sensitive) |
| `tools.scopes`  | `feishu_app_scopes` app scope diagnostics     | `true`              |
| `tools.bitable` | `feishu_bitable_*` Bitable/Base operations    | `true`              |

`tools.base` is an alias for `tools.bitable`; the explicit `bitable` value wins when both are set. Per-account gates live under `accounts.<id>.tools`.

Grant `drive:drive.metadata:readonly` for direct `feishu_drive info` lookups outside the root
directory, unless the app already has the full `drive:drive` scope. Without either scope, `info`
keeps the legacy root-directory lookup available through `drive:drive:readonly`.

### ACP sessions

Feishu/Lark supports ACP for DMs and group thread messages. Feishu/Lark ACP is text-command driven - there are no native slash-command menus, so use `/acp ...` messages directly in the conversation.

#### Persistent ACP binding

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
        channel: "feishu",
        accountId: "default",
        peer: { kind: "direct", id: "ou_1234567890" },
      },
    },
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "feishu",
        accountId: "default",
        peer: { kind: "group", id: "oc_group_chat:topic:om_topic_root" },
      },
      acp: { label: "codex-feishu-topic" },
    },
  ],
}
```

#### Spawn ACP from chat

In a Feishu/Lark DM or thread:

```text
/acp spawn codex --thread here
```

`--thread here` works for DMs and Feishu/Lark thread messages. Follow-up messages in the bound conversation route directly to that ACP session.

### Multi-agent routing

Use `bindings` to route Feishu/Lark DMs or groups to different agents.

```json5
{
  agents: {
    list: [
      { id: "main" },
      { id: "agent-a", workspace: "/home/user/agent-a" },
      { id: "agent-b", workspace: "/home/user/agent-b" },
    ],
  },
  bindings: [
    {
      agentId: "agent-a",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_xxx" },
      },
    },
    {
      agentId: "agent-b",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Routing fields:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"direct"` (DM) or `"group"` (group chat)
- `match.peer.id`: user Open ID (`ou_xxx`) or group ID (`oc_xxx`)

See [Get group/user IDs](#get-groupuser-ids) for lookup tips.

## Per-user agent isolation (Dynamic Agent Creation)

Enable `dynamicAgentCreation` to automatically create **isolated agent instances** for each DM user. Each user gets their own:

- Independent workspace directory
- Separate `USER.md` / `SOUL.md` / `MEMORY.md`
- Private conversation history
- Isolated skills and state

This is essential for public bots where you want each user to have their own private AI assistant experience.

<Note>
Dynamic bindings include the normalized Feishu `accountId`, so default and named accounts route each sender to the correct dynamic agent.

If a named account created an unscoped dynamic agent on an older release, that legacy agent still counts toward `maxAgents`. Confirm that it is not used by the default account before removing it, or temporarily increase `maxAgents`; OpenClaw cannot safely infer which account owns ambiguous legacy state.
</Note>

### Quick setup

```json5
{
  channels: {
    feishu: {
      dmPolicy: "open",
      allowFrom: ["*"],
      dynamicAgentCreation: {
        enabled: true,
        workspaceTemplate: "~/.openclaw/workspace-{agentId}",
        agentDirTemplate: "~/.openclaw/agents/{agentId}/agent",
      },
    },
  },
  session: {
    // Critical: makes each user's DM their "main session"
    // Automatically loads USER.md / SOUL.md / MEMORY.md
    // For stronger isolation, use "per-channel-peer" instead
    dmScope: "main",
  },
}
```

### How it works

When a new user sends their first DM:

1. The channel generates a unique `agentId`: `feishu-{user_open_id}` for the default account, or a bounded account-prefixed identity digest for a named account
2. Creates a new workspace at `workspaceTemplate` path
3. Registers the agent and creates a binding for this user
4. The workspace helper ensures bootstrap files (`AGENTS.md`, `SOUL.md`, `USER.md`, etc.) on first access
5. Routes all future messages from this user to their dedicated agent

### Configuration options

| Setting                                                  | Description                                | Default                              |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| `channels.feishu.dynamicAgentCreation.enabled`           | Enable automatic per-user agent creation   | `false`                              |
| `channels.feishu.dynamicAgentCreation.workspaceTemplate` | Path template for dynamic agent workspaces | `~/.openclaw/workspace-{agentId}`    |
| `channels.feishu.dynamicAgentCreation.agentDirTemplate`  | Agent directory name template              | `~/.openclaw/agents/{agentId}/agent` |
| `channels.feishu.dynamicAgentCreation.maxAgents`         | Maximum number of dynamic agents to create | unlimited                            |

Template variables:

- `{agentId}` - the generated agent ID (e.g., `feishu-ou_xxxxxx` or `feishu-support-<identity_digest>`)
- `{userId}` - the sender's Feishu open_id (e.g., `ou_xxxxxx`)

### Session scope

`session.dmScope` controls how direct messages are mapped to agent sessions. This is a **global setting** that affects all channels.

| Value                        | Behavior                                                            | Best for                                                           |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `"main"`                     | Each user's DM maps to their agent's main session                   | Single-user bots where you want `USER.md` / `SOUL.md` to auto-load |
| `"per-peer"`                 | Each peer gets a separate session (regardless of channel)           | Isolation keyed by sender identity only                            |
| `"per-channel-peer"`         | Each (channel + user) combination gets a separate session           | Public multi-user bots needing stronger isolation                  |
| `"per-account-channel-peer"` | Each (account + channel + user) combination gets a separate session | Multi-account bots needing account-level session isolation         |

**Tradeoff**: Using `"main"` enables automatic bootstrap file loading (`USER.md`, `SOUL.md`, `MEMORY.md`), but means all DMs across all channels share the same session key pattern. For public multi-user bots where isolation matters more than bootstrap auto-loading, consider `"per-channel-peer"` and manage bootstrap files manually.

<Note>
Use `"per-account-channel-peer"` when named Feishu accounts should keep separate sessions for the same sender. Dynamic bindings preserve the account scope.
</Note>

### Typical multi-user deployment

```json5
{
  channels: {
    feishu: {
      appId: "cli_xxx",
      appSecret: "xxx",
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      requireMention: true,
      dynamicAgentCreation: {
        enabled: true,
        workspaceTemplate: "~/.openclaw/workspace-{agentId}",
        agentDirTemplate: "~/.openclaw/agents/{agentId}/agent",
      },
    },
  },
  session: {
    // Choose dmScope based on your isolation needs:
    // "main" for bootstrap auto-loading, "per-channel-peer" for stronger isolation
    dmScope: "main",
  },
  bindings: [], // Empty - dynamic agents auto-bind
}
```

### Verification

Check gateway logs to confirm dynamic creation is working:

```text
feishu: creating dynamic agent "feishu-ou_xxxxxx" for user ou_xxxxxx
  workspace: /home/user/.openclaw/workspace-feishu-ou_xxxxxx
  agentDir: /home/user/.openclaw/agents/feishu-ou_xxxxxx/agent
```

List all created workspaces:

```bash
ls -la ~/.openclaw/workspace-*
```

### Notes

- **Workspace isolation**: Each user gets their own workspace directory and agent instance. Users cannot see each other's conversation history or files within the normal messaging flow.
- **Security boundary**: This is a messaging-context isolation mechanism, not a hostile co-tenant security boundary. The agent process and host environment are shared.
- **Config writes must stay enabled**: Dynamic agent creation writes agents and bindings into the config; it is skipped when `channels.feishu.configWrites` is `false` (default: enabled).
- **`bindings` should be empty**: Dynamic agents auto-register their own bindings
- **Upgrade path**: Existing manual bindings continue to work alongside dynamic agents
- **`session.dmScope` is global**: This affects all channels, not just Feishu

## Configuration reference

Full configuration: [Gateway configuration](/gateway/configuration)

| Setting                                                  | Description                                                                          | Default                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------ |
| `channels.feishu.enabled`                                | Enable/disable the channel                                                           | `true`                               |
| `channels.feishu.domain`                                 | API domain (`feishu`, `lark`, or an `https://` base URL)                             | `feishu`                             |
| `channels.feishu.connectionMode`                         | Event transport (`websocket` or `webhook`)                                           | `websocket`                          |
| `channels.feishu.defaultAccount`                         | Default account for outbound routing                                                 | `default`                            |
| `channels.feishu.verificationToken`                      | Required for webhook mode                                                            | -                                    |
| `channels.feishu.encryptKey`                             | Required for webhook mode                                                            | -                                    |
| `channels.feishu.webhookPath`                            | Webhook route path                                                                   | `/feishu/events`                     |
| `channels.feishu.webhookHost`                            | Webhook bind host                                                                    | `127.0.0.1`                          |
| `channels.feishu.webhookPort`                            | Webhook bind port                                                                    | `3000`                               |
| `channels.feishu.accounts.<id>.appId`                    | App ID                                                                               | -                                    |
| `channels.feishu.accounts.<id>.appSecret`                | App Secret                                                                           | -                                    |
| `channels.feishu.accounts.<id>.domain`                   | Per-account domain override                                                          | `feishu`                             |
| `channels.feishu.accounts.<id>.tts`                      | Per-account TTS override                                                             | `messages.tts`                       |
| `channels.feishu.dmPolicy`                               | DM policy (`pairing`, `allowlist`, `open`)                                           | `pairing`                            |
| `channels.feishu.allowFrom`                              | DM allowlist (open_id list)                                                          | -                                    |
| `channels.feishu.groupPolicy`                            | Group policy (`open`, `allowlist`, `disabled`)                                       | `allowlist`                          |
| `channels.feishu.groupAllowFrom`                         | Group allowlist                                                                      | -                                    |
| `channels.feishu.groupSenderAllowFrom`                   | Sender allowlist applied to all groups                                               | -                                    |
| `channels.feishu.requireMention`                         | Require @mention in groups                                                           | `true` (`false` when policy `open`)  |
| `channels.feishu.allowBots`                              | Accept other bots that mention this bot, with bot-loop protection                    | `false`                              |
| `channels.feishu.groups.<chat_id>.requireMention`        | Per-group @mention override; explicit IDs also admit the group in allowlist mode     | inherited                            |
| `channels.feishu.groups.<chat_id>.enabled`               | Enable/disable a specific group                                                      | `true`                               |
| `channels.feishu.groups.<chat_id>.allowFrom`             | Per-group sender allowlist (overrides `groupSenderAllowFrom`)                        | -                                    |
| `channels.feishu.groupSessionScope`                      | Group session mapping (`group`, `group_sender`, `group_topic`, `group_topic_sender`) | `group`                              |
| `channels.feishu.replyInThread`                          | Bot replies create/continue topic threads (`disabled`, `enabled`)                    | `disabled`                           |
| `channels.feishu.reactionNotifications`                  | Inbound reaction events (`off`, `own`, `all`)                                        | `own`                                |
| `channels.feishu.vcAutoJoin`                             | Join invited VC meetings after normal DM authorization                               | `false`                              |
| `channels.feishu.dynamicAgentCreation.enabled`           | Enable automatic per-user agent creation                                             | `false`                              |
| `channels.feishu.dynamicAgentCreation.workspaceTemplate` | Path template for dynamic agent workspaces                                           | `~/.openclaw/workspace-{agentId}`    |
| `channels.feishu.dynamicAgentCreation.agentDirTemplate`  | Agent directory name template                                                        | `~/.openclaw/agents/{agentId}/agent` |
| `channels.feishu.dynamicAgentCreation.maxAgents`         | Maximum number of dynamic agents to create                                           | unlimited                            |
| `channels.feishu.textChunkLimit`                         | Message chunk size                                                                   | `4000`                               |
| `channels.feishu.streaming.chunkMode`                    | Chunk splitting (`length` or `newline`)                                              | `length`                             |
| `channels.feishu.mediaMaxMb`                             | Media size limit                                                                     | `30`                                 |
| `channels.feishu.renderMode`                             | Reply rendering (`auto`, `raw`, `card`)                                              | `auto`                               |
| `channels.feishu.streaming.mode`                         | Streaming card output (`partial` or `off`)                                           | `partial`                            |
| `channels.feishu.streaming.block.enabled`                | Completed-block reply streaming                                                      | `false`                              |
| `channels.feishu.typingIndicator`                        | Send typing reactions                                                                | `true`                               |
| `channels.feishu.resolveSenderNames`                     | Resolve sender display names                                                         | `true`                               |
| `channels.feishu.configWrites`                           | Allow channel-initiated config writes (needed by dynamic agents)                     | `true`                               |
| `channels.feishu.tools.doc`                              | Enable document tools                                                                | `true`                               |
| `channels.feishu.tools.chat`                             | Enable chat info tools                                                               | `true`                               |
| `channels.feishu.tools.wiki`                             | Enable knowledge base tools (requires `doc`)                                         | `true`                               |
| `channels.feishu.tools.drive`                            | Enable cloud storage tools                                                           | `true`                               |
| `channels.feishu.tools.perm`                             | Enable permission management tools                                                   | `false`                              |
| `channels.feishu.tools.scopes`                           | Enable app scopes diagnostic tool                                                    | `true`                               |
| `channels.feishu.tools.bitable`                          | Enable Bitable/Base tools                                                            | `true`                               |
| `channels.feishu.tools.base`                             | Alias for `channels.feishu.tools.bitable`; explicit `bitable` wins when both set     | `true`                               |
| `channels.feishu.accounts.<id>.tools.bitable`            | Per-account Bitable/Base tool gate                                                   | inherited                            |
| `channels.feishu.accounts.<id>.tools.base`               | Per-account alias for `tools.bitable`                                                | inherited                            |

## Supported message types

### Receive

- ✅ Text
- ✅ Rich text (post)
- ✅ Images
- ✅ Files
- ✅ Audio
- ✅ Video/media
- ✅ Stickers

Inbound Feishu/Lark audio messages are normalized as media placeholders instead
of raw `file_key` JSON. When `tools.media.audio` is configured, OpenClaw
downloads the voice-note resource and runs shared audio transcription before the
agent turn, so the agent receives the spoken transcript. If Feishu includes
transcript text directly in the audio payload, that text is used without another
ASR call. Without an audio transcription provider, the agent still receives a
`<media:audio>` placeholder plus the saved attachment, not the raw Feishu
resource payload.

### Send

- ✅ Text
- ✅ Images
- ✅ Files
- ✅ Audio
- ✅ Video/media
- ✅ Interactive cards (including streaming updates)
- ⚠️ Rich text (post-style formatting; doesn't support full Feishu/Lark authoring capabilities)

Native Feishu/Lark audio bubbles use the Feishu `audio` message type and require
Ogg/Opus upload media (`file_type: "opus"`). Existing `.opus` and `.ogg` media
is sent directly as native audio. MP3/WAV/M4A and other likely audio formats are
transcoded to 48kHz Ogg/Opus with `ffmpeg` only when the reply requests voice
delivery (`audioAsVoice` / message tool `asVoice`, including TTS voice-note
replies). Ordinary MP3 attachments stay regular files. If `ffmpeg` is missing or
conversion fails, OpenClaw falls back to a file attachment and logs the reason.

### Threads and replies

- ✅ Inline replies
- ✅ Thread replies
- ✅ Media replies stay thread-aware when replying to a thread message

Topic-group session routing is covered under
[Group session scope and topic threads](#group-session-scope-and-topic-threads).

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
