---
summary: "How OpenClaw manages conversation sessions"
read_when:
  - You want to understand session routing and isolation
  - You want to configure DM scope for multi-user setups
  - You are debugging daily or idle session resets
title: "Session management"
---

OpenClaw organizes conversations into **sessions**. Each message is routed to a
session based on where it came from -- DMs, group chats, cron jobs, etc.

## How messages are routed

| Source          | Behavior                  |
| --------------- | ------------------------- |
| Direct messages | Shared session by default |
| Group chats     | Isolated per group        |
| Rooms/channels  | Isolated per room         |
| Cron jobs       | Fresh session per run     |
| Webhooks        | Isolated per hook         |

## DM isolation

By default, all DMs share one session for continuity. This is fine for
single-user setups.

<Warning>
If multiple people can message your agent, enable DM isolation. Without it, all
users share the same conversation context -- Alice's private messages would be
visible to Bob.
</Warning>

**The fix:**

```json5
{
  session: {
    dmScope: "per-channel-peer", // isolate by channel + sender
  },
}
```

Other options:

- `main` (default) -- all DMs share one session.
- `per-peer` -- isolate by sender (across channels).
- `per-channel-peer` -- isolate by channel + sender (recommended).
- `per-account-channel-peer` -- isolate by account + channel + sender.

<Tip>
If the same person contacts you from multiple channels, use
`session.identityLinks` to link their identities so they share one session.
</Tip>

### Dock linked channels

Dock commands let a user move the current direct-chat session's reply route to
another linked channel without starting a new session. See
[Channel docking](/concepts/channel-docking) for examples, config, and
troubleshooting.

Verify your setup with `openclaw security audit`.

## Session lifecycle

Sessions are reused until they expire:

- **Daily reset** (default) -- new session at 4:00 AM local time on the gateway
  host. Daily freshness is based on when the current `sessionId` started, not
  on later metadata writes.
- **Idle reset** (optional) -- new session after a period of inactivity. Set
  `session.reset.idleMinutes`. Idle freshness is based on the last real
  user/channel interaction, so heartbeat, cron, and exec system events do not
  keep the session alive.
- **Manual reset** -- type `/new` or `/reset` in chat. `/new <model>` also
  switches the model.

When both daily and idle resets are configured, whichever expires first wins.
Heartbeat, cron, exec, and other system-event turns may write session metadata,
but those writes do not extend daily or idle reset freshness. When a reset
rolls the session, queued system-event notices for the old session are
discarded so stale background updates are not prepended to the first prompt in
the new session.

Sessions with an active provider-owned CLI session are not cut by the implicit
daily default. Use `/reset` or configure `session.reset` explicitly when those
sessions should expire on a timer.

## Where state lives

All session state is owned by the **gateway**. UI clients query the gateway for
session data.

- **Store:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- **Transcripts:** `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

`sessions.json` keeps separate lifecycle timestamps:

- `sessionStartedAt`: when the current `sessionId` began; daily reset uses this.
- `lastInteractionAt`: last user/channel interaction that extends idle lifetime.
- `updatedAt`: last store-row mutation; useful for listing and pruning, but not
  authoritative for daily/idle reset freshness.

Older rows without `sessionStartedAt` are resolved from the transcript JSONL
session header when available. If an older row also lacks `lastInteractionAt`,
idle freshness falls back to that session start time, not to later bookkeeping
writes.

## Session maintenance

OpenClaw automatically bounds session storage over time. By default, it runs
in `warn` mode (reports what would be cleaned). Set `session.maintenance.mode`
to `"enforce"` for automatic cleanup:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "30d",
      maxEntries: 500,
    },
  },
}
```

For production-sized `maxEntries` limits, Gateway runtime writes use a small high-water buffer and clean back down to the configured cap in batches. Session store reads do not prune or cap entries during Gateway startup. This avoids running full store cleanup on every startup or isolated cron session. `openclaw sessions cleanup --enforce` applies the cap immediately.

Maintenance preserves durable external conversation pointers, including group
sessions and thread-scoped chat sessions, while still allowing synthetic cron,
hook, heartbeat, ACP, and sub-agent entries to age out.

If you previously used direct-message isolation and later returned
`session.dmScope` to `main`, preview stale peer-keyed DM rows with
`openclaw sessions cleanup --dry-run --fix-dm-scope`. Applying the same flag
retires those old direct-DM rows and keeps their transcripts as deleted
archives.

Preview with `openclaw sessions cleanup --dry-run`.

## Inspecting sessions

- `openclaw status` -- session store path and recent activity.
- `openclaw sessions --json` -- all sessions (filter with `--active <minutes>`).
- `/status` in chat -- context usage, model, and toggles.
- `/context list` -- what is in the system prompt.

## Further reading

- [Session Pruning](/concepts/session-pruning) -- trimming tool results
- [Compaction](/concepts/compaction) -- summarizing long conversations
- [Session Tools](/concepts/session-tool) -- agent tools for cross-session work
- [Session Management Deep Dive](/reference/session-management-compaction) --
  store schema, transcripts, send policy, origin metadata, and advanced config
- [Multi-Agent](/concepts/multi-agent) — routing and session isolation across agents
- [Background Tasks](/automation/tasks) — how detached work creates task records with session references
- [Channel Routing](/channels/channel-routing) — how inbound messages are routed to sessions

## Related

- [Session pruning](/concepts/session-pruning)
- [Session tools](/concepts/session-tool)
- [Command queue](/concepts/queue)
