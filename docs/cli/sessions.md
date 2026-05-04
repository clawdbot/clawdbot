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

Gateway `sessions.list` responses are bounded by default so large long-lived
stores cannot monopolize the Gateway event loop. Pass an explicit positive
`limit` from RPC clients when a different result window is needed; responses
include `totalCount`, `limitApplied`, and `hasMore` when callers need to show
that more rows exist.

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --verbose
openclaw sessions --json
```

Scope selection:

- default: configured default agent store
- `--verbose`: verbose logging
- `--agent <id>`: one configured agent store
- `--all-agents`: aggregate all configured agent stores
- `--store <path>`: explicit store path (cannot be combined with `--agent` or `--all-agents`)

Export a trajectory bundle for a stored session:

```bash
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --workspace .
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --output bug-123 --json
```

This is the command path used by the `/export-trajectory` slash command after
the owner approves the exec request. The output directory is always resolved
inside `.openclaw/trajectory-exports/` under the selected workspace.

`openclaw sessions --all-agents` reads configured agent stores. Gateway and ACP
session discovery are broader: they also include disk-only stores found under
the default `agents/` root or a templated `session.store` root. Those
discovered stores must resolve to regular `sessions.json` files inside the
agent root; symlinks and out-of-root paths are skipped.

JSON examples:

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
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-6" }
  ]
}
```

## Cleanup maintenance

Run maintenance now (instead of waiting for the next write cycle):

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:direct:123"
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` uses `session.maintenance` settings from config:

- Scope note: `openclaw sessions cleanup` maintains session stores, transcripts, and trajectory sidecars. It does not prune cron run logs (`cron/runs/<jobId>.jsonl`), which are managed by `cron.runLog.maxBytes` and `cron.runLog.keepLines` in [Cron configuration](/automation/cron-jobs#configuration) and explained in [Cron maintenance](/automation/cron-jobs#maintenance).

- `--dry-run`: preview how many entries would be pruned/capped without writing.
  - In text mode, dry-run prints a per-session action table (`Action`, `Key`, `Age`, `Model`, `Flags`) so you can see what would be kept vs removed.
- `--enforce`: apply maintenance even when `session.maintenance.mode` is `warn`.
- `--fix-missing`: remove entries whose transcript files are missing, even if they would not normally age/count out yet.
- `--active-key <key>`: protect a specific active key from disk-budget eviction. Durable external conversation pointers, such as group sessions and thread-scoped chat sessions, are also kept by age/count/disk-budget maintenance.
- `--agent <id>`: run cleanup for one configured agent store.
- `--all-agents`: run cleanup for all configured agent stores.
- `--store <path>`: run against a specific `sessions.json` file.
- `--json`: print a JSON summary. With `--all-agents`, output includes one summary per store.

When a Gateway is reachable, non-dry-run cleanup for configured agent stores is
sent through the Gateway so it shares the same session-store writer as runtime
traffic. Use `--store <path>` for explicit offline repair of a store file.

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
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.openclaw/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

Related:

- Session config: [Configuration reference](/gateway/config-agents#session)

## Related

- [CLI reference](/cli)
- [Session management](/concepts/session)
