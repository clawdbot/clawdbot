---
summary: "memory-wiki: compiled knowledge vault with provenance, claims, dashboards, and bridge mode"
read_when:
  - You want persistent knowledge beyond plain MEMORY.md notes
  - You are configuring the bundled memory-wiki plugin
  - You want to understand wiki_search, wiki_get, or bridge mode
title: "Memory wiki"
---

`memory-wiki` is a bundled plugin that turns durable memory into a compiled
knowledge vault.

It does **not** replace the active memory plugin. The active memory plugin still
owns recall, promotion, indexing, and dreaming. `memory-wiki` sits beside it
and compiles durable knowledge into a navigable wiki with deterministic pages,
structured claims, provenance, dashboards, and machine-readable digests.

Use it when you want memory to behave more like a maintained knowledge layer and
less like a pile of Markdown files.

## What it adds

- A dedicated wiki vault with deterministic page layout
- Structured claim and evidence metadata, not just prose
- Page-level provenance, confidence, contradictions, and open questions
- Compiled digests for agent/runtime consumers
- Wiki-native search/get/apply/lint tools
- Optional bridge mode that imports public artifacts from the active memory plugin
- Optional Obsidian-friendly render mode and CLI integration

## How it fits with memory

Think of the split like this:

| Layer                                                   | Owns                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Active memory plugin (`memory-core`, QMD, Honcho, etc.) | Recall, semantic search, promotion, dreaming, memory runtime                               |
| `memory-wiki`                                           | Compiled wiki pages, provenance-rich syntheses, dashboards, wiki-specific search/get/apply |

If the active memory plugin exposes shared recall artifacts, OpenClaw can search
both layers in one pass with `memory_search corpus=all`.

When you need wiki-specific ranking, provenance, or direct page access, use the
wiki-native tools instead.

## Recommended hybrid pattern

A strong default for local-first setups is:

- QMD as the active memory backend for recall and broad semantic search
- `memory-wiki` in `bridge` mode for durable synthesized knowledge pages

That split works well because each layer stays focused:

- QMD keeps raw notes, session exports, and extra collections searchable
- `memory-wiki` compiles stable entities, claims, dashboards, and source pages

Practical rule:

- use `memory_search` when you want one broad recall pass across memory
- use `wiki_search` and `wiki_get` when you want provenance-aware wiki results
- use `memory_search corpus=all` when you want shared search to span both layers

If bridge mode reports zero exported artifacts, the active memory plugin is not
currently exposing public bridge inputs yet. Run `openclaw wiki doctor` first,
then confirm the active memory plugin supports public artifacts.

When bridge mode is active and `bridge.readMemoryArtifacts` is enabled,
`openclaw wiki status`, `openclaw wiki doctor`, and `openclaw wiki bridge
import` read through the running Gateway. That keeps CLI bridge checks aligned
with the runtime memory plugin context. If bridge is disabled or artifact reads
are turned off, those commands keep their local/offline behavior.

## Vault modes

`memory-wiki` supports three vault modes:

### `isolated`

Own vault, own sources, no dependency on `memory-core`.

Use this when you want the wiki to be its own curated knowledge store.

### `bridge`

Reads public memory artifacts and memory events from the active memory plugin
through public plugin SDK seams.

Use this when you want the wiki to compile and organize the memory plugin's
exported artifacts without reaching into private plugin internals.

Bridge mode can index:

- exported memory artifacts
- dream reports
- daily notes
- memory root files
- memory event logs

### `unsafe-local`

Explicit same-machine escape hatch for local private paths.

This mode is intentionally experimental and non-portable. Use it only when you
understand the trust boundary and specifically need local filesystem access that
bridge mode cannot provide.

## Vault layout

The plugin initializes a vault like this:

```text
<vault>/
  AGENTS.md
  WIKI.md
  index.md
  inbox.md
  entities/
  concepts/
  syntheses/
  sources/
  reports/
  _attachments/
  _views/
  .openclaw-wiki/
```

Managed content stays inside generated blocks. Human note blocks are preserved.

The main page groups are:

- `sources/` for imported raw material and bridge-backed pages
- `entities/` for durable things, people, systems, projects, and objects
- `concepts/` for ideas, abstractions, patterns, and policies
- `syntheses/` for compiled summaries and maintained rollups
- `reports/` for generated dashboards

## Structured claims and evidence

Pages can carry structured `claims` frontmatter, not just freeform text.

Each claim can include:

- `id`
- `text`
- `status`
- `confidence`
- `evidence[]`
- `updatedAt`

Evidence entries can include:

- `kind`
- `sourceId`
- `path`
- `lines`
- `weight`
- `confidence`
- `privacyTier`
- `note`
- `updatedAt`

This is what makes the wiki act more like a belief layer than a passive note
dump. Claims can be tracked, scored, contested, and resolved back to sources.

## Agent-facing entity metadata

Entity pages can also carry routing metadata for agent use. This is generic
frontmatter, so it works for people, teams, systems, projects, or any other
entity type.

Common fields include:

- `entityType`: for example `person`, `team`, `system`, or `project`
- `canonicalId`: stable identity key used across aliases and imports
- `aliases`: names, handles, or labels that should resolve to the same page
- `privacyTier`: `public`, `local-private`, `sensitive`, or `confirm-before-use`
- `bestUsedFor` / `notEnoughFor`: compact routing hints
- `lastRefreshedAt`: source-refresh timestamp separate from page edit time
- `personCard`: optional person-specific routing card with handles, socials,
  emails, timezone, lane, ask-for, avoid-asking-for, confidence, and privacy
- `relationships`: typed edges to related pages with target, kind, weight,
  confidence, evidence kind, privacy tier, and note

For a people wiki, the agent should usually start with
`reports/person-agent-directory.md`, then open the person page with `wiki_get`
before using contact details or inferred facts.

Example:

```yaml
pageType: entity
entityType: person
id: entity.brad-groux
canonicalId: maintainer.brad-groux
aliases:
  - Brad
  - bgroux
privacyTier: local-private
bestUsedFor:
  - Microsoft Teams and Azure routing
notEnoughFor:
  - legal approval
lastRefreshedAt: "2026-04-29T00:00:00.000Z"
personCard:
  handles:
    - "@bgroux"
  socials:
    - "https://x.example/bgroux"
  emails:
    - brad@example.com
  timezone: America/Chicago
  lane: Microsoft ecosystem
  askFor:
    - Teams rollout questions
  avoidAskingFor:
    - unrelated billing decisions
  confidence: 0.8
  privacyTier: confirm-before-use
relationships:
  - targetId: entity.alice
    targetTitle: Alice
    kind: collaborates-with
    confidence: 0.7
    evidenceKind: discrawl-stat
claims:
  - id: claim.brad.teams
    text: Brad is useful for Microsoft Teams routing.
    status: supported
    confidence: 0.9
    evidence:
      - kind: maintainer-whois
        sourceId: source.maintainers
        privacyTier: local-private
```

## Compile pipeline

The compile step reads wiki pages, normalizes summaries, and emits stable
machine-facing artifacts under:

- `.openclaw-wiki/cache/agent-digest.json`
- `.openclaw-wiki/cache/claims.jsonl`

These digests exist so agents and runtime code do not have to scrape Markdown
pages.

Compiled output also powers:

- first-pass wiki indexing for search/get flows
- claim-id lookup back to owning pages
- compact prompt supplements
- report/dashboard generation

## Dashboards and health reports

When `render.createDashboards` is enabled, compile maintains dashboards under
`reports/`.

Built-in reports include:

- `reports/open-questions.md`
- `reports/contradictions.md`
- `reports/low-confidence.md`
- `reports/claim-health.md`
- `reports/stale-pages.md`
- `reports/person-agent-directory.md`
- `reports/relationship-graph.md`
- `reports/provenance-coverage.md`
- `reports/privacy-review.md`

These reports track things like:

- contradiction note clusters
- competing claim clusters
- claims missing structured evidence
- low-confidence pages and claims
- stale or unknown freshness
- pages with unresolved questions
- person/entity routing cards
- structured relationship edges
- evidence class coverage
- non-public privacy tiers that need review before use

## Search and retrieval

`memory-wiki` supports two search backends:

- `shared`: use the shared memory search flow when available
- `local`: search the wiki locally

It also supports three corpora:

- `wiki`
- `memory`
- `all`

Important behavior:

- `wiki_search` and `wiki_get` use compiled digests as a first pass when possible
- claim ids can resolve back to the owning page
- contested/stale/fresh claims influence ranking
- provenance labels can survive into results
- search mode can bias ranking for person lookup, question routing, source
  evidence, or raw claims

Practical rule:

- use `memory_search corpus=all` for one broad recall pass
- use `wiki_search` + `wiki_get` when you care about wiki-specific ranking,
  provenance, or page-level belief structure

Search modes:

- `auto`: balanced default
- `find-person`: boost person-like entities, aliases, handles, socials, and
  canonical IDs
- `route-question`: boost agent cards, ask-for hints, best-used-for hints, and
  relationship context
- `source-evidence`: boost source pages and structured evidence metadata
- `raw-claim`: boost matching structured claims and return claim/evidence
  metadata in results

When a result matches a structured claim, `wiki_search` can return
`matchedClaimId`, `matchedClaimStatus`, `matchedClaimConfidence`,
`evidenceKinds`, and `evidenceSourceIds` in its details payload. Text output
also includes compact `Claim:` and `Evidence:` lines when available.

## Agent tools

The plugin registers these tools:

- `wiki_status`
- `wiki_search`
- `wiki_get`
- `wiki_apply`
- `wiki_lint`

What they do:

- `wiki_status`: current vault mode, health, Obsidian CLI availability
- `wiki_search`: search wiki pages and, when configured, shared memory corpora;
  accepts `mode` for person lookup, question routing, source evidence, or raw
  claim drilldown
- `wiki_get`: read a wiki page by id/path or fall back to shared memory corpus
- `wiki_apply`: narrow synthesis/metadata mutations without freeform page surgery
- `wiki_lint`: structural checks, provenance gaps, contradictions, open questions

The plugin also registers a non-exclusive memory corpus supplement, so shared
`memory_search` and `memory_get` can reach the wiki when the active memory
plugin supports corpus selection.

## Prompt and context behavior

When `context.includeCompiledDigestPrompt` is enabled, memory prompt sections
append a compact compiled snapshot from `agent-digest.json`.

That snapshot is intentionally small and high-signal:

- top pages only
- top claims only
- contradiction count
- question count
- confidence/freshness qualifiers

This is opt-in because it changes prompt shape and is mainly useful for context
engines or legacy prompt assembly that explicitly consume memory supplements.

## Configuration

Put config under `plugins.entries.memory-wiki.config`:

```json5
{
  plugins: {
    entries: {
      "memory-wiki": {
        enabled: true,
        config: {
          vaultMode: "isolated",
          vault: {
            path: "~/.openclaw/wiki/main",
            renderMode: "obsidian",
          },
          obsidian: {
            enabled: true,
            useOfficialCli: true,
            vaultName: "OpenClaw Wiki",
            openAfterWrites: false,
          },
          bridge: {
            enabled: false,
            readMemoryArtifacts: true,
            indexDreamReports: true,
            indexDailyNotes: true,
            indexMemoryRoot: true,
            followMemoryEvents: true,
          },
          ingest: {
            autoCompile: true,
            maxConcurrentJobs: 1,
            allowUrlIngest: true,
          },
          search: {
            backend: "shared",
            corpus: "wiki",
          },
          context: {
            includeCompiledDigestPrompt: false,
          },
          render: {
            preserveHumanBlocks: true,
            createBacklinks: true,
            createDashboards: true,
          },
        },
      },
    },
  },
}
```

Key toggles:

- `vaultMode`: `isolated`, `bridge`, `unsafe-local`
- `vault.renderMode`: `native` or `obsidian`
- `bridge.readMemoryArtifacts`: import active memory plugin public artifacts
- `bridge.followMemoryEvents`: include event logs in bridge mode
- `search.backend`: `shared` or `local`
- `search.corpus`: `wiki`, `memory`, or `all`
- `context.includeCompiledDigestPrompt`: append compact digest snapshot to memory prompt sections
- `render.createBacklinks`: generate deterministic related blocks
- `render.createDashboards`: generate dashboard pages

### Example: QMD + bridge mode

Use this when you want QMD for recall and `memory-wiki` for a maintained
knowledge layer:

```json5
{
  memory: {
    backend: "qmd",
      "memory-wiki": {
        enabled: true,
        config: {
          vaultMode: "bridge",
          bridge: {
            enabled: true,
            readMemoryArtifacts: true,
            indexDreamReports: true,
            indexDailyNotes: true,
            indexMemoryRoot: true,
            followMemoryEvents: true,
          },
          search: {
            backend: "shared",
            corpus: "all",
          },
          context: {
            includeCompiledDigestPrompt: false,
          },
        },
      },
    },
  },
}
```

This keeps:

- QMD in charge of active memory recall
- `memory-wiki` focused on compiled pages and dashboards
- prompt shape unchanged until you intentionally enable compiled digest prompts

## CLI

`memory-wiki` also exposes a top-level CLI surface:

```bash
openclaw wiki status
openclaw wiki doctor
openclaw wiki init
openclaw wiki ingest ./notes/alpha.md
openclaw wiki compile
openclaw wiki lint
openclaw wiki search "alpha"
openclaw wiki get entity.alpha
openclaw wiki apply synthesis "Alpha Summary" --body "..." --source-id source.alpha
openclaw wiki bridge import
openclaw wiki obsidian status
```

See [CLI: wiki](/cli/wiki) for the full command reference.

## Obsidian support

When `vault.renderMode` is `obsidian`, the plugin writes Obsidian-friendly
Markdown and can optionally use the official `obsidian` CLI.

Supported workflows include:

- status probing
- vault search
- opening a page
- invoking an Obsidian command
- jumping to the daily note

This is optional. The wiki still works in native mode without Obsidian.

## Recommended workflow

1. Keep your active memory plugin for recall/promotion/dreaming.
2. Enable `memory-wiki`.
3. Start with `isolated` mode unless you explicitly want bridge mode.
4. Use `wiki_search` / `wiki_get` when provenance matters.
5. Use `wiki_apply` for narrow syntheses or metadata updates.
6. Run `wiki_lint` after meaningful changes.
7. Turn on dashboards if you want stale/contradiction visibility.

## Related docs

- [Memory Overview](/concepts/memory)
- [CLI: memory](/cli/memory)
- [CLI: wiki](/cli/wiki)
- [Plugin SDK overview](/plugins/sdk-overview)
