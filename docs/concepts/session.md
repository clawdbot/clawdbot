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

To continue the same Gateway-owned session in the Control UI, terminal, or a
coding harness, see [Session synchronization and attachment](/concepts/session-attachment).

For the personal-agent default — one rolling conversation shared by all your
DM channels, with group activity and background work flowing into it — see
[The main session](/concepts/main-session).

## How messages are routed

| Source          | Behavior                      |
| --------------- | ----------------------------- |
| Direct messages | Shared session by default     |
| Group chats     | Isolated per group by default |
| Rooms/channels  | Isolated per room by default  |
| Cron jobs       | Fresh session per run         |
| Webhooks        | Isolated per hook             |

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

## Group and room routing

`session.groupScope` controls where non-direct peers store conversation
context:

| Value                 | Behavior                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `per-group` (default) | Keep each group, room, or channel in its existing channel-scoped session                  |
| `main`                | Route groups, rooms, and channels into the agent's [main session](/concepts/main-session) |

A route binding can override the global value. This is useful when only a
named team room should join the main conversation:

```json5
{
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "slack",
        peer: { kind: "channel", id: "C0123TEAM" },
      },
      session: { groupScope: "main" },
    },
  ],
}
```

Use `peer.kind: "group"` for providers that classify the room as a group.
The binding override wins over global `session.groupScope`. This setting
changes session-key selection only: DM routing, mention gating, delivery
context, and replies to the source room remain unchanged.

## Incognito sessions

Incognito sessions are available only from the Control UI's **New thread** screen. Turn on **Incognito** before starting the thread to keep its session entry, transcript, and compaction state in process memory instead of on disk. The thread disappears when the Gateway restarts, does not run OpenClaw's automatic memory flush, and does not create a transcript archive when you reset or delete it. Codex-backed runs also start their harness thread in ephemeral mode, so Codex writes no rollout or local session-state files; other model providers use HTTP APIs and keep no local provider transcript in OpenClaw.

The `incognito-` segment is reserved for dashboard, subagent, and hidden internal session keys; `openclaw doctor --fix` renames any colliding legacy durable keys.

Incognito does not restrict the agent's normal tools. An explicit request to save information, or any tool-driven file write, can still persist data outside the incognito session store. Your configured model provider still processes the messages you send, diagnostic logging remains unchanged, and OpenClaw still records content-free audit metadata such as HMAC references.

On multi-user gateways, incognito threads are visible only to admin-scope connections and never appear through another session's agent session tools or transcript search. This protects them from storage and other gateway-mediated users, not from the gateway owner or process operator, who can always observe live sessions.

## Remember across conversations

Separate transcripts control each conversation's local history. For a personal
or fully trusted agent, `memory.search.rememberAcrossConversations: true`
adds an optional retrieval step across that agent's other private
conversations; it does not combine their transcripts.

Private direct and persistent explicit UI conversations can supply relevant
context to one another. Under default `session.groupScope: "per-group"`, groups and channels stay separate in both directions:
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

## Gateway restart recovery

When a Gateway restart interrupts an active turn, OpenClaw tries to continue
the existing session automatically. Three attempts that fail to start a backend
turn exhaust the recovery budget. Once a real backend turn starts,
the budget refreshes, so a later Gateway restart does not consume the old allowance.
Accepting, queueing, or preparing a resume request alone does not refresh it.
CLI backends that do not report turn acceptance refresh the budget only after
observed assistant output or tool activity; silent startup does not refresh it.

If automatic recovery is exhausted, the transcript remains available. Use
**Resume in new session** in WebChat, or `/new` or `/reset` in other channels,
to start a replacement session.

## Where state lives

- **Runtime session rows and transcripts:** `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` by default
- **Archived transcript files:** `~/.openclaw/agents/<agentId>/sessions/`
- **Legacy row migration source:** `~/.openclaw/agents/<agentId>/sessions/sessions.json`

The session rows in the per-agent SQLite database keep separate lifecycle
timestamps:

- `sessionStartedAt`: when the current `sessionId` began; daily reset uses this.
- `lastInteractionAt`: last user/channel interaction that extends idle lifetime.
- `updatedAt`: last store-row mutation; useful for listing and pruning, but not
  authoritative for daily/idle reset freshness.

To import legacy `sessions.json` rows and hot transcript JSONL history from an
older installation, stop the Gateway, back up its state, and run
`openclaw doctor --fix` before restarting it. Gateway and local CLI startup use
SQLite without importing, restoring, or rewriting legacy session files.
If startup finds a legacy store, it refuses readiness and prints the Doctor
command for the active profile instead of silently starting with empty history.
During Doctor import, rows without `sessionStartedAt` are resolved from the
legacy transcript JSONL session header when available. If an older row also
lacks `lastInteractionAt`, idle freshness falls back to that session start time,
not to later bookkeeping writes. Use `openclaw doctor --session-sqlite inspect
--session-sqlite-all-agents` and the [Doctor migration
sequence](/cli/doctor#session-sqlite-migration) for inspection and validation.

## Session maintenance

OpenClaw bounds session storage over time via `session.maintenance`, defaults
shown:

```json5
{
  session: {
    maintenance: {
      mode: "enforce", // "enforce" applies cleanup; "warn" only reports
      pruneAfter: "30d",
      archiveDashboardAfter: "7d", // false or 0 disables
      maxEntries: 500,
      preserveRecent: "7d", // optional; false or omitted disables
    },
  },
}
```

For production-sized `maxEntries` limits, Gateway runtime writes use a small
high-water buffer and clean back down to the configured cap in batches.
Session store reads do not prune or cap entries during Gateway startup, so
startup and isolated cron sessions do not pay for a full store cleanup.
`openclaw sessions cleanup --enforce` applies the cap immediately.

`maxEntries` counts every live session row. Archived or pinned sessions, active
or admitted work, model-locked sessions, and durable external conversation
pointers are protected from automatic eviction, but still consume the cap.
Cleanup removes the oldest unprotected rows until it reaches `maxEntries` or
runs out of eligible victims. The total can therefore remain above the cap when
protected rows alone exceed it or active work temporarily blocks eviction.
Cleanup does not unprotect those rows; unarchive, unpin, wait for active work to
finish, or explicitly delete sessions you no longer want to retain.

Gateway model-run probe sessions are short-lived by default. Rows matching
`agent:*:explicit:model-run-<uuid>` use fixed `24h` retention, but cleanup is
pressure-gated: it only removes stale probe rows when session-entry
maintenance/cap pressure is reached, and runs before the broader stale-entry
age cutoff and entry cap. Normal direct, group, thread, cron, hook, heartbeat,
ACP, and sub-agent sessions do not inherit this 24h retention.

Maintenance preserves durable external conversation pointers, including group
sessions and thread-scoped chat sessions, while still allowing synthetic cron,
hook, heartbeat, ACP, and sub-agent entries to age out.

Shared or high-volume installations can set `preserveRecent` to protect
recently active interactive sessions and every SQLite history generation owned
by those sessions. The option is disabled when omitted or set to `false`, so
personal installations keep the normal oldest-first policy. Synthetic
model-run, cron, hook, heartbeat, ACP, and sub-agent sessions remain eligible
for bounded cleanup. Protection can temporarily keep the store above its entry
or disk target; it expires after the configured inactivity window.

Recent-session protection does not change managed-worktree garbage collection;
durable dashboard sessions auto-archive after 7 days of inactivity by default,
while other session types still require an explicit archive action.

Archived and pinned sessions are user-protected and exempt from every automatic
maintenance path, including age pruning, entry caps, model-run cleanup, and
disk-budget eviction. They remain protected until you unarchive, unpin, or
explicitly delete them.

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
