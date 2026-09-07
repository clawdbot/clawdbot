---
summary: "session.* scope, identity links, reset policy, sharing, and retention"
read_when:
  - Choosing how conversations map to sessions
  - Setting session reset or retention policy
  - Sharing a session with other operators
title: "Configuration — agent sessions"
---

`session.*` keys: how conversations map to sessions, when a session resets, and who can see or join one.

## Session

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main", // main | per-peer | per-channel-peer | per-account-channel-peer
    groupScope: "per-group", // main | per-group
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily", // daily | idle
      atHour: 4,
      idleMinutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 30 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    maintenance: {
      mode: "enforce", // enforce (default) | warn
      pruneAfter: "30d",
      archiveDashboardAfter: "7d", // false or 0 disables this dashboard trigger
      maxEntries: 5000,
      preserveRecent: "7d", // opt-in protection; disabled when omitted or false
      resetArchiveRetention: "30d", // duration or false
      maxDiskBytes: "500mb", // physical disk budget; default "10gb"
      highWaterBytes: "400mb", // optional cleanup target
    },
    threadBindings: {
      enabled: true,
      idleHours: 24, // default inactivity auto-unbind in hours (`0` disables)
      maxAgeHours: 0, // default hard max age in hours (`0` disables)
    },
    sharing: {
      readOnly: true,
      suggest: true,
      drafts: true,
    },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

<Accordion title="Session field details">

- **`scope`**: base session grouping strategy for group-chat contexts.
  - `per-sender` (default): each sender gets an isolated session within a channel context.
  - `global`: all participants in a channel context share a single session (use only when shared context is intended).
- **`dmScope`**: how DMs are grouped.
  - `main`: all DMs share the main session.
  - `per-peer`: isolate by sender id across channels.
  - `per-channel-peer`: isolate per channel + sender (recommended for multi-user inboxes).
  - `per-account-channel-peer`: isolate per account + channel + sender (recommended for multi-account).
- **`groupScope`**: how groups, rooms, and channels are grouped.
  - `per-group` (default): keep each non-direct peer in its channel-scoped session.
  - `main`: route non-direct peers into the agent main session. Prefer a narrow `bindings[].session.groupScope` override when only selected trusted rooms should share main context.
- **`identityLinks`**: map canonical ids to provider-prefixed peers for cross-channel session sharing.
- **`reset`**: primary reset policy. `none` disables automatic reset and is the default; compaction bounds active context instead. `daily` resets at `atHour` local time; `idle` resets after `idleMinutes`. When both configured, whichever expires first wins. `/new` and `/reset` remain available in every mode. Daily reset freshness uses the session row's `sessionStartedAt`; idle reset freshness uses `lastInteractionAt`. Background/system-event writes such as heartbeat, cron wakeups, exec notifications, and gateway bookkeeping can update `updatedAt`, but they do not keep daily/idle sessions fresh.
  - **`resetByType`**: per-type overrides (`direct`, `group`, `thread`). Doctor migrates legacy `dm` entries to `direct`; the schema rejects `dm`.
- **`resetByChannel`**: per-channel reset overrides keyed by provider/channel id. When the session's channel has a matching entry, it wins outright over `resetByType`/`reset` for that session. Use only when one channel needs reset behavior different from the type-level policy.
- **`mainKey`**: accepted but ignored. The per-agent main-session suffix is always `main`; omit this field. Global session scope uses `global` instead.
- **`sendPolicy`**: match by `channel`, `chatType` (`direct|group|channel`, with legacy `dm` alias), `keyPrefix`, or `rawKeyPrefix`. First deny wins.
- **`maintenance`**: session-store cleanup + retention controls.
  - `mode`: `enforce` applies cleanup and is the default; `warn` emits warnings only.
  - `pruneAfter`: age cutoff for stale entries (default `30d`). Eligible durable sessions archive in place with their identity and history intact; disposable automation rows are removed.
  - `archiveDashboardAfter`: inactivity cutoff for archiving visible dashboard sessions (default `7d`); `false` or `0` disables only this dashboard trigger. Eligible sessions can still be archived by `pruneAfter` or `maxEntries`.
  - `maxEntries`: maximum number of unarchived SQLite session entries (default `5000`). Archived rows do not consume the cap. Cleanup archives the oldest eligible ordinary sessions, while synthetic runtime sessions remain disposable and may be removed. Pinned sessions, active or admitted work, model-locked sessions, and durable external conversation pointers remain protected; if protection prevents reaching the cap, the unarchived store remains above it. Runtime writes batch cleanup with a small high-water buffer for production-sized caps; `openclaw sessions cleanup --enforce` applies the cap immediately but does not unprotect rows.
  - `preserveRecent`: optional inactivity window that protects recently active interactive sessions and all of their SQLite history generations from automatic age, count, and disk-budget history eviction (for example `"7d"`). Unset or `false` disables this protection. Synthetic model-run, cron, hook, heartbeat, ACP, and sub-agent sessions remain eligible for bounded cleanup. Protection can temporarily keep the store above configured entry or disk targets and does not archive sessions.
  - Short-lived gateway model-run probe sessions use fixed `24h` retention, but cleanup is pressure-gated: it only removes stale strict model-run probe rows when session-entry maintenance/cap pressure is reached. Only strict explicit probe keys matching `agent:*:explicit:model-run-<uuid>` are eligible; normal direct, group, thread, cron, hook, heartbeat, ACP, and sub-agent sessions do not inherit this 24h retention. When model-run cleanup runs, it runs before the broader `pruneAfter` stale-entry cleanup and `maxEntries` cap.
  - Legacy `rotateBytes` is rejected by the current schema; `openclaw doctor --fix` removes it from older configs.
  - `resetArchiveRetention`: age-based retention for reset/deleted transcript archives. By default, archives remain until disk-budget eviction; set a duration to opt into wall-clock deletion, or `false` to disable it explicitly.
  - `maxDiskBytes`: per-agent physical disk budget (default `10gb`), counting the SQLite main file, its `-wal` file, and counted files in the agent sessions directory. In `warn` mode it logs warnings. In `enforce` mode it first reclaims checkpointable database space, then removes old reset/delete artifacts, unreferenced historical generations, and finally the oldest sessions explicitly marked as archived by the active-session cap. Manual, legacy, age-retention, stale-dashboard, and recovery archives remain protected. Protected history and database pages that cannot yet be reclaimed can keep usage above the cleanup target; this is not a guaranteed physical ceiling. Set `false`, `0`, or `"0"` to disable the budget entirely.
  - `highWaterBytes`: optional target after budget cleanup. Defaults to `80%` of `maxDiskBytes`. A value that resolves to zero falls back to the default; negative values are invalid. Disable the budget with `maxDiskBytes`, not with a zero high-water mark.
- **`threadBindings`**: global defaults for thread-bound session features.
  - `enabled`: master switch for supported channel thread bindings
  - `idleHours`: default inactivity auto-unbind in hours (`0` disables; providers can override)
  - `maxAgeHours`: default hard max age in hours (`0` disables; providers can override)
  - `spawnSessions`: default gate for creating thread-bound work sessions from `sessions_spawn` and ACP thread spawns. Defaults to `true` when thread bindings are enabled; providers/accounts can override.
  - `defaultSpawnContext`: default native subagent context for thread-bound spawns (`"fork"` or `"isolated"`). Defaults to `"fork"`.
- **`sharing`**: controls which per-session collaboration modes owners and `operator.admin` connections may select. Every flag defaults to `true`; setting one to `false` removes that choice from the Control UI and makes create-time visibility or `session.visibility.set` reject it. New sessions start `shared` unless the Control UI starts one as a draft.
  - `readOnly`: allow `read-only`, where non-members can watch but cannot send, steer, abort, approve, or mutate session state.
  - `suggest`: allow `suggest`, where viewers can submit suggestions for the session owner or an `operator.admin` connection to send, queue, edit, or dismiss without granting direct access to send or manage the session.
  - `drafts`: allow `draft`, which hides the session from non-admin, non-owner session lists and event broadcasts.

Session visibility and membership are maintained as canonical sharing state. Structured `session.sharing` events carry an attributed actor; principal-less changes use the additive `session.sharing.evidence` event. Every sharing change also emits the existing `sessions.changed` row refresh, so clients that do not recognize the evidence event still refresh canonical state. These events and `session.suggestion` do not add administrative narration to conversation transcripts. These controls coordinate operators sharing one agent; they are not a security boundary between tenants. Use separate Gateways or agents when work requires isolation.

</Accordion>
