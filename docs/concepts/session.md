---
summary: "How OpenClaw manages conversation sessions"
read_when:
  - You want to understand session routing and isolation
  - You want to configure DM scope for multi-user setups
  - You are debugging daily or idle session resets
title: "Session management"
---

OpenClaw routes every inbound message to a **session** based on where it came
from: DMs, group chats, cron jobs, etc. All session state is owned by the
**gateway**; UI clients query the gateway for session data.

For the personal-agent default — one rolling conversation shared by all your
DM channels, with group activity and background work flowing into it — see
[The main session](/concepts/main-session).

## How messages are routed

| Source          | Behavior                  |
| --------------- | ------------------------- |
| Direct messages | Shared session by default |
| Group chats     | Isolated per group        |
| Rooms/channels  | Isolated per room         |
| Cron jobs       | Fresh session per run     |
| Webhooks        | Isolated per hook         |

## DM isolation

By default, all DMs share one session for continuity, which is fine for
single-user setups.

<Warning>
If multiple people can message your agent, enable DM isolation. Without it, all
users share the same conversation context, so Alice's private messages would be
visible to Bob.
</Warning>

```json5
{
  session: {
    dmScope: "per-channel-peer", // isolate by channel + sender
  },
}
```

`session.dmScope` options:

| Value                      | Behavior                                                 |
| -------------------------- | -------------------------------------------------------- |
| `main` (default)           | All DMs share the [main session](/concepts/main-session) |
| `per-peer`                 | Isolate by sender, across channels                       |
| `per-channel-peer`         | Isolate by channel + sender (recommended)                |
| `per-account-channel-peer` | Isolate by account + channel + sender                    |

<Tip>
If the same person contacts you from multiple channels, use
`session.identityLinks` to map their identities to one canonical peer id so
they share a session.
</Tip>

### Dock linked channels

Dock commands move the current direct-chat session's reply route to another
linked channel without starting a new session. See
[Channel docking](/concepts/channel-docking) for examples, config, and
troubleshooting.

Verify your setup with `openclaw security audit`.

## Remember across conversations

Separate transcripts control each conversation's local history. For a personal
or fully trusted agent, `memory.search.rememberAcrossConversations: true`
adds an optional retrieval step across that agent's other private
conversations; it does not combine their transcripts.

Private direct and persistent explicit UI conversations can supply relevant
context to one another. Groups and channels stay separate in both directions:
their transcripts are not private recall sources, and replies in those
conversations do not receive private transcript context. The current
conversation is also excluded because its history is already loaded.

This setting does not change session keys, DM scope, routing, delivery, or
`tools.sessions.visibility`. Shared workspace memory in `MEMORY.md` and
`memory/*.md` also keeps its existing behavior. The current memory provider
must support protected private transcript recall; context engines such as
Lossless Claw remain independent and can run alongside it. See
[Active Memory](/concepts/active-memory#remember-across-conversations) for setup
and runtime details.

## Session lifecycle

Sessions are reused until you reset them manually or opt into an automatic reset policy:

- **No automatic reset** (default `mode: "none"`) - sessions keep the same
  `sessionId`; compaction manages the active context as the conversation grows.
- **Daily reset** (`mode: "daily"`) - opt into a new session at a configured local
  hour (`session.reset.atHour`, default `4`, 0-23) on the gateway host. Daily
  freshness is based on when the current `sessionId` started, not on later
  metadata writes.
- **Idle reset** (`mode: "idle"`) - opt into a new session after `session.reset.idleMinutes`
  of inactivity. Idle freshness is based on the last real user/channel
  interaction, so heartbeat, cron, and exec system events do not keep the
  session alive.
- **Manual reset** - type `/new` or `/reset` in chat. `/new <model>` also
  switches the model.

When both daily and idle resets are configured, whichever expires first wins.
Heartbeat, cron, exec, and other system-event turns may write session metadata,
but those writes do not extend daily or idle reset freshness. When a reset
rolls the session, queued system-event notices for the old session are
discarded so stale background updates are not prepended to the first prompt in
the new session.

Sessions with an active provider-owned CLI session follow the same no-automatic-reset
default. Use `/reset` or configure `session.reset` explicitly when those sessions
should expire on a timer.

Opt into automatic resets globally, then override them per chat type or channel:

```json5
{
  session: {
    reset: { mode: "daily", atHour: 4 },
    resetByType: {
      group: { mode: "idle", idleMinutes: 120 },
      thread: { mode: "daily", atHour: 6 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
  },
}
```

`resetByType` supports `direct`, `group`, and `thread`. Doctor migrates legacy `dm` entries to `direct` and `session.idleMinutes` to `session.reset.idleMinutes`; the schema rejects both retired forms.

## Where state lives

- **Runtime session rows:** `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
- **Archived transcript files:** `~/.openclaw/agents/<agentId>/sessions/`
- **Legacy row migration source:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`

The session rows in the per-agent SQLite database keep separate lifecycle
timestamps:

- `sessionStartedAt`: when the current `sessionId` began; daily reset uses this.
- `lastInteractionAt`: last user/channel interaction that extends idle lifetime.
- `updatedAt`: last store-row mutation; useful for listing and pruning, but not
  authoritative for daily/idle reset freshness.

During migration from older installs, gateway startup and `openclaw doctor
--fix` import legacy `sessions.json` rows and hot transcript JSONL history into
SQLite automatically. Rows without `sessionStartedAt` are resolved from the
legacy transcript JSONL session header when available. If an older row also
lacks `lastInteractionAt`, idle freshness falls back to that session start time,
not to later bookkeeping writes. Use `openclaw doctor --session-sqlite inspect
--session-sqlite-all-agents` and the [Doctor migration
sequence](/cli/doctor#session-sqlite-migration) when you want explicit
inspection or validation evidence.

## Session maintenance

OpenClaw bounds session storage over time via `session.maintenance`, defaults
shown:

```json5
{
  session: {
    maintenance: {
      mode: "enforce", // "enforce" applies cleanup; "warn" only reports
      pruneAfter: "30d",
      maxEntries: 500,
    },
  },
}
```

For production-sized `maxEntries` limits, Gateway runtime writes use a small
high-water buffer and clean back down to the configured cap in batches.
Session store reads do not prune or cap entries during Gateway startup, so
startup and isolated cron sessions do not pay for a full store cleanup.
`openclaw sessions cleanup --enforce` applies the cap immediately.

Gateway model-run probe sessions are short-lived by default. Rows matching
`agent:*:explicit:model-run-<uuid>` use fixed `24h` retention, but cleanup is
pressure-gated: it only removes stale probe rows when session-entry
maintenance/cap pressure is reached, and runs before the broader stale-entry
age cutoff and entry cap. Normal direct, group, thread, cron, hook, heartbeat,
ACP, and sub-agent sessions do not inherit this 24h retention.

Maintenance preserves durable external conversation pointers, including group
sessions and thread-scoped chat sessions, while still allowing synthetic cron,
hook, heartbeat, ACP, and sub-agent entries to age out.

Archived sessions are user-shelved and exempt from every automatic maintenance
path, including age pruning, entry caps, model-run cleanup, and disk-budget
eviction. They remain archived until you unarchive them or explicitly delete
them.

If you previously used DM isolation and later returned `session.dmScope` to
`main`, preview stale peer-keyed DM rows with
`openclaw sessions cleanup --dry-run --fix-dm-scope`. Applying the same flag
retires those old direct-DM rows and keeps their transcripts as deleted
archives.

Preview any maintenance run with `openclaw sessions cleanup --dry-run`.

## Inspecting sessions

| Command                    | Shows                                           |
| -------------------------- | ----------------------------------------------- |
| `openclaw status`          | Session store path and recent activity          |
| `openclaw sessions --json` | All sessions (filter with `--active <minutes>`) |
| `/status` in chat          | Context usage, model, and toggles               |
| `/context list`            | What is in the system prompt                    |

## Further reading

- [Session search](/concepts/session-search) - full-text recall across past transcripts
- [Session Pruning](/concepts/session-pruning) - trimming tool results
- [Compaction](/concepts/compaction) - summarizing long conversations
- [Session Tools](/concepts/session-tool) - agent tools for cross-session work
- [Session Management Deep Dive](/reference/session-management-compaction) -
  store schema, transcripts, send policy, origin metadata, and advanced config
- [Multi-Agent](/concepts/multi-agent) - routing and session isolation across agents
- [Background Tasks](/automation/tasks) - how detached work creates task records with session references
- [Channel Routing](/channels/channel-routing) - how inbound messages are routed to sessions

## Related

- [Session pruning](/concepts/session-pruning)
- [Session tools](/concepts/session-tool)
- [Command queue](/concepts/queue)
