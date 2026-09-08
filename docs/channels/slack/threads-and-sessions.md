---
summary: "Session keys, thread replies, reply tags, and Agent View DMs"
read_when:
  - Working out which OpenClaw session a Slack message lands on
  - Configuring reply threading or manual reply tags
  - Using Slack Agent View DMs
title: "Slack threads and sessions"
sidebarTitle: "Threads and sessions"
---

How Slack conversations map to OpenClaw sessions, and where replies land.

## Threading, sessions, and reply tags

- DMs route as `direct`; channels as `channel`; MPIMs as `group`.
- Slack route bindings accept raw peer IDs plus Slack target forms such as `channel:C12345678`, `user:U12345678`, and `<@U12345678>`.
- With default `session.dmScope=main`, ordinary Slack DMs collapse to the agent main session. Agent View roots and existing Assistant View threads remain isolated as `:thread:<threadTs>` sessions; see [Agent View DMs](/channels/slack/threads-and-sessions#agent-view-dms).
- Channel sessions: `agent:<agentId>:slack:channel:<channelId>`.
- Ordinary top-level channel messages stay on the per-channel session, even when `replyToMode` is non-`off`.
- Slack channel, MPIM, Agent View, and Assistant View thread replies use the parent Slack `thread_ts` for session suffixes (`:thread:<threadTs>`). Ordinary DM reply threads remain a UI affordance on the base DM session.
- OpenClaw seeds an eligible top-level channel root into `agent:<agentId>:slack:channel:<channelId>:thread:<rootTs>` when that root is expected to start a visible Slack thread, so the root and later thread replies share one OpenClaw session. This applies to `app_mention` events, explicit bot or configured mention-pattern matches, and `requireMention: false` channels with non-`off` `replyToMode`.
- `channels.slack.thread.historyScope` default is `thread`; `thread.inheritParent` default is `false`.
- `channels.slack.thread.initialHistoryLimit` controls how many existing thread messages are fetched when a new thread session starts (default `20`; set `0` to disable).
- `channels.slack.implicitMentions.replyToBot` controls whether a reply to the bot's own message bypasses mention gating (default `true`).
- `channels.slack.implicitMentions.threadParticipation` controls whether follow-ups in a thread where the bot has replied bypass mention gating (default `true`). Set it to `false` to require a new explicit mention in those follow-ups. `openclaw doctor --fix` migrates the former `channels.slack.thread.requireExplicitMention` key to this positive canonical flag.
- Account overrides live at `channels.slack.accounts.<id>.implicitMentions`; shared defaults live at `channels.defaults.implicitMentions`.

Reply threading controls:

- `channels.slack.channels.<id>.replyToMode`: per-channel override for Slack channel/private-channel messages
- `channels.slack.replyToMode`: `off|first|all|batched` (default `off`)
- `channels.slack.replyToModeByChatType`: per `direct|group|channel`
- legacy fallback for direct chats: `channels.slack.dm.replyToMode`

Manual reply tags are supported:

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

For explicit Slack thread replies from the `message` tool, set `replyBroadcast: true` with `action: "send"` and `threadId` or `replyTo` to ask Slack to also broadcast the thread reply to the parent channel. This maps to Slack's `chat.postMessage` `reply_broadcast` flag and is only supported for text or Block Kit sends, not media uploads.

When a `message` tool call runs inside a Slack thread and targets the same channel, OpenClaw normally inherits the current Slack thread according to the effective account, chat-type, or per-channel `replyToMode`. Automatic replies and same-channel `send` or `upload-file` calls use the same per-channel override. Set `topLevel: true` on `action: "send"` or `action: "upload-file"` to force a new parent-channel message instead. `threadId: null` is accepted as the same top-level opt-out.

<Note>
`replyToMode="off"` disables optional outbound Slack reply threading, including explicit `[[reply_to_*]]` tags. Agent View and Assistant View are Slack-managed threaded experiences, so their replies and status remain on the visible root regardless of this setting. It does not flatten other inbound Slack thread sessions. This differs from Telegram, where explicit tags are still honored in `"off"` mode. Slack threads hide messages from the channel while Telegram replies stay visible inline.
</Note>

### Agent View DMs

Slack Agent View (`features.agent_view`) is Slack's messaging experience for AI apps. Slack marks the app as an agent, and in the app's **Messages** tab each message typed in the top-level composer starts a new root that Slack threads on its own; follow-ups belong inside that root's thread. OpenClaw treats every root as a separate conversation:

- Each root gets a `:thread:<rootTs>` suffix on top of whatever base session `session.dmScope` selects, so roots stay isolated even under the default `main` scope. With `per-channel-peer` a root looks like `agent:main:slack:direct:U12345678:thread:1777244748.777299`; with `main` it looks like `agent:main:main:thread:1777244748.777299`.
- Follow-ups inside the root's thread stay on that root's session. A new top-level composer message starts a new session.
- Replies and thread status stay on the visible root regardless of `replyToMode`, because Slack owns the threading.
- Slack's active-view entities (`app_context`) reach the agent only as structured untrusted context in Slack's relevance order; a DM without `app_context` clears the entities for that turn rather than reusing stale ones.

Slack never states which experience an app uses, so OpenClaw records Agent View from the first of these signals it sees: an `app_context_changed` event, a DM that carries `app_context`, or the threadless `assistant.threads.setSuggestedPrompts` call OpenClaw makes when a member opens the **Messages** tab. Slack answers that call with `ok` or `internal_error` for Agent View apps and with `not_agent_app` for Assistant View apps, so both `ok` and `internal_error` count as evidence; transport failures stay inconclusive and are retried on the next open. A DM whose `thread_ts` equals its own `ts` is recognized as a Slack-managed root on its own. Until one of these signals has been seen, a plain DM root follows ordinary DM routing.

The marker is durable and keyed by account, workspace, and Slack app ID, so Agent View survives Gateway restarts once the app ID is known. Socket Mode reads the app ID from the app token at startup. HTTP mode learns it from the first signed event after startup and logs `slack app id <id> learned from signed event` once. Relay mode has no app ID source, so its marker lives only in the running process. Existing apps on `features.assistant_view` keep Assistant View threads instead; see [Additional manifest settings](/channels/slack/manifest-and-scopes#additional-manifest-settings).
