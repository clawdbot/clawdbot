---
summary: "System events, interactions, and optional presence polling"
read_when:
  - Working out which Slack events become system events
  - Enabling presence wakes for Slack participants
  - Handling Block Kit actions or shortcuts
title: "Slack events and operations"
sidebarTitle: "Events and operations"
---

Which Slack events OpenClaw observes, and what it does with them.

## Events and operational behavior

- Message edits/deletes are mapped into system events.
- Thread broadcasts ("Also send to channel" thread replies) are processed as normal user messages.
- Reaction add/remove events are mapped into system events.
- Member join/leave, channel created/renamed, and pin add/remove events are mapped into system events.
- When the bot itself joins an allowed channel, it posts one introduction grounded in the channel name, purpose or topic, and available recent messages. Introductions are enabled by default, never run in direct messages, and can be disabled with `channels.slack.joinIntro: false` or overridden per account with `channels.slack.accounts.<accountId>.joinIntro`. See [group join introductions](/channels#group-join-introductions) for the history limits, once-per-room behavior, and untrusted-content handling.
- Optional presence polling can map an observed human participant's `away` to `active` transition into the participant's most recently active eligible Slack session. The default is off.
- `channel_id_changed` can migrate channel config keys when `configWrites` is enabled.
- Channel topic/purpose metadata is treated as untrusted context and can be injected into routing context.
- Agent View `app_context` entities are validated in Slack relevance order and exposed only as structured untrusted context; an omitted context clears the turn rather than reusing stale entities.
- Thread starter and initial thread-history context seeding are filtered by configured sender allowlists when applicable.
- Dedicated Web API reads used for probes, scope discovery, conversation classification, and delivery reconciliation have a 30-second deadline per request attempt. Transient failures can still retry, so the full operation may take longer. Shared Bolt and mutation-capable clients do not receive this default deadline because Slack may commit a mutation before a late response reaches OpenClaw.
- Block actions, shortcuts, and modal interactions emit structured `Slack interaction: ...` system events with rich payload fields:
  - block actions: selected values, labels, picker values, and `workflow_*` metadata
  - global shortcuts: callback and actor metadata, routed to the actor's direct session
  - message shortcuts: callback, actor, channel, thread, and selected-message context
  - modal `view_submission` and `view_closed` events with routed channel metadata and form inputs

Define global or message shortcuts in your Slack app configuration and use any non-empty callback ID. OpenClaw acknowledges matching shortcut payloads, applies the same DM/channel sender policy as other Slack interactions, and queues the sanitized event for the routed agent session. Trigger IDs and response URLs are redacted from agent context.

### Presence events

Slack does not send presence changes through the Events API or Socket Mode. OpenClaw can instead poll [`users.getPresence`](https://docs.slack.dev/reference/methods/users.getPresence/) for human participants whose messages passed normal Slack access and routing checks.

```json5
{
  channels: {
    slack: {
      presenceEvents: {
        mode: "auto",
        prompt: "Do not send a greeting. Stay silent.",
      },
      channels: {
        C0123456789: { presenceEvents: { mode: "on" } },
        C0987654321: { presenceEvents: { mode: "off" } },
      },
    },
  },
}
```

- `off` (default): no presence timer or Slack API calls.
- `auto`: monitor DMs, MPIMs, and Slack threads active in the last 24 hours with at most 8 observed human participants. Top-level channel sessions are excluded.
- `on`: monitor the same conversations without the participant cap and include top-level channel sessions. Use a per-channel override to force or suppress one channel.

OpenClaw polls at most 45 unique workspace-user pairs per minute per Slack account, seeds the first result without waking the agent, and only wakes on an observed `away` to `active` transition. A durable 8-hour cooldown applies per Slack account, workspace, and user, even if that person participates in several threads. The event routes only to that person's most recently active eligible conversation and tells the agent to consult memory/wiki and known timezone context before deciding whether to send one short greeting. The agent may stay silent.

The event includes `observed_away_at_ms`, `observed_active_at_ms`, and `observed_away_duration_ms`. The duration is the elapsed time between the first sampled `away` state in the current monitor run and the later sampled `active` state. It is not exact time away because presence can change between polls, and the observation starts fresh after the monitor restarts or the target expires. The event records what Slack reported, not whether the person was at their keyboard; Slack can mark someone away automatically or manually, and `users.getPresence` does not distinguish those cases for another user.

`presenceEvents.prompt` replaces the default greeting guidance after the event facts. The account-level value applies by default, and `channels.<channel-id>.presenceEvents.prompt` can override it for one channel. The custom value is included verbatim and is limited to 20,000 characters, matching the default per-file `AGENTS.md` bootstrap limit. Set it to an empty string to omit event-specific guidance and let workspace instructions such as `AGENTS.md` decide how to handle the event. The presence facts are always included.

The bot token needs `users:read`, which is already included in the recommended manifest. Enterprise Grid org-wide installs create a workspace-scoped polling client only after an authorized event identifies that workspace; presence state, cooldowns, and delivery targets remain partitioned by workspace.
