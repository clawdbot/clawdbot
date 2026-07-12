---
summary: "Durable session state signal log: state versions, watchers, stale-state notices, and reconciliation"
read_when:
  - You want agents to notice when humans or other agents change a session behind their back
  - You are debugging state-change notices, watch cursors, or session_status changesSince
  - You want to understand how parent agents stay synchronized with child sessions
title: "Session state awareness"
sidebarTitle: "Session state awareness"
---

When several sessions work on the same problem — a manager delegating to children, a human jumping directly into a worker session, two agents coordinating over [`sessions_send`](/concepts/session-tool) — each session builds assumptions about the others. Those assumptions go stale the moment another actor intervenes. Session state awareness is the machinery that detects the intervention, tells the affected session once, and gives it a cheap way to catch up before acting.

Three pieces work together:

1. A **durable signal log** records selected state changes per session.
2. **Watchers** hold per-target cursors and receive one coalesced stale-state notice.
3. **Reconciliation** pulls the exact delta via `session_status` with `changesSince`.

## The signal log

OpenClaw appends a typed event to the shared state database (`session_state_events`) when a watched session materially changes. Events carry metadata and a one-line summary — never message content.

| Kind                   | Recorded when                                            | Notifies watchers |
| ---------------------- | -------------------------------------------------------- | ----------------- |
| `human_direct_message` | A human sends a turn directly to a watched session       | Yes               |
| `goal_changed`         | The session's goal state is created, updated, or cleared | Yes               |
| `child_spawned`        | A sub-agent or ACP child session is created              | No (seeds cursor) |
| `run_completed`        | A child run ends successfully                            | No (log only)     |
| `run_failed`           | A child run fails, times out, or is cancelled            | No (log only)     |
| `compacted`            | The session's history is compacted                       | No (log only)     |

Each event names its actor (`human`, `agent`, or `system`). Cancelled and timed-out child runs are recorded as failures with the precise outcome (`cancelled`, `timeout`, or `error`) preserved in the event payload.

A session's **state version** is simply the highest sequence number in its log, tracked in a durable per-session head that survives pruning. `sessions_list` rows include `stateVersion` when a session has logged changes; `session_status` always reports it.

Log-only kinds exist for reconciliation history, not notification: ordinary child-run completion delivery stays owned by [sub-agent announcements](/tools/subagents), and the signal log never duplicates it.

## Watchers

A watcher is a session that holds a cursor (`session_watch_cursors`) on a target. Cursors come from two places:

- **Implicit (spawn edges).** When a session spawns a sub-agent or ACP child, the parent's cursor is seeded automatically at the child's spawn version. Parents never subscribe manually.
- **Explicit (`sessions_send watch: true`).** Any coordinator can watch a non-spawned target: pass `watch: true` on `sessions_send`, and after the send dispatches successfully the sender is registered as a watcher of the session that actually received the message. Registration starts at the target's current state version — prior history never produces notices. The tool result reports `watched: true|false` when the parameter was set.

Watcher identity must be an agent-qualified session key. Under `session.scope="global"` the shared `global` key is ambiguous across agents, so such sessions get the durable log and `changesSince` but no proactive notices.

Watches clean themselves up: cursor rows expire with signal-log retention, are removed when the watcher session resets, and are deleted with either session. There is no unwatch verb in v1.

## Notices: one, not many

When a notify-eligible event lands and a watcher's cursor is behind, the watcher receives one system notice on its next turn:

```
Session "agent:main:subagent:child" changed (other actor). Reconcile before acting: session_status sessionKey "agent:main:subagent:child" changesSince 12.
```

Main-session watchers are also woken immediately via a heartbeat wake; nested sub-agent watchers get the notice on their next turn.

The protocol is deliberately anti-spam:

- **One pending notice per watcher/target pair.** The notice text is byte-stable while pending and the system-event queue dedupes on it, so twenty rapid changes to the same target still produce a single line in the watcher's prompt.
- **Frozen watermark.** The cursor freezes its notified position when a notice is queued. Further material events advance only the material watermark; they do not re-notify.
- **Acknowledge on drain, reopen only for interleaved work.** When the watcher's turn consumes the notice, the cursor advances. If more material events arrived between queueing and draining, exactly one fresh notice is opened for the remainder.
- **Self-suppression.** A watcher never gets notified about events it caused itself.
- **Restart recovery.** Pending notices live in an in-memory queue; a startup sweep re-materializes them from durable cursors after a gateway restart.

## Reconciling

The notice tells the watcher exactly what to do. `session_status` with `changesSince: <version>` returns the typed events after that version (up to 200), without advancing any cursors:

```json
{
  "stateVersion": 19,
  "stateChanges": {
    "events": [
      {
        "sequence": 14,
        "kind": "human_direct_message",
        "actorType": "human",
        "summary": "human message via telegram"
      },
      { "sequence": 19, "kind": "goal_changed", "actorType": "human", "summary": "goal updated" }
    ],
    "historyGap": false
  }
}
```

`historyGap: true` means the requested version predates retained history — refresh the whole session state (`sessions_history`, `session_status`) instead of treating the response as an exact delta. The gap signal is exact: it comes from a per-session pruned watermark, not inferred from sequence arithmetic.

## Storage and limits

History lives in the shared state database, bounded to 30 days and 50,000 rows; per-session heads stay monotonic after pruning. Recording is best-effort — a failed append is logged and never fails the originating turn — so `stateVersion` is a signal-log head, not a transactional change-data-capture version.

Current limits:

- Notice delivery assumes one gateway process owns the shared state database. Multiple gateways share the durable log and `changesSince`, but v1 does not push notices across processes.
- Compaction events cover the embedded runtime's compaction owners; native-harness-only compaction is not fully logged.
- Cancelled-outcome payload detail is currently produced by ACP child runs; native sub-agent cancellations surface as generic failures.

## Related

- [Session tools](/concepts/session-tool) — `sessions_send`, `session_status`, `sessions_list`
- [Sub-agents](/tools/subagents) — spawn edges and completion announcements
- [Heartbeat](/gateway/heartbeat) — how queued notices wake main sessions
- [Session management](/concepts/session) — session keys, scopes, lifecycle
