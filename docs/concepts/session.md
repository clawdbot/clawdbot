---
summary: "How OpenClaw manages conversation sessions"
read_when:
  - You want to understand session routing and isolation
  - You want to configure DM scope for multi-user setups
title: "Session Management"
---

# Session Management

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

Verify your setup with `openclaw security audit`.

## Session lifecycle

Sessions are reused until they expire:

- **Daily reset** (default) -- new session at 4:00 AM local time on the gateway
  host.
- **Idle reset** (optional) -- new session after a period of inactivity. Set
  `session.reset.idleMinutes`.
- **Manual reset** -- type `/new` or `/reset` in chat. `/new <model>` also
  switches the model.

When both daily and idle resets are configured, whichever expires first wins.

Sessions with an active provider-owned CLI session are not cut by the implicit
daily default. Use `/reset` or configure `session.reset` explicitly when those
sessions should expire on a timer.

## Where state lives

All session state is owned by the **gateway**. UI clients query the gateway for
session data.

- **Store:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- **Transcripts:** `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

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
