---
summary: "Background memory consolidation with light, deep, and REM phases plus a Dream Diary"
title: "Dreaming"
sidebarTitle: "Dreaming"
read_when:
  - You want memory promotion to run automatically
  - You want to understand what each dreaming phase does
  - You want to tune consolidation without polluting MEMORY.md
---

Dreaming is the background memory consolidation system in `memory-core`. It helps OpenClaw move strong short-term signals into durable memory while keeping the process explainable and reviewable.

<Note>
Dreaming is **opt-in** and disabled by default.
</Note>

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

These phases are internal implementation details, not separate user-configured "modes."

<AccordionGroup>
  <Accordion title="Light phase">
    Light phase ingests recent daily memory signals and recall traces, dedupes them, and stages candidate lines.

    - Reads from short-term recall state, recent daily memory files, and redacted session transcripts when available.
    - Writes a managed `## Light Sleep` block when storage includes inline output.
    - Records reinforcement signals for later deep ranking.
    - Never writes to `MEMORY.md`.

  </Accordion>
  <Accordion title="Deep phase">
    Deep phase decides what becomes long-term memory.

    - Ranks candidates using weighted scoring and threshold gates.
    - Requires `minScore`, `minRecallCount`, and `minUniqueQueries` to pass.
    - Rehydrates snippets from live daily files before writing, so stale/deleted snippets are skipped.
    - Appends promoted entries to `MEMORY.md`.
    - Writes a `## Deep Sleep` summary into `DREAMS.md` and optionally writes `memory/dreaming/deep/YYYY-MM-DD.md`.

  </Accordion>
  <Accordion title="REM phase">
    REM phase extracts patterns and reflective signals.

    - Builds theme and reflection summaries from recent short-term traces.
    - Writes a managed `## REM Sleep` block when storage includes inline output.
    - Records REM reinforcement signals used by deep ranking.
    - Never writes to `MEMORY.md`.

  </Accordion>
</AccordionGroup>

## Session transcript ingestion

Dreaming can ingest redacted session transcripts into the dreaming corpus. When transcripts are available, they are fed into the light phase alongside daily memory signals and recall traces. Personal and sensitive content is redacted before ingestion.

## Dream Diary

Dreaming also keeps a narrative **Dream Diary** in `DREAMS.md`. After each phase has enough material, `memory-core` runs a best-effort background subagent turn and appends a short diary entry. It uses the default runtime model unless `dreaming.model` is configured. If the configured model is unavailable, Dream Diary retries once with the session default model.

<Note>
This diary is for human reading in the Dreams UI, not a promotion source. Dreaming-generated diary/report artifacts are excluded from short-term promotion. Only grounded memory snippets are eligible to promote into `MEMORY.md`.
</Note>

There is also a grounded historical backfill lane for review and recovery work:

<AccordionGroup>
  <Accordion title="Backfill commands">
    - `memory rem-harness --path ... --grounded` previews grounded diary output from historical `YYYY-MM-DD.md` notes.
    - `memory rem-backfill --path ...` writes reversible grounded diary entries into `DREAMS.md`.
    - `memory rem-backfill --path ... --stage-short-term` stages grounded durable candidates into the same short-term evidence store the normal deep phase already uses.
    - `memory rem-backfill --rollback` and `--rollback-short-term` remove those staged backfill artifacts without touching ordinary diary entries or live short-term recall.

  </Accordion>
</AccordionGroup>

The Control UI exposes the same diary backfill/reset flow so you can inspect results in the Dreams scene before deciding whether the grounded candidates deserve promotion. The Scene also shows a distinct grounded lane so you can see which staged short-term entries came from historical replay, which promoted items were grounded-led, and clear only grounded-only staged entries without touching ordinary live short-term state.

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

Light and REM phase hits add a small recency-decayed boost from `memory/.dreams/phase-signals.json`.

## Scheduling

When enabled, `memory-core` auto-manages one cron job for a full dreaming sweep. Each sweep runs phases in order: light → REM → deep.

The sweep includes the primary runtime workspace and any configured agent workspaces, deduped by path, so subagent workspace fan-out does not exclude the main agent's `DREAMS.md` and memory state.

Default cadence behavior:

| Setting              | Default       |
| -------------------- | ------------- |
| `dreaming.frequency` | `0 3 * * *`   |
| `dreaming.model`     | default model |

## Quick start

<Tabs>
  <Tab title="Enable dreaming">
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
  </Tab>
  <Tab title="Custom sweep cadence">
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
  </Tab>
</Tabs>

## Slash command

```
/dreaming status
/dreaming on
/dreaming off
/dreaming help
```

## CLI workflow

<Tabs>
  <Tab title="Promotion preview / apply">
    ```bash
    openclaw memory promote
    openclaw memory promote --apply
    openclaw memory promote --limit 5
    openclaw memory status --deep
    ```

    Manual `memory promote` uses deep-phase thresholds by default unless overridden with CLI flags.

  </Tab>
  <Tab title="Explain promotion">
    Explain why a specific candidate would or would not promote:

    ```bash
    openclaw memory promote-explain "router vlan"
    openclaw memory promote-explain "router vlan" --json
    ```

  </Tab>
  <Tab title="REM harness preview">
    Preview REM reflections, candidate truths, and deep promotion output without writing anything:

    ```bash
    openclaw memory rem-harness
    openclaw memory rem-harness --json
    ```

  </Tab>
</Tabs>

## Key defaults

All settings live under `plugins.entries.memory-core.config.dreaming`.

<ParamField path="enabled" type="boolean" default="false">
  Enable or disable the dreaming sweep.
</ParamField>
<ParamField path="frequency" type="string" default="0 3 * * *">
  Cron cadence for the full dreaming sweep.
</ParamField>
<ParamField path="model" type="string">
  Optional Dream Diary subagent model override. Use a canonical `provider/model` value when also setting a subagent `allowedModels` allowlist.
</ParamField>

<Warning>
`dreaming.model` requires `plugins.entries.memory-core.subagent.allowModelOverride: true`. To restrict it, also set `plugins.entries.memory-core.subagent.allowedModels`. Trust or allowlist failures stay visible instead of falling back silently; the retry only covers model-unavailable errors.
</Warning>

<Note>
Phase policy, thresholds, and storage behavior are internal implementation details (not user-facing config). See [Memory configuration reference](/reference/memory-config#dreaming) for the full key list.
</Note>

## Dreams UI

When enabled, the Gateway **Dreams** tab shows:

- current dreaming enabled state
- phase-level status and managed-sweep presence
- short-term, grounded, signal, and promoted-today counts
- next scheduled run timing
- a distinct grounded Scene lane for staged historical replay entries
- an expandable Dream Diary reader backed by `doctor.memory.dreamDiary`

## Dreaming never runs: status shows blocked

If `openclaw memory status` reports `Dreaming status: blocked`, the managed cron exists but the default agent heartbeat is not firing. Check that heartbeat is enabled for the default agent and that its target is not `none`, then run `openclaw memory status --deep` again after the next heartbeat interval.

## Related

- [Memory](/concepts/memory)
- [Memory CLI](/cli/memory)
- [Memory configuration reference](/reference/memory-config)
- [Memory search](/concepts/memory-search)
