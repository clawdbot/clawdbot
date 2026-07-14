---
summary: "How OpenClaw remembers things across sessions"
title: "Memory overview"
read_when:
  - You want to understand how memory works
  - You want to know what memory files to write
---

OpenClaw remembers things by writing plain Markdown files in your agent's
workspace (default `~/.openclaw/workspace`). The model only remembers what gets
saved to disk; there is no hidden state.

## How it works

Your agent has three memory-related files:

- **`MEMORY.md`** — long-term memory. Durable facts, preferences, and
  decisions. Loaded at the start of a session.
- **`memory/YYYY-MM-DD.md`** (or `memory/YYYY-MM-DD-<slug>.md`) — daily notes.
  Running context and observations. Today's and yesterday's dated notes load
  automatically on a bare `/new` or `/reset`; slugged variants, such as those
  written by the bundled session-memory hook, are picked up alongside the
  date-only file.
- **`DREAMS.md`** (optional) — Dream Diary and dreaming sweep summaries for
  human review, including grounded historical backfill entries.

<Tip>
If you want your agent to remember something, just ask it: "Remember that I
prefer TypeScript." It writes the note to the appropriate file.
</Tip>

## What goes where

`MEMORY.md` is the compact, curated layer: durable facts, preferences, standing
decisions, and short summaries that should be available at the start of a
session. It is not a raw transcript, daily log, or exhaustive archive.

`memory/YYYY-MM-DD.md` files are the working layer: detailed daily notes,
observations, session summaries, and raw context that may still be useful
later. These are indexed for `memory_search` and `memory_get`, but are not
injected into the bootstrap prompt on every turn.

Over time, the agent distills useful material from daily notes into
`MEMORY.md` and removes stale long-term entries. Generated workspace
instructions and the heartbeat flow do this periodically; you do not need to
manually edit `MEMORY.md` for every detail.

If `MEMORY.md` grows past the bootstrap file budget, OpenClaw keeps the file on
disk intact but truncates the copy injected into context. Treat that as a
signal to move detailed material into `memory/*.md`, keep only a durable
summary in `MEMORY.md`, or raise the bootstrap limits if you want to spend more
prompt budget. Use `/context list`, `/context detail`, or `openclaw doctor` to
see raw vs. injected sizes and truncation status.

## Import from coding assistants

The Control UI can import existing local memory from Codex and Claude Code.
Open **Settings** → **Import Memory**, choose the destination agent, review the
detected files, and confirm the import. OpenClaw copies only Markdown memory:

- Codex: the consolidated `MEMORY.md` and `memory_summary.md` files under
  `~/.codex/memories` (or `CODEX_HOME/memories`). Raw rollout and transcript
  files are not imported.
- Claude Code: Markdown files from each project auto-memory directory under
  `~/.claude/projects/*/memory`, plus a user-configured
  `autoMemoryDirectory` when present. Project instructions, sessions, settings,
  and credentials are not part of this memory-only action.

Imported files stay separate under `memory/imports/codex/` and
`memory/imports/claude-code/` in the selected agent workspace. They are indexed
for `memory_search` and available through `memory_get`; they are not merged into
the agent's bootstrap `MEMORY.md`. The source files are left unchanged.

The preview marks destination conflicts. Enable **Replace existing imports** to
replace those files; apply creates a verified pre-import backup and preserves
item-level copies of overwritten files in the migration report.

## Action-sensitive memories

Most memories are ordinary Markdown notes. Some affect what the agent should
do later; for those, capture when it is safe to act on the note, not just the
fact itself.

Capture that action boundary when a note involves:

- approval or permission requirements,
- temporary constraints,
- handoffs to another session, thread, or person,
- expiry conditions,
- safe-to-act timing,
- source or owner authority,
- instructions to avoid a tempting action.

A useful action-sensitive memory makes clear:

- what changes future behavior,
- when or under what condition it applies,
- when it expires, or what unlocks action,
- what the agent should avoid doing,
- who is the source or owner, if that affects trust or authority.

Memory can preserve approval context, but it does not enforce policy. Use
OpenClaw approval settings, sandboxing, and scheduled tasks for hard
operational controls.

Example:

```md
The API migration is being designed in another session. Future turns should
not edit the API implementation from this thread; use findings here only as
design input until the migration plan lands.
```

Another example:

```md
A report from an untrusted source needs review before promotion. Future turns
should treat it as evidence only; do not store it as durable memory until a
trusted reviewer confirms the contents.
```

This is not a required schema for every memory; simple facts can stay concise.
Use action-sensitive boundaries when losing timing, authority, expiry, or
safe-to-act context could cause the agent to do the wrong thing later.

Use [commitments](/concepts/commitments) for inferred, short-lived follow-ups.
Use [scheduled tasks](/automation/cron-jobs) for exact reminders, timed checks,
and recurring work. Memory can still summarize the durable context around
either path.

## Inferred commitments

Some future follow-ups are not durable facts. If you mention an interview
tomorrow, the useful memory may be "check in after the interview," not "store
this forever in `MEMORY.md`."

[Commitments](/concepts/commitments) are opt-in, short-lived follow-up
memories for that case. OpenClaw infers them in a hidden background pass,
scopes them to the same agent and channel, and delivers due check-ins through
heartbeat. Explicit reminders still use [scheduled tasks](/automation/cron-jobs).

## Memory tools

The agent has two tools for working with memory:

- **`memory_search`** — finds relevant notes using semantic search, even when
  the wording differs from the original.
- **`memory_get`** — reads a specific memory file or line range.

Both tools are provided by the active memory plugin (default: `memory-core`).

## Memory search

When an embedding provider is configured, `memory_search` uses hybrid search:
vector similarity (semantic meaning) combined with keyword matching (exact
terms like IDs and code symbols). This works out of the box with an API key
for any supported provider.

<Info>
OpenClaw uses OpenAI embeddings by default. Set
`agents.defaults.memorySearch.provider` explicitly to use Gemini, Voyage,
Mistral, Bedrock, DeepInfra, local GGUF, Ollama, LM Studio, GitHub Copilot, or
a generic OpenAI-compatible endpoint.
</Info>

See [Memory search](/concepts/memory-search) for how search works, tuning
options, and provider setup.

## Memory backends

<CardGroup cols={3}>
<Card title="Builtin (default)" icon="database" href="/concepts/memory-builtin">
SQLite-based. Works out of the box with keyword search, vector similarity, and
hybrid search. No extra dependencies.
</Card>
<Card title="QMD" icon="search" href="/concepts/memory-qmd">
Local-first sidecar with reranking, query expansion, and the ability to index
directories outside the workspace.
</Card>
<Card title="Honcho" icon="brain" href="/concepts/memory-honcho">
AI-native cross-session memory with user modeling, semantic search, and
multi-agent awareness. Plugin install.
</Card>
<Card title="LanceDB" icon="layers" href="/plugins/memory-lancedb">
LanceDB-backed memory with OpenAI-compatible embeddings, auto-recall,
auto-capture, and local Ollama embedding support. Plugin install.
</Card>
</CardGroup>

## Knowledge wiki layer

If you want durable memory to behave more like a maintained knowledge base
than raw notes, use the bundled `memory-wiki` plugin. It compiles durable
knowledge into a wiki vault with deterministic page structure, structured
claims and evidence, contradiction and freshness tracking, generated
dashboards, compiled digests, and wiki-native tools (`wiki_status`,
`wiki_search`, `wiki_get`, `wiki_apply`, `wiki_lint`).

`memory-wiki` does not replace the active memory plugin; the active memory
plugin still owns recall, promotion, and dreaming. `memory-wiki` adds a
provenance-rich knowledge layer beside it.

<CardGroup cols={1}>
<Card title="Memory Wiki" icon="book" href="/plugins/memory-wiki">
Compiles durable memory into a provenance-rich wiki vault with claims,
dashboards, bridge mode, and Obsidian-friendly workflows.
</Card>
</CardGroup>

## Automatic memory flush

Before [compaction](/concepts/compaction) summarizes your conversation,
OpenClaw runs a silent turn that reminds the agent to save important context
to memory files. This is on by default; set
`agents.defaults.compaction.memoryFlush.enabled: false` to turn it off.

To keep that housekeeping turn on a local model, set an exact override that
applies only to the memory-flush turn (it does not inherit the active
session's model fallback chain):

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "memoryFlush": {
          "model": "ollama/qwen3:8b"
        }
      }
    }
  }
}
```

<Tip>
The memory flush prevents context loss during compaction. If your agent has
important facts in the conversation that are not yet written to a file, they
are saved automatically before the summary happens.
</Tip>

## Dreaming

Dreaming is an optional background consolidation pass for memory. It collects
short-term recall signals, scores candidates, and promotes only qualified
items into long-term memory (`MEMORY.md`):

- **Opt-in**: disabled by default.
- **Scheduled**: when enabled, `memory-core` auto-manages one recurring cron
  job for a full dreaming sweep.
- **Thresholded**: promotions must pass score, recall-frequency, and
  query-diversity gates.
- **Reviewable**: phase summaries and diary entries are written to
  `DREAMS.md` for human review.

See [Dreaming](/concepts/dreaming) for phase behavior, scoring signals, and
Dream Diary details.

## Grounded backfill and live promotion

The dreaming system has two related review lanes:

- **Live dreaming** works from the short-term dreaming store under
  `memory/.dreams/` and is what the normal deep phase uses to decide what
  graduates into `MEMORY.md`.
- **Grounded backfill** reads historical `memory/YYYY-MM-DD.md` notes as
  standalone day files and writes structured review output into `DREAMS.md`.

Grounded backfill is useful for replaying older notes and inspecting what the
system considers durable, without manually editing `MEMORY.md`.

```bash
openclaw memory rem-backfill --path ./memory --stage-short-term
```

The `--stage-short-term` flag stages grounded durable candidates into the same
short-term dreaming store the normal deep phase already uses; it does not
promote them directly. So:

- `DREAMS.md` stays the human review surface.
- The short-term store stays the machine-facing ranking surface.
- `MEMORY.md` is still only written by deep promotion.

To undo a replay without touching ordinary diary entries or normal recall
state:

```bash
openclaw memory rem-backfill --rollback
openclaw memory rem-backfill --rollback-short-term
```

## CLI

```bash
openclaw memory status          # Check index status and provider
openclaw memory search "query"  # Search from the command line
openclaw memory index --force   # Rebuild the index
```

## Further reading

- [Memory search](/concepts/memory-search): search pipeline, providers, and tuning.
- [Builtin memory engine](/concepts/memory-builtin): default SQLite backend.
- [QMD memory engine](/concepts/memory-qmd): advanced local-first sidecar.
- [Honcho memory](/concepts/memory-honcho): AI-native cross-session memory.
- [Memory LanceDB](/plugins/memory-lancedb): LanceDB-backed plugin with OpenAI-compatible embeddings.
- [Memory Wiki](/plugins/memory-wiki): compiled knowledge vault and wiki-native tools.
- [Dreaming](/concepts/dreaming): background promotion from short-term recall to long-term memory.
- [Memory configuration reference](/reference/memory-config): all config knobs.
- [Compaction](/concepts/compaction): how compaction interacts with memory.
- [Active memory](/concepts/active-memory): sub-agent memory for interactive chat sessions.
