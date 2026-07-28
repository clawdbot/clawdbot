---
summary: "CLI reference for `openclaw sessions` (list stored sessions + usage)"
read_when:
  - You want to list stored sessions and see recent activity
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

| Flag                 | Description                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `--agent <id>`       | One configured agent store (default: configured default agent).        |
| `--all-agents`       | Aggregate all configured agent stores.                                 |
| `--store <path>`     | Explicit store path (cannot combine with `--agent` or `--all-agents`). |
| `--active <minutes>` | Only show sessions updated within the past N minutes.                  |
| `--limit <n\|all>`   | Max rows to output (default `100`; `all` restores full output).        |
| `--json`             | Machine-readable output.                                               |
| `--verbose`          | Verbose logging.                                                       |

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
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/sessions/sessions.json" }
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
  prune cron run history, which automatically keeps the newest 2000 rows per job
  ([Cron configuration](/automation/cron-jobs#configuration)).
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

Flags:

| Flag                 | Description                                                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`          | Preview how many entries would be pruned/capped without writing. In text mode, prints a per-session action table (`Action`, `Key`, `Age`, `Model`, `Flags`) plus a summary grouped by session label.                                                                                                       |
| `--enforce`          | Apply maintenance even when `session.maintenance.mode` is `warn`.                                                                                                                                                                                                                                          |
| `--fix-missing`      | Remove legacy entries whose archived transcript artifacts are missing or header-only/empty, even if they would not normally age/count out yet.                                                                                                                                                             |
| `--fix-dm-scope`     | When `session.dmScope` is `main`, retire stale peer-keyed direct-DM rows left behind by earlier `per-peer`, `per-channel-peer`, or `per-account-channel-peer` routing. Use `--dry-run` first; applying removes those rows from SQLite and preserves their legacy transcript artifacts as deleted archives. |
| `--active-key <key>` | Protect a specific active key from disk-budget eviction. Durable external conversation pointers, such as group sessions and thread-scoped chat sessions, are also kept by age/count/disk-budget maintenance.                                                                                               |
| `--agent <id>`       | Run cleanup for one configured agent store.                                                                                                                                                                                                                                                                |
| `--all-agents`       | Run cleanup for all configured agent stores.                                                                                                                                                                                                                                                               |
| `--store <path>`     | Run against a specific legacy store selector path.                                                                                                                                                                                                                                                         |
| `--json`             | Print a JSON summary. With `--all-agents`, output includes one summary per store.                                                                                                                                                                                                                          |

When a Gateway is reachable, non-dry-run cleanup for configured agent stores is
sent through the Gateway so it shares the same session-store writer as runtime
traffic. Use `--store <path>` for explicit offline repair of a legacy store
selector.

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
- With `--max-lines <n>`, it truncates to the last `n` transcript lines and
  archives the prior transcript as a `.bak` sidecar.
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
  "archived": "/home/user/.openclaw/agents/main/sessions/transcripts/<id>.jsonl.bak",
  "kept": 200
}
```

## Related

- [Session config](/gateway/config-agents#session)
- [Session management](/concepts/session)
- [Compaction](/concepts/compaction)
- [CLI reference](/cli)
