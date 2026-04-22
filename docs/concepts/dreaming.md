---
title: "Dreaming"
summary: "Background memory consolidation with light, deep, and REM phases plus a Dream Diary"
read_when:
  - You want memory promotion to run automatically
  - You want to understand what each dreaming phase does
  - You want to tune consolidation without polluting MEMORY.md
---

# Dreaming

Dreaming is the background memory consolidation system in `memory-core`.
It helps OpenClaw move strong short-term signals into durable memory while
keeping the process explainable and reviewable.

Dreaming is **opt-in** and disabled by default.

## What dreaming writes

Dreaming keeps two kinds of output:

- **Machine state** in `memory/.dreams/` (recall store, phase signals, ingestion checkpoints, locks).
- **Human-readable output** in `DREAMS.md` (or existing `dreams.md`) and optional phase report files under `memory/dreaming/<phase>/YYYY-MM-DD.md`.

Long-term promotion still writes only to `MEMORY.md`.

## Phase model

Dreaming uses three cooperative phases:

| Phase | Purpose                                   | Durable write     |
| ----- | ----------------------------------------- | ----------------- |
| Light | Sort and stage recent short-term material | No                |
| Deep  | Score and promote durable candidates      | Yes (`MEMORY.md`) |
| REM   | Reflect on themes and recurring ideas     | No                |

These phases are internal implementation details, not separate user-configured
"modes."

### Light phase

Light phase ingests recent daily memory signals and recall traces, dedupes them,
and stages candidate lines.

- Reads from short-term recall state, recent daily memory files, and redacted session transcripts when available.
- Writes a managed `## Light Sleep` block when storage includes inline output.
- Records reinforcement signals for later deep ranking.
- Never writes to `MEMORY.md`.

### Deep phase

Deep phase decides what becomes long-term memory.

- Ranks candidates using weighted scoring and threshold gates.
- Requires `minScore`, `minRecallCount`, and `minUniqueQueries` to pass.
- Rehydrates snippets from live daily files before writing, so stale/deleted snippets are skipped.
- Appends promoted entries to `MEMORY.md`.
- Writes a `## Deep Sleep` summary into `DREAMS.md` and optionally writes `memory/dreaming/deep/YYYY-MM-DD.md`.

### REM phase

REM phase extracts patterns and reflective signals.

- Builds theme and reflection summaries from recent short-term traces.
- Writes a managed `## REM Sleep` block when storage includes inline output.
- Records REM reinforcement signals used by deep ranking.
- Never writes to `MEMORY.md`.

## Session transcript ingestion

Dreaming can ingest redacted session transcripts into the dreaming corpus. When
transcripts are available, they are fed into the light phase alongside daily
memory signals and recall traces. Personal and sensitive content is redacted
before ingestion.

## Dream Diary

Dreaming also keeps a narrative **Dream Diary** in `DREAMS.md`.
After each phase has enough material, `memory-core` runs a best-effort background
subagent turn (using the default runtime model) and appends a short diary entry.

This diary is for human reading in the Dreams UI, not a promotion source.
Dreaming-generated diary/report artifacts are excluded from short-term
promotion. Only grounded memory snippets are eligible to promote into
`MEMORY.md`.

There is also a grounded historical backfill lane for review and recovery work:

- `memory rem-harness --path ... --grounded` previews grounded diary output from historical `YYYY-MM-DD.md` notes.
- `memory rem-backfill --path ...` writes reversible grounded diary entries into `DREAMS.md`.
- `memory rem-backfill --path ... --stage-short-term` stages grounded durable candidates into the same short-term evidence store the normal deep phase already uses.
- `memory rem-backfill --rollback` and `--rollback-short-term` remove those staged backfill artifacts without touching ordinary diary entries or live short-term recall.

The Control UI exposes the same diary backfill/reset flow so you can inspect
results in the Dreams scene before deciding whether the grounded candidates
deserve promotion. The Scene also shows a distinct grounded lane so you can see
which staged short-term entries came from historical replay, which promoted
items were grounded-led, and clear only grounded-only staged entries without
touching ordinary live short-term state.

## Deep ranking signals

Deep ranking uses six weighted base signals plus phase reinforcement:

| Signal              | Weight | Description                                       |
| ------------------- | ------ | ------------------------------------------------- |
| Frequency           | 0.24   | How many short-term signals the entry accumulated |
| Relevance           | 0.30   | Average retrieval quality for the entry           |
| Query diversity     | 0.15   | Distinct query/day contexts that surfaced it      |
| Recency             | 0.15   | Time-decayed freshness score                      |
| Consolidation       | 0.10   | Multi-day recurrence strength                     |
| Conceptual richness | 0.06   | Concept-tag density from snippet/path             |

Light and REM phase hits add a small recency-decayed boost from
`memory/.dreams/phase-signals.json`.

## Scheduling

When enabled, `memory-core` auto-manages one cron job for a full dreaming
sweep. Each sweep runs phases in order: light -> REM -> deep.

Default cadence behavior:

| Setting              | Default     |
| -------------------- | ----------- |
| `dreaming.frequency` | `0 3 * * *` |

## Quick start

Enable dreaming:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

Enable dreaming with a custom sweep cadence:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true,
            "timezone": "America/Los_Angeles",
            "frequency": "0 */6 * * *"
          }
        }
      }
    }
  }
}
```

## Slash command

```
/dreaming status
/dreaming on
/dreaming off
/dreaming help
```

## CLI workflow

Use CLI promotion for preview or manual apply:

```bash
openclaw memory promote
openclaw memory promote --apply
openclaw memory promote --limit 5
openclaw memory status --deep
```

Manual `memory promote` uses deep-phase thresholds by default unless overridden
with CLI flags.

Explain why a specific candidate would or would not promote:

```bash
openclaw memory promote-explain "router vlan"
openclaw memory promote-explain "router vlan" --json
```

Preview REM reflections, candidate truths, and deep promotion output without
writing anything:

```bash
openclaw memory rem-harness
openclaw memory rem-harness --json
```

## Key defaults

All settings live under `plugins.entries.memory-core.config.dreaming`.

| Key         | Default     |
| ----------- | ----------- |
| `enabled`   | `false`     |
| `frequency` | `0 3 * * *` |

Phase policy, thresholds, and storage behavior are internal implementation
details (not user-facing config).

See [Memory configuration reference](/reference/memory-config#dreaming)
for the full key list.

## Dreams UI

When enabled, the Gateway **Dreams** tab shows:

- current dreaming enabled state
- phase-level status and managed-sweep presence
- short-term, grounded, signal, and promoted-today counts
- next scheduled run timing
- a distinct grounded Scene lane for staged historical replay entries
- an expandable Dream Diary reader backed by `doctor.memory.dreamDiary`

## Troubleshooting

### Dreaming never runs (status shows blocked)

The managed dreaming cron rides the default agent's heartbeat. If heartbeat is not firing for that agent, the cron enqueues a system event that nobody consumes and dreaming silently does not run. Both `openclaw memory status` and `/dreaming status` will report `blocked` in that case and name the agent whose heartbeat is the blocker.

Two common causes:

- Another agent declares an explicit `heartbeat:` block. When any entry in `agents.list` has its own `heartbeat` block, only those agents heartbeat — the defaults stop applying to everyone else, so the default agent can go silent. Move the heartbeat settings to `agents.defaults.heartbeat`, or add an explicit `heartbeat` block on the default agent. See [Scope and precedence](/gateway/heartbeat#scope-and-precedence).
- `heartbeat.every` is `0`, empty, or unparseable. The cron has no interval to schedule against, so the heartbeat is effectively disabled. Set `every` to a positive duration such as `30m`. See [Defaults](/gateway/heartbeat#defaults).

## Related

- [Heartbeat](/gateway/heartbeat)
- [Memory](/concepts/memory)
- [Memory Search](/concepts/memory-search)
- [memory CLI](/cli/memory)
- [Memory configuration reference](/reference/memory-config)
