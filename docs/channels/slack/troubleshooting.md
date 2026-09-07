---
summary: "Fixes for silent channels, ignored DMs, and dead transports"
read_when:
  - The bot does not reply in a Slack channel or DM
  - Socket Mode or HTTP mode is not receiving events
  - Slash commands do not fire
title: "Slack troubleshooting"
sidebarTitle: "Troubleshooting"
---

Symptom-first checks for a Slack account that is not behaving.

## Troubleshooting

<AccordionGroup>
  <Accordion title="No replies in channels">
    Check, in order:

    - `groupPolicy`
    - channel allowlist (`channels.slack.channels`) — **keys must be channel IDs** (`C12345678`) or workspace-qualified channel targets (`team:<team-id>:channel:<channel-id>`), not names (`#channel-name`). Name-based keys silently fail under `groupPolicy: "allowlist"` because channel routing is ID-first by default. To find an ID: right-click the channel in Slack → **Copy link** — the `C...` value at the end of the URL is the channel ID.
    - `requireMention`
    - per-channel `users` allowlist
    - `messages.groupChat.visibleReplies`: normal group/channel requests default to `"automatic"`. If you opted into `"message_tool"` and logs show assistant text with no `message(action=send)` call, the model missed the visible message-tool path. Final text stays private in this mode; inspect the gateway verbose log for suppressed payload metadata, or set it to `"automatic"` if you want every normal assistant final reply posted through the legacy path.
    - `messages.groupChat.unmentionedInbound`: if it is `"room_event"`, unmentioned allowed channel chatter is ambient context and stays silent unless the agent calls the `message` tool. See [Ambient room events](/channels/ambient-room-events).

```json5
{
  messages: {
    groupChat: {
      visibleReplies: "automatic",
    },
  },
}
```

    Useful commands:

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

    When preparation rejects an inbound event, the info-level log records
    `Slack inbound event rejected during preparation` with a reason and routing IDs.
    Records describe attempts: a rejected `message` event can still be followed by a
    successful `app_mention` event for the same post. Self-message loop prevention stays quiet.

  </Accordion>

  <Accordion title="DM messages ignored">
    Check:

    - `channels.slack.dm.enabled`
    - `channels.slack.dmPolicy` (or legacy `channels.slack.dm.policy`)
    - pairing approvals / allowlist entries (`dmPolicy: "open"` still requires `channels.slack.allowFrom: ["*"]`)
    - group DMs use MPIM handling; enable `channels.slack.dm.groupEnabled` and, if configured, include the MPIM in `channels.slack.dm.groupChannels`
    - Slack Assistant DM events: verbose logs mentioning `drop message_changed`
      usually mean Slack sent an edited Assistant-thread event without a
      recoverable human sender in message metadata

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Agent View DMs share one session">
    Symptom: every top-level message in the app's **Messages** tab lands on the same session (the main session, or one `slack:direct:<userId>` session) instead of its own `:thread:<rootTs>` session, even though Slack shows each message as its own thread.

    Check, in order:

    - The manifest uses `features.agent_view` with `assistant:write` and subscribes to `app_context_changed`. Apps still on `features.assistant_view` get Assistant View threads instead, and Slack cannot move an app back once it switches to Agent View.
    - OpenClaw has seen an Agent View signal since the app was installed: open the app's **Messages** tab once, or send a DM from the Agent View composer. In verbose logs, `slack suggested prompts update failed for channel D...: internal_error` on a Messages-tab open is expected for an Agent View app and counts as evidence.
    - In HTTP mode, the Gateway has received at least one signed event since it started; `slack app id <id> learned from signed event` in the logs confirms the durable marker can be read. Socket Mode reads the app ID from the app token at startup, so no event is needed.
    - `Slack Agent View state failed to open`, `persist`, or `load` warnings mean the durable marker could not be stored or read. A signal already detected in the running process still applies. After a restart, Agent View resumes when OpenClaw successfully reads a stored marker or detects a new signal.

    See [Agent View DMs](/channels/slack/threads-and-sessions#agent-view-dms).

  </Accordion>

  <Accordion title="Socket mode not connecting">
    Validate bot + app tokens and Socket Mode enablement in Slack app settings.
    The App-Level Token needs `connections:write`, and the Bot User OAuth Token
    bot token must belong to the same Slack app/workspace as the app token.

    If `openclaw channels status --probe --json` shows `botTokenStatus` or
    `appTokenStatus: "configured_unavailable"`, the Slack account is
    configured but the current runtime could not resolve the SecretRef-backed
    value.

    Logs such as `slack socket mode failed to start; retry ...` are recoverable
    start failures. Missing scopes, revoked tokens, and invalid auth fail fast
    instead. A `slack token mismatch ...` log means the bot token and app token
    appear to belong to different Slack apps; fix the Slack app credentials.

  </Accordion>

  <Accordion title="HTTP mode not receiving events">
    Validate:

    - signing secret
    - webhook path
    - Slack Request URLs (Events + Interactivity + Slash Commands)
    - unique `webhookPath` per HTTP account
    - the public URL terminates TLS and forwards requests to the Gateway path
    - the Slack app `request_url` path exactly matches `channels.slack.webhookPath` (default `/slack/events`)

    If `signingSecretStatus: "configured_unavailable"` appears in account
    snapshots, the HTTP account is configured but the current runtime could not
    resolve the SecretRef-backed signing secret.

    A repeated `slack: webhook path ... already registered` log means two HTTP
    accounts are using the same `webhookPath`; give each account a distinct path.

  </Accordion>

  <Accordion title="Native/slash commands not firing">
    Verify whether you intended:

    - native command mode (`channels.slack.commands.native: true`) with matching slash commands registered in Slack
    - or single slash command mode (`channels.slack.slashCommand.enabled: true`)

    Slack does not create or remove slash commands automatically. `commands.native: "auto"` does not enable Slack native commands; use `true` and create the matching commands in the Slack app. In HTTP mode, every Slack slash command must include the Gateway URL. In Socket Mode, command payloads arrive over the websocket and Slack ignores `slash_commands[].url`.

    Also check `commands.allowFrom` (when configured), DM authorization,
    channel allowlists, and per-channel `users` allowlists. Access-group
    entries in channel allowlists are resolved automatically. Slack returns
    ephemeral errors for
    blocked slash-command senders, including:

    - `This channel is not allowed.`
    - `You are not authorized to use this command here.`

  </Accordion>
</AccordionGroup>
