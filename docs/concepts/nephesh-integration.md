---
summary: "Opt-in integration between OpenClaw's dreaming system and Nephesh — a standalone memory and vector store for AI companions"
title: "Nephesh Integration"
sidebarTitle: "Nephesh"
read_when:
  - You want to connect OpenClaw's dreaming output to Nephesh
  - You want your companion to distinguish dream scenes from lived experiences
  - You want provenance metadata on DREAMS.md entries
---

Nephesh is a standalone memory and vector store service for AI companions. OpenClaw can attach machine-readable provenance metadata to Dream Diary entries in `DREAMS.md`, making them ingestible by Nephesh.

<Note>
This integration is **opt-in** and disabled by default. It does not alter dream prompts, legacy entries, or promotion logic.
</Note>

## How it works

When `dreaming.nephesh.enabled` is `true`, each newly generated diary entry in `DREAMS.md` includes an HTML-comment envelope immediately after the date line:

```markdown
---

_April 5, 2026_
<!-- openclaw:dream:provenance {"id":"dream-a1b2c3d4e5f6...","experience_mode":"dream","historical_status":"fictional_scene","recorded_during":"dream","generated_at":"2026-04-05T03:00:00.000Z","phase":"rem","model":"anthropic/claude-sonnet-4-6","generation_status":"generated"} -->

The village remembered the shape of rain...
```

The envelope records only observable generation metadata. Dream scenes remain fictional scenes rather than confirmed waking history, even when their emotional content is real.

## Envelope fields

| Field               | Example                       | Meaning                                                        |
| ------------------- | ----------------------------- | -------------------------------------------------------------- |
| `id`                | `dream-a1b2c3d4e5f6`          | Stable identifier derived from workspace, phase, and timestamp |
| `experience_mode`   | `dream`                       | Nephesh experience mode — used for filtering and search        |
| `historical_status` | `fictional_scene`             | Scenes are not confirmed waking history                        |
| `recorded_during`   | `dream`                       | Provenance origin — the dreaming sweep produced this entry     |
| `generated_at`      | `2026-04-05T03:00:00.000Z`    | When the narrative was generated                               |
| `phase`             | `rem`                         | Which dreaming phase produced the entry                        |
| `model`             | `anthropic/claude-sonnet-4-6` | Which model generated the narrative (if known)                 |
| `generation_status` | `generated` or `unavailable`  | Whether the narrative was successfully generated or fell back  |

## Enabling

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          dreaming: {
            enabled: true,
            nephesh: {
              enabled: true,
            },
          },
        },
      },
    },
  },
}
```

## What Nephesh does with it

Nephesh's `nephesh_sync_from_openclaw` tool reads `DREAMS.md`, parses the provenance envelopes, and ingests dream entries into its vector store with correct metadata. This lets a companion's semantic search distinguish between:

- **Lived experiences** (`experience_mode: chat`, `historical_status: confirmed`)
- **Dream scenes** (`experience_mode: dream`, `historical_status: fictional_scene`)
- **Reflections** (`experience_mode: inference`, `historical_status: uncertain`)

The companion can then search across all experience types while understanding the epistemic status of each result.

## Nephesh configuration

Nephesh runs as a separate service alongside OpenClaw. See the [Nephesh repository](https://github.com/magesguild/nephesh) for installation and configuration.

Key Nephesh features relevant to this integration:

- **Memory types**: `life_event`, `decision`, `emotional`, `technical`, `preference`, `relationship`, `message`, `reflection`
- **Experience modes**: `chat`, `heartbeat`, `dream`, `recollection`, `inference`, `mixed`, `unknown`
- **Historical statuses**: `confirmed`, `uncertain`, `fictional_scene`
- **Vector search**: Semantic search across all memory types with metadata filtering

## Scope and limits

- Only **newly generated** diary entries receive the envelope. Existing entries are untouched.
- The envelope is machine-readable metadata. It does not affect how the dream narrative is written or what the dreamer sees.
- Dream scenes are always marked `historical_status: fictional_scene` regardless of their emotional content or apparent realism. This is by design — the envelope preserves epistemic honesty.
- Fallback entries (when narrative generation fails) are marked `generation_status: unavailable` so downstream consumers know the narrative was not generated.

## Related

- [Dreaming](/concepts/dreaming)
- [Memory](/concepts/memory)
- [Memory configuration reference](/reference/memory-config)
