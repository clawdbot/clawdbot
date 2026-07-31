---
summary: "Background memory consolidation with light, deep, and REM phases plus a Dream Diary"
title: "Dreaming"
sidebarTitle: "Dreaming"
read_when:
  - You want memory promotion to run automatically
  - You want to understand what each dreaming phase does
  - You want to tune consolidation without polluting MEMORY.md
---

Dreaming is the background memory consolidation system in `memory-core`. It moves strong short-term signals into durable memory while keeping the process explainable and reviewable.

<Note>
Dreaming is enabled by default. Set
`plugins.entries.memory-core.config.dreaming.enabled: false` to disable it.
</Note>

## What dreaming writes

- **Machine state** in `memory/.dreams/` (recall store, phase signals, ingestion checkpoints, locks).
- **Rewrite preimages** in SQLite-backed plugin state before an accepted `MEMORY.md` rewrite.
- **Human-readable output** in `DREAMS.md` (or an existing `dreams.md`) and optional phase report files under `memory/dreaming/<phase>/YYYY-MM-DD.md`.

Long-term promotion still writes only to `MEMORY.md`.
Each newly promoted entry carries trailing recall metadata derived from the
candidate: up to three concept tags in `<!-- trigger: phrase one, phrase two -->`
and a bounded `<!-- importance: N -->` value from 1 to 10. Consolidation keeps
existing annotated entries byte-for-byte unless it explicitly merges or
supersedes them.

## Phase model

Dreaming runs three cooperative phases per sweep, in order: light -> REM -> deep. These are internal implementation phases, not separate user-configured modes.

| Phase | Purpose                                   | Durable write     |
| ----- | ----------------------------------------- | ----------------- |
| Light | Sort and stage recent short-term material | No                |
| REM   | Reflect on themes and recurring ideas     | No                |
| Deep  | Score and promote durable candidates      | Yes (`MEMORY.md`) |

<AccordionGroup>
  <Accordion title="Light phase">
    - Reads recent short-term recall state, daily memory files, and redacted session transcripts when available.
    - Dedupes signals and stages candidate lines.
    - Writes a managed `## Light Sleep` block when storage includes inline output.
    - Records reinforcement signals for later deep ranking.
    - Never writes to `MEMORY.md`.

  </Accordion>
  <Accordion title="REM phase">
    - Builds theme and reflection summaries from recent short-term traces.
    - Writes a managed `## REM Sleep` block when storage includes inline output.
    - Records REM reinforcement signals used by deep ranking.
    - Never writes to `MEMORY.md`.

  </Accordion>
  <Accordion title="Deep phase">
    - Ranks candidates with weighted scoring and threshold gates (`minScore`, `minRecallCount`, `minUniqueQueries` must all pass).
    - Rehydrates snippets from live daily files before writing, so stale/deleted snippets are skipped.
    - Passes gated owner and agent-derived candidates to a consolidation subagent with the current `MEMORY.md`.
    - Rewrites `MEMORY.md` only when the result preserves enough prior entries, includes candidate source references, and fits the bootstrap budget.
    - Falls back to the previous append-only promotion path when the model is unavailable or the rewrite fails validation.
    - Writes a `## Deep Sleep` summary into `DREAMS.md` and optionally `memory/dreaming/deep/YYYY-MM-DD.md`.

  </Accordion>
</AccordionGroup>

## Session transcript ingestion

Dreaming can ingest redacted session transcripts into the dreaming corpus. Only interactive sessions are eligible. Cron, heartbeat, subagent, and unknown sessions stay out of durable candidate ingestion. Personal and sensitive content is redacted before ingestion, and runtime-marked recalled context is removed so recalled snippets cannot be learned again as new memory.

## Consolidation safety

The deterministic score, recall-count, and query-diversity thresholds remain
the candidate gate. Consolidation runs only after those gates pass.

Before building the consolidation prompt, `memory-core` removes candidates
whose indexed provenance is `untrusted` or `system`. This is a structural
taint gate, not a score penalty. Eligible candidates include their origin,
session kind, observation time, optional supersession key, and daily-note
source reference.

An accepted rewrite must:

- preserve prior entries within `phases.deep.maxPriorEntryLossFraction`
- include every promoted candidate's `Source: path#Lx-Ly` reference
- stay within the `MEMORY.md` bootstrap-safe file budget
- parse as the expected structured response

Before the file changes, the previous `MEMORY.md` is stored in SQLite-backed
plugin state. `DREAMS.md` receives added, merged, and superseded counts plus
short diff-style highlights. This makes each rewrite reviewable without
turning the Dream Diary into a promotion source.

Background consolidation is informed by sleep-time compute
(arXiv:2504.13171). The provenance and reflection boundary follows the durable
memory framing in the Generative Agents research.

## Dream Diary

Dreaming keeps a narrative **Dream Diary** in `DREAMS.md`. After each phase has enough material, `memory-core` runs a best-effort background subagent turn and appends a short diary entry, using the default runtime model unless `dreaming.model` is configured. If the configured model is unavailable, the diary run retries once with the session default model; trust or allowlist failures are not retried and stay visible in logs instead of silently falling back to a generic diary entry.

<Note>
The diary is for human reading in the Dreams UI, not a promotion source. Diary/report artifacts are excluded from short-term promotion; only grounded memory snippets are eligible to promote into `MEMORY.md`.
</Note>

There is also a grounded historical backfill lane for review and recovery work:

<AccordionGroup>
  <Accordion title="Backfill commands">
    - `memory rem-harness --path ... --grounded` previews grounded diary output from historical `YYYY-MM-DD.md` notes.
    - `memory rem-backfill --path ...` writes reversible grounded diary entries into `DREAMS.md`.
    - `memory rem-backfill --path ... --stage-short-term` stages grounded durable candidates into the same short-term evidence store the normal deep phase uses.
    - `memory rem-backfill --rollback` and `--rollback-short-term` remove those staged backfill artifacts without touching ordinary diary entries or live short-term recall.
    - `memory session-backfill --agent <id>` previews trusted candidates from the agent's retained session history, oldest unprocessed day first.
    - `memory session-backfill --agent <id> --apply` stages those candidates through the normal short-term store and writes reversible diary blocks without changing `MEMORY.md` or `USER.md`.
    - `memory session-backfill --agent <id> --rem` writes a deterministic grounded preview per day to `DREAMS.md` without staging candidates or calling a model.
    - `memory session-backfill --agent <id> --rollback` clears the shared grounded backfill candidates and diary blocks, including artifacts created by `rem-backfill`.

  </Accordion>
</AccordionGroup>

Session backfill uses canonical retained transcript identities, including
sessions preserved across rotation. Messages are bucketed in the configured
dreaming timezone and share live ingestion's tracked message hashes and signal
caps. Apply drains bounded batches to completion in one command. Rollback
removes generated artifacts plus the hashes and cursor progress owned by those
batches, allowing the same candidates to be staged again.
Foreign files supplied with `--archive-files` are treated conservatively. Their
embedded ownership fields are caller-controlled and therefore remain untrusted;
without an authenticated provenance contract, they cannot enter short-term
staging. Tool output, web content, and non-owner turns are excluded from the
canonical session path as well.

The Control UI exposes the same diary backfill/reset flow on the agent's Memory tab (Agents page) so you can inspect results in the dream scene before deciding whether grounded candidates deserve promotion. A distinct grounded Scene lane shows which staged short-term entries came from historical replay, which promoted items were grounded-led, and lets you clear only grounded-only staged entries without touching live short-term state.

## Deep ranking signals

Deep ranking uses six weighted base signals plus phase reinforcement:

| Signal              | Weight | Description                                       |
| ------------------- | ------ | ------------------------------------------------- |
| Relevance           | 0.30   | Average retrieval quality for the entry           |
| Frequency           | 0.24   | How many short-term signals the entry accumulated |
| Query diversity     | 0.15   | Distinct query/day contexts that surfaced it      |
| Recency             | 0.15   | Time-decayed freshness score                      |
| Consolidation       | 0.10   | Multi-day recurrence strength                     |
| Conceptual richness | 0.06   | Concept-tag density from snippet/path             |

Light and REM phase hits add a small recency-decayed boost from `memory/.dreams/phase-signals.json`.

## Scheduling

When enabled, `memory-core` auto-manages one cron job for a full dreaming sweep, deduped across the primary runtime workspace and any configured agent workspaces so subagent workspace fan-out does not exclude the main agent's `DREAMS.md` and memory state.

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

```text
/dreaming status
/dreaming on
/dreaming off
/dreaming help
```

`/dreaming on` and `/dreaming off` require owner status for channel callers or `operator.admin` for Gateway clients. `/dreaming status` and `/dreaming help` are read-only.

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

<ParamField path="enabled" type="boolean" default="true">
  Enable or disable the dreaming sweep.
</ParamField>
<ParamField path="phases.deep.maxPriorEntryLossFraction" type="number" default="0.25">
  Reject a consolidation rewrite when it removes more than this fraction of prior entries.
</ParamField>
<ParamField path="frequency" type="string" default="0 3 * * *">
  Cron cadence for the full dreaming sweep.
</ParamField>
<ParamField path="model" type="string">
  Optional Dream Diary subagent model override. Use a canonical `provider/model` value when also setting a subagent `allowedModels` allowlist.
</ParamField>
<ParamField path="phases.deep.maxPromotedSnippetTokens" type="number" default="160">
  Maximum estimated token count kept from each short-term recall snippet promoted into `MEMORY.md`. Ranking provenance remains visible.
</ParamField>

<Warning>
`dreaming.model` requires `plugins.entries.memory-core.subagent.allowModelOverride: true`. To restrict it, also set `plugins.entries.memory-core.subagent.allowedModels`. The automatic retry only covers model-unavailable errors; trust or allowlist failures stay visible in logs instead of falling back silently.
</Warning>

<Note>
Most phase policy, thresholds, and storage behavior are internal implementation details. See [Memory configuration reference](/reference/memory-config#dreaming) for the full key list.
</Note>

## Dreams UI

When enabled, the Gateway **Dreams** tab shows:

- current dreaming enabled state
- phase-level status and managed-sweep presence
- short-term, grounded, signal, and promoted-today counts
- next scheduled run timing
- a distinct grounded Scene lane for staged historical replay entries
- an expandable Dream Diary reader backed by `doctor.memory.dreamDiary`

When the bundled [`memory-wiki`](/plugins/memory-wiki) plugin is enabled, the
Diary view gains two more sub-tabs next to Dreams:

- **Imported Insights**: clustered insights surfaced by external-history
  imports (for example `openclaw wiki chatgpt import`), for review before any
  of it graduates into durable memory
- **Memory Wiki**: the compiled wiki the memory system can search and reason
  over — synthesis, entity, and concept pages (plus sources and reports that
  carry claims, open questions, or contradictions) with per-page counts, a
  full-vault breakdown, and inline page previews

Both sub-tabs show an enable hint instead when `memory-wiki` is off.

## Related

- [Memory](/concepts/memory)
- [Memory CLI](/cli/memory)
- [Memory configuration reference](/reference/memory-config)
- [Memory search](/concepts/memory-search)
