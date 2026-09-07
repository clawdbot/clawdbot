---
summary: "DM policy, channel allowlists, mention gating, and action gates"
read_when:
  - Deciding who may DM the bot or talk to it in a channel
  - Debugging a channel where the bot stays silent
  - Bringing the app into a group DM
title: "Slack access control"
sidebarTitle: "Access control"
---

Who may reach OpenClaw through Slack, and which Slack actions it may take.

## Actions and gates

Slack actions are controlled by `channels.slack.actions.*`.

Available action groups in current Slack tooling:

| Group      | Default |
| ---------- | ------- |
| messages   | enabled |
| reactions  | enabled |
| pins       | enabled |
| memberInfo | enabled |
| emojiList  | enabled |

Current Slack message actions include `send`, `conversation-open`, `upload-file`, `download-file`, `read`, `edit`, `delete`, `pin`, `unpin`, `list-pins`, `member-info`, and `emoji-list`. `download-file` accepts Slack file IDs shown in inbound file placeholders and returns image previews for images or local file metadata for other file types.

Use `emoji-list` to discover workspace custom emoji and aliases:

```json
{ "action": "emoji-list", "channel": "slack", "limit": 25 }
```

Results are sorted by shortcode name. `limit` defaults to and cannot exceed 100:

```json
{
  "ok": true,
  "emojis": [
    { "name": "celebrate", "identifier": "celebrate", "aliasOf": "party" },
    { "name": "party", "identifier": "party" }
  ]
}
```

Use an entry's `identifier` directly as the `react` emoji; surrounding colons are optional. `channels.slack.actions.emojiList` controls discovery separately from the `reactions` gate, and the app needs the `emoji:read` scope.

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.slack.dmPolicy` controls DM access. `channels.slack.allowFrom` is the canonical DM allowlist.

    - `pairing` (default)
    - `allowlist`
    - `open` (requires `channels.slack.allowFrom` to include `"*"`)
    - `disabled`

    DM flags:

    - `dm.enabled` (default true)
    - `channels.slack.allowFrom`
    - `dm.allowFrom` (legacy)
    - `dm.groupEnabled` (group DMs default false)
    - `dm.groupChannels` (optional MPIM allowlist)

    <Note>
    `dm.groupEnabled` and `dm.groupChannels` only filter group DMs Slack already delivers to the app. They cannot make the app see a group DM it never joined. Convert the group DM to a private channel and invite the app, or have the app open a new MPDM with `conversations.open`. See [Group DMs (MPDMs) and bots](/channels/slack/access-control#group-dms-mpdms-and-bots).
    </Note>

    Multi-account precedence:

    - Omitted account `dmPolicy` and `groupPolicy` inherit the channel root. Explicit account policies win; with neither scope set, defaults remain `pairing` and `allowlist` respectively.
    - `userTokenReadOnly` also inherits the channel setting when omitted; its default remains `true`.
    - `channels.slack.accounts.default.allowFrom` applies only to the `default` account.
    - Named accounts inherit `channels.slack.allowFrom` when their own `allowFrom` is unset.
    - Named accounts do not inherit `channels.slack.accounts.default.allowFrom`.

    Legacy `channels.slack.dm.policy` and `channels.slack.dm.allowFrom` still read for compatibility. `openclaw doctor --fix` migrates them to `dmPolicy` and `allowFrom` when it can do so without changing access.

    Pairing in DMs uses `openclaw pairing approve slack <code>`.

  </Tab>

  <Tab title="Channel policy">
    `channels.slack.groupPolicy` controls channel handling:

    - `open`
    - `allowlist`
    - `disabled`

    Channel allowlist lives under `channels.slack.channels` and **must use stable Slack channel IDs** (for example `C12345678`) as config keys. Enterprise Grid org installs require `team:<team-id>:channel:<channel-id>` so policies cannot cross workspace boundaries.

    When invited into an allowed channel, OpenClaw posts one short introduction grounded in the channel name, purpose or topic, and available recent messages. Set `channels.slack.joinIntro: false` to disable these introductions; `channels.slack.accounts.<accountId>.joinIntro` overrides the channel-wide setting. Introductions are enabled by default and do not require a mention, but they never bypass channel access policy or run in direct messages.

    Without a `channels.slack` block, the Gateway does not auto-start Slack from `SLACK_*` environment variables. Once the block exists, those variables remain default-account credential fallbacks. Passing `--ambient-channels` opts into env-only auto-configuration; that path uses `groupPolicy="allowlist"` and logs a warning, even if `channels.defaults.groupPolicy` is set.

    Name/ID resolution:

    - channel allowlist entries and DM allowlist entries are resolved at startup when token access allows
    - unresolved channel-name entries are kept as configured but ignored for routing by default
    - inbound authorization and channel routing are ID-first by default; direct username/slug matching requires `channels.slack.dangerouslyAllowNameMatching: true`

    <Warning>
    Name-based keys (`#channel-name` or `channel-name`) do **not** match under `groupPolicy: "allowlist"`. The channel lookup is ID-first by default, so a name-based key will never route successfully and all messages in that channel will be silently blocked. This differs from `groupPolicy: "open"`, where the channel key is not required for routing and a name-based key appears to work.

    Always use the Slack channel ID as the key. To find it: right-click the channel in Slack → **Copy link** — the ID (`C...`) appears at the end of the URL.

    Correct:

    ```json5
    {
      channels: {
        slack: {
          groupPolicy: "allowlist",
          channels: {
            C12345678: { enabled: true, requireMention: true },
          },
        },
      },
    }
    ```

    Incorrect (silently blocked under `groupPolicy: "allowlist"`):

    ```json5
    {
      channels: {
        slack: {
          groupPolicy: "allowlist",
          channels: {
            "#eng-my-channel": { enabled: true, requireMention: true },
          },
        },
      },
    }
    ```
    </Warning>

  </Tab>

  <Tab title="Mentions and channel users">
    Channel messages are mention-gated by default.

    Mention sources:

    - explicit app mention (`<@botId>`)
    - Slack user-group mention (`<!subteam^S...>`) when the bot user is a member of that user group; requires `usergroups:read`
    - mention regex patterns (`agents.entries.*.groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
    - replies to the bot's own Slack message (`implicitMentions.replyToBot`)
    - follow-ups in threads where the bot participated (`implicitMentions.threadParticipation`)

    Per-channel controls (`channels.slack.channels.<id>`; names only via startup resolution or `dangerouslyAllowNameMatching`):

    - `requireMention`
    - `ignoreOtherMentions`
    - `replyToMode` (`off|first|all|batched`; overrides account/chat-type reply mode for this channel)
    - `users` (allowlist)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`
    - `toolsBySender` key format: `channel:`, `id:`, `e164:`, `username:`, `name:`, or `"*"` wildcard
      (legacy unprefixed keys still map to `id:` only)

    `ignoreOtherMentions` (default `false`) drops channel messages that mention another user or user group but not this bot. DMs and group DMs (MPIMs) are unaffected. The filter requires a resolved bot user ID from `auth.test`; if that identity is unavailable (for example a user-token-only identity), the gate fails open and messages pass through unchanged.

    `allowBots` is conservative for channels and private channels: bot-authored room messages are accepted only when the sending bot is explicitly listed in that room's `users` allowlist, or when at least one explicit Slack owner ID from `channels.slack.allowFrom` is currently a room member. Wildcards and display-name owner entries do not satisfy owner presence. Owner presence uses Slack `conversations.members`; make sure the app has the matching read scope for the room type (`channels:read` for public channels, `groups:read` for private channels). If the member lookup fails, OpenClaw drops the bot-authored room message.

    Accepted bot-authored Slack messages use shared [bot loop protection](/channels/bot-loop-protection). Configure `channels.defaults.botLoopProtection` for the default budget, then override with `channels.slack.botLoopProtection` or `channels.slack.channels.<id>.botLoopProtection` when a workspace or channel needs a different limit.

  </Tab>
</Tabs>

### Group DMs (MPDMs) and bots

Slack group DMs, also called multi-person direct messages or MPDMs, are not channels an app can join by being mentioned. Typing `@YourBot` in an existing group DM does not add the app or make the conversation visible to it.

- If the app was included when the group DM was created, Slack delivers `message.mpim` events and OpenClaw can respond when DM policy allows it.
- If the app is mentioned in an existing group DM where it is not a member, the bot token cannot see the conversation at all. Slack Web API calls such as `conversations.info`, `conversations.members`, and `conversations.history` fail with method- and context-dependent access or not-found errors, the MPDM does not appear in `conversations.list?types=mpim`, and no event is delivered to OpenClaw.
- OpenClaw wakes in MPDMs through delivered `message.mpim` events. `app_mention` events do not add the app to DM or MPDM contexts.
- `dm.groupEnabled` and `dm.groupChannels` only filter MPDMs Slack already delivers to the app. They cannot grant membership or visibility into a group DM the app was never part of. There is no OpenClaw config setting that makes the app see a group DM it never joined.

To bring the app into a group DM, use one of these Slack-supported paths:

1. Convert the group DM to a private channel, then ask a current member to invite the app with `/invite @YourBot`. An API-based invite must call `conversations.invite` with a token whose actor is already a member and allowed to invite the app.
2. Ask the app to use the message tool's `conversation-open` action with the human recipients in `userIds`. It calls `conversations.open` using the configured write identity; bot accounts need `mpim:write`. Slack includes the calling account automatically.

```json
{
  "action": "conversation-open",
  "channel": "slack",
  "userIds": ["U12345678", "U23456789"]
}
```

Provide 1-8 distinct member IDs, excluding the calling account. One recipient opens a 1:1 DM (requiring `im:write`); multiple recipients open or reuse a group DM with that exact audience. The result contains `channelId` and a routable `target`. Send the message with `action: "send"` and that exact `target`.

Use `accountId` to select a configured Slack account and `teamId` for an explicit workspace. The current workspace is inherited only for the same originating account; detached Enterprise operations require `teamId`. Opening is controlled by the `messages` action gate. It does not change DM/read policy, grant history access, or send a message by itself.
