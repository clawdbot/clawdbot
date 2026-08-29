---
summary: "CLI reference for listing, archiving, deleting, and maintaining stored sessions"
read_when:
  - You want to list stored sessions and see recent activity
  - You want to archive or delete sessions from a headless Gateway
title: "Sessions"
---

# `openclaw sessions`

List stored conversation sessions.

Session lists are not channel/provider liveness checks. They show persisted
conversation rows from session stores. A quiet Discord, Slack, Telegram, or
other channel can reconnect successfully without creating a new session row
until a message is processed. Use `openclaw channels status --probe`,
`openclaw status --deep`, or `openclaw health --verbose` when you need live
channel connectivity.

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --limit 25
openclaw sessions --store ./tmp/sessions.json
openclaw sessions --json
```

Flags:

| Flag                 | Description                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| `--agent <id>`       | One configured agent store (required for multiple explicit agents).           |
| `--all-agents`       | Aggregate all configured agent stores.                                        |
| `--store <path>`     | Legacy store selector path (cannot combine with `--agent` or `--all-agents`). |
| `--active <minutes>` | Only show sessions updated within the past N minutes.                         |
| `--limit <n\|all>`   | Max rows to output (default `100`; `all` restores full output).               |
| `--json`             | Machine-readable output.                                                      |
| `--verbose`          | Verbose logging.                                                              |

`--store` accepts the documented legacy selector form, including `sessions.json`
and suffixless custom selectors. OpenClaw resolves that selector to its physical
SQLite target, verifies the target exists and is usable, and reports the physical
path it actually read.

`openclaw sessions` and the Gateway `sessions.list` RPC are bounded by default
so large long-lived stores cannot monopolize the CLI process or Gateway event
loop. The CLI returns the newest 100 sessions by default; pass `--limit <n>`
for a smaller/larger window or `--limit all` when you intentionally need the
full store. JSON responses include `totalCount`, `limitApplied`, and `hasMore`
when callers need to show that more rows exist.

RPC clients can pass `configuredAgentsOnly: true` to keep the broad combined
discovery source but return only rows for agents currently present in config.
Control UI uses that mode by default so deleted or disk-only agent stores do
not reappear in the Sessions view.

`--all-agents` reads configured agent stores. Gateway and ACP session
discovery are broader: they also include SQLite stores resolved from
configured agent roots or a templated `session.store` root. Legacy selector
paths must resolve inside the agent root; symlinks and out-of-root paths are
skipped.

`openclaw sessions --all-agents --json`:

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/agent/openclaw-agent.sqlite" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/agent/openclaw-agent.sqlite" }
  ],
  "allAgents": true,
  "count": 2,
  "totalCount": 2,
  "limitApplied": 100,
  "hasMore": false,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "openai/gpt-5.6-sol" },
    { "agentId": "work", "key": "agent:work:main", "model": "anthropic/claude-sonnet-4-6" }
  ]
}
```

## Archive sessions

Archive one or more sessions through the running Gateway:

```bash
openclaw sessions archive "agent:main:scratch-1"
openclaw sessions archive "agent:main:scratch-1" "agent:main:scratch-2"
openclaw sessions archive "agent:work:scratch-1" --agent work
openclaw sessions archive "agent:main:scratch-1" --dry-run
openclaw sessions archive "agent:main:scratch-1" --json
```

Archive uses the same `sessions.patch` lifecycle operation as the Control UI.
It keeps the transcript, marks the session archived, and removes the session
from the default active list. For a cloud-worker session with an active
placement, the Gateway first stops the worker, reconciles its workspace, and
reclaims the environment. If the placement is still transitioning or failed
without proof that its environment is gone, the session remains unarchived;
wait for the placement to settle, then retry. Agent main sessions remain
protected. Already archived sessions are successful no-ops. Use `--dry-run` to
validate every key and preview the result without changing session state.

## Delete sessions

Delete one or more sessions through the running Gateway:

```bash
openclaw sessions delete "agent:main:scratch-1"
openclaw sessions delete "agent:main:scratch-1" "agent:main:scratch-2" --yes
openclaw sessions delete "agent:work:scratch-1" --agent work --yes
openclaw sessions delete "agent:main:scratch-1" --dry-run
openclaw sessions delete "agent:main:scratch-1" --yes --json
```

<Warning>
  Delete is destructive. In an interactive terminal it asks once before
  deleting the valid keys. Non-interactive and `--json` deletion requires
  `--yes`. Use `--dry-run` first when scripting a bulk cleanup.
</Warning>

Delete uses the same `sessions.delete` lifecycle operation as the Control UI,
with transcript cleanup enabled. The Gateway removes the live session row,
transcript generations, session-owned runtime state, bindings, boards, and
other lifecycle artifacts. For ordinary sessions it retains the transcript as
a verified `.jsonl.deleted.<timestamp>` archive; incognito transcripts are
removed without an archive. If a managed worktree cannot be removed safely,
the command reports the preserved branch and path for manual cleanup.

Both lifecycle commands:

- accept multiple keys and report one ordered result per key;
- use `--agent <id>` to select the owning agent, which is required for a
  `global` key outside the default agent;
- support `--url`, `--token`, `--password`, and `--timeout <ms>` Gateway
  connection overrides;
- return a non-zero exit when any key is unknown or any operation fails, while
  still processing the other valid keys;
- emit one stable JSON envelope with `ok`, `operation`, `dryRun`, and `results`
  when `--json` is set.

Example mixed-result JSON:

```json
{
  "ok": false,
  "operation": "archive",
  "dryRun": false,
  "results": [
    { "key": "agent:main:scratch-1", "ok": true, "status": "archived" },
    {
      "key": "agent:main:missing",
      "ok": false,
      "status": "not_found",
      "error": "Session not found. Run openclaw sessions list --json to choose a valid key."
    }
  ]
}
```

## Tail trajectory progress

```bash
openclaw sessions tail
openclaw sessions tail --follow
openclaw sessions tail --session-key "agent:main:telegram:direct:123" --tail 25
openclaw sessions --agent work tail --follow
openclaw sessions --all-agents tail --follow
```

`openclaw sessions tail` renders recent runtime trajectory events as compact
progress lines. Without `--session-key`, it tails running sessions first, then
the latest stored session. `--tail <count>` controls how many existing events
print before follow mode; default `80`, and `0` starts at the current end.
`--follow` keeps watching the selected SQLite-backed session or an explicit
legacy trajectory file.

The progress view is intentionally conservative: prompt text, tool arguments,
and tool result bodies are not printed. Tool calls show the tool name with
`{...redacted...}`; tool results show status such as `ok`, `error`, or `done`;
model completion lines show provider/model and terminal status.

## Export a trajectory bundle

```bash
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --workspace .
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --output bug-123 --json
```

This is the command path used by the `/export-trajectory` slash command after
the owner approves the exec request. The output directory is always resolved
inside `.openclaw/trajectory-exports/` under the selected workspace.

## Cleanup maintenance

Run maintenance now instead of waiting for the next write cycle:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:direct:123"
openclaw sessions cleanup --dry-run --fix-dm-scope
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` uses `session.maintenance` settings from config
([Configuration reference](/gateway/config-agents#session)):

- Scope note: `openclaw sessions cleanup` maintains session stores,
  transcripts, trajectory rows, and legacy trajectory sidecars. It does not
  prune cron run history. Task maintenance retains terminal cron history for 7
  days (`lost` rows for 24 hours) and enforces the newest 2000 rows per job and
  history class as an additional ceiling ([Task maintenance](/automation/tasks#automatic-maintenance),
  [Cron configuration](/automation/cron-jobs#configuration)).
- Cleanup also prunes unreferenced legacy/archive transcript artifacts,
  compaction checkpoints, and trajectory sidecars older than
  `session.maintenance.pruneAfter`; artifacts still referenced by SQLite
  session rows are preserved.
- Cleanup reports short-lived Gateway model-run probe cleanup separately as
  `modelRunPruned`. This only matches strict explicit keys shaped like
  `agent:*:explicit:model-run-<uuid>`. Retention is a fixed `24h` and is
  pressure-gated: it only removes stale probe rows when session-entry
  maintenance/cap pressure is reached. When it runs, model-run cleanup
  happens before global stale cleanup and capping.
- `maxEntries` caps the total live session row count. Protected rows are
  reported as `keep` and count toward the cap, but they are never automatic
  eviction targets. If protected rows prevent cleanup from reaching the cap,
  the store remains above it. `--enforce` does not remove that protection;
  unarchive, unpin, wait for active work to finish, or explicitly delete
  sessions you no longer want to retain.

Flags:

| Flag                 | Description                                                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`          | Preview how many entries would be pruned/capped without writing. In text mode, prints a per-session action table (`Action`, `Key`, `Age`, `Model`, `Flags`) plus a summary grouped by session label.                                                                                                       |
| `--enforce`          | Apply maintenance even when `session.maintenance.mode` is `warn`.                                                                                                                                                                                                                                          |
| `--fix-missing`      | Remove legacy entries whose archived transcript artifacts are missing or header-only/empty, even if they would not normally age/count out yet.                                                                                                                                                             |
| `--fix-dm-scope`     | When `session.dmScope` is `main`, retire stale peer-keyed direct-DM rows left behind by earlier `per-peer`, `per-channel-peer`, or `per-account-channel-peer` routing. Use `--dry-run` first; applying removes those rows from SQLite and preserves their legacy transcript artifacts as deleted archives. |
| `--active-key <key>` | Protect a specific active key from automatic maintenance. It still counts toward `maxEntries`. Durable external conversation pointers, such as group sessions and thread-scoped chat sessions, are also kept by age/count/disk-budget maintenance.                                                         |
| `--agent <id>`       | Run cleanup for one configured agent store.                                                                                                                                                                                                                                                                |
| `--all-agents`       | Run cleanup for all configured agent stores.                                                                                                                                                                                                                                                               |
| `--store <path>`     | Run against a specific legacy store selector path.                                                                                                                                                                                                                                                         |
| `--json`             | Print a JSON summary. With `--all-agents`, output includes one summary per store.                                                                                                                                                                                                                          |

When a Gateway is reachable, non-dry-run cleanup for configured agent stores is
sent through the Gateway so it shares the same session-store writer as runtime
traffic. Use `--store <path>` for explicit offline repair of a legacy store
selector.

Offline cleanup loads trusted, permitted harness plugins so their session-owned
resources are reclaimed with the deleted rows, even if the agent now uses a
different model. Explicitly disabled or untrusted plugins are not run. If their
resources may remain, cleanup prints a warning on stderr without changing the
JSON result. Dry runs do not load harness plugins.

`openclaw sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "missing": 0,
      "dmScopeRetired": 0,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.openclaw/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "missing": 0,
      "dmScopeRetired": 0,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

## Compact a session

Reclaim context budget for a wedged or oversized session. `openclaw sessions
compact <key>` is the first-class wrapper around the `sessions.compact`
Gateway RPC and requires a running Gateway.

```bash
openclaw sessions compact "agent:main:main"
openclaw sessions compact "agent:main:main" --max-lines 200
openclaw sessions compact "agent:work:main" --agent work --json
```

- Without `--max-lines`, the Gateway LLM-summarizes the transcript. The CLI
  does not impose a client deadline by default; the Gateway owns the
  configured compaction lifecycle.
- With `--max-lines <n>`, it permanently truncates the SQLite transcript to the
  last `n` lines. This path does not create a backup archive.
- `--agent <id>`: agent that owns the session; required for `global` keys.
- `--url` / `--token` / `--password`: Gateway connection overrides.
- `--timeout <ms>`: optional client-side RPC timeout in milliseconds.
- `--json`: print the raw RPC payload.

The command exits non-zero when the Gateway reports a failed compaction or is
unreachable, so crons and scripts never mistake a silent no-op for success.

<Note>
`openclaw agent --message '/compact ...'` is **not** a compaction path. Slash
commands from the CLI are rejected by the authorized-sender check; that
invocation exits non-zero with guidance pointing here instead of silently
no-opping.
</Note>

### sessions.compact RPC

`openclaw gateway call sessions.compact --params '<json>'` accepts:

| Field      | Type        | Required | Description                                                |
| ---------- | ----------- | -------- | ---------------------------------------------------------- |
| `key`      | string      | yes      | Session key to compact (for example `agent:main:main`).    |
| `agentId`  | string      | no       | Agent id that owns the session (for `global` keys).        |
| `maxLines` | integer ≥ 1 | no       | Truncate to the last N lines instead of LLM summarization. |

Example LLM-summarize response:

```json
{
  "ok": true,
  "key": "agent:main:main",
  "compacted": true,
  "result": { "tokensBefore": 243868, "tokensAfter": 34941 }
}
```

Example truncate response (`--max-lines 200`):

```json
{
  "ok": true,
  "key": "agent:main:main",
  "compacted": true,
  "kept": 200
}
```

## Related

- [Session config](/gateway/config-agents#session)
- [Session management](/concepts/session)
- [Compaction](/concepts/compaction)
- [CLI reference](/cli)
