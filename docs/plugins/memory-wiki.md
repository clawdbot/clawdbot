---
summary: "memory-wiki: compiled knowledge vault with provenance, claims, dashboards, and bridge mode"
read_when:
  - You want persistent knowledge beyond plain MEMORY.md notes
  - You are configuring the bundled memory-wiki plugin
  - You need separate wiki vaults for agents in one Gateway
  - You want to understand wiki_search, wiki_get, or bridge mode
title: "Memory wiki"
---

`memory-wiki` is a bundled plugin that compiles durable knowledge into a
navigable wiki: deterministic pages, structured claims with evidence,
provenance, dashboards, and machine-readable digests.

It does not replace the active memory plugin. Recall, promotion, indexing, and
dreaming stay owned by the configured memory plugin (`memory-core`, Honcho,
and others). `memory-wiki` sits beside it and compiles
knowledge into a maintained wiki layer.

Enable the plugin before using its CLI, tools, or runtime integration:

```bash
openclaw plugins enable memory-wiki
openclaw gateway restart
```

| Layer                | Owns                                                                              |
| -------------------- | --------------------------------------------------------------------------------- |
| Active memory plugin | Recall, semantic search, promotion, dreaming, memory runtime                      |
| `memory-wiki`        | Compiled wiki pages, provenance-rich syntheses, dashboards, wiki search/get/apply |

Practical rule:

- `memory_search` for one broad recall pass across whatever corpora are configured
- `wiki_search` / `wiki_get` when you want wiki-specific ranking, provenance, or page-level belief structure
- `memory_search corpus=all` to span both layers in one call, when the active memory plugin supports corpus selection

A common local-first setup uses builtin memory for recall and `memory-wiki` in
`bridge` mode for durable synthesized pages. See the bridge-mode example under
[Configuration](#configuration).

If bridge mode reports zero exported artifacts, the active memory plugin is
not currently exposing public bridge inputs. Run `openclaw wiki doctor` first,
then confirm the active memory plugin supports public artifacts.

## Vault modes

- `isolated` (default): own vault, own sources, no dependency on the active memory plugin. Use this for a self-contained curated knowledge store.
- `bridge`: reads public memory artifacts and event logs from the active memory plugin through public plugin SDK seams. Use this to compile the memory plugin's exported artifacts without reaching into private plugin internals.
- `unsafe-local`: explicit same-machine escape hatch for local private paths. Intentionally experimental and non-portable; use only when you understand the trust boundary and specifically need local filesystem access bridge mode cannot provide.

Vault mode and vault scope are separate choices:

- `vaultMode` chooses where wiki inputs come from.
- `vault.scope` chooses whether all agents use one vault or each agent gets a child vault.

`vault.scope: "global"` is the default and preserves the existing single-vault
behavior. Use `vault.scope: "agent"` with `isolated` or `bridge` mode when
agents must not share wiki pages, compiled digests, search results, or writes.
Agent scope cannot be combined with `unsafe-local` mode because those configured
private paths are not agent-owned inputs. Configuration validation rejects this
combination.

Bridge mode can index, per `bridge.*` config toggle:

- exported memory artifacts (`indexMemoryRoot`)
- daily notes (`indexDailyNotes`)
- dream reports (`indexDreamReports`)
- memory event logs (`followMemoryEvents`)

When bridge mode is active and `bridge.readMemoryArtifacts` is enabled,
`openclaw wiki status`, `openclaw wiki doctor`, and `openclaw wiki bridge
import` route through the running Gateway so they see the same active memory
plugin context as agent/runtime memory. If bridge is disabled or artifact
reads are off, those commands keep local/offline behavior.

## Vault layout

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

Managed content stays inside generated blocks; human note blocks are
preserved across regeneration.

- `sources/`: imported raw material and bridge/unsafe-local-backed pages
- `entities/`: durable things, people, systems, projects, objects
- `concepts/`: ideas, abstractions, patterns, policies (also the landing spot for OKF imports)
- `syntheses/`: compiled summaries and maintained rollups
- `reports/`: generated dashboards

## Open Knowledge Format imports

```bash
openclaw wiki okf import ./bundles/ga4
```

Import an unpacked Open Knowledge Format bundle into wiki concept pages. Good
fit when a data catalog, documentation crawler, or enrichment agent already
produces OKF: keep OKF as the portable exchange artifact, let `memory-wiki`
turn it into OpenClaw-native concept pages and compiled digests.

- non-reserved `.md` files are concept documents
- each imported concept requires a non-empty `type` frontmatter field; missing `type` produces a `missing-type` warning and the file is skipped
- unknown `type` values are accepted as generic concepts
- `index.md` and `log.md` are reserved and never imported as concepts
- broken or external markdown links are left unchanged

Imported pages flatten under `concepts/` so existing compile, search, get, and
dashboard flows see them without a second wiki tree. Each page keeps the
original OKF concept ID, source path, `type`, `resource`, `tags`, timestamp,
and full producer frontmatter. Internal OKF links rewrite to the generated
wiki concept pages and also emit structured `relationships` entries with
`kind: okf-link`.

## Structured claims and evidence

Pages carry structured `claims` frontmatter, not just freeform text. Each
claim can include `id`, `text`, `status`, `confidence`, `evidence[]`, and
`updatedAt`. Each evidence entry can include `kind`, `sourceId`, `path`,
`lines`, `weight`, `confidence`, `privacyTier`, `note`, and `updatedAt`.

This makes the wiki behave like a belief layer, not a passive note dump.
Claims can be tracked, scored, contested, and resolved back to sources.

## Agent-facing entity metadata

Entity pages carry generic routing metadata usable for people, teams,
systems, projects, or any other entity type:

- `entityType`: for example `person`, `team`, `system`, `project`
- `canonicalId`: stable identity key across aliases and imports
- `aliases`: names, handles, or labels that resolve to the same page
- `privacyTier`: free-form string; `public` is treated as no-review, any other value (for example `local-private`, `sensitive`, `confirm-before-use`) is flagged in `reports/privacy-review.md`
- `bestUsedFor` / `notEnoughFor`: compact routing hints
- `lastRefreshedAt`: source-refresh timestamp, separate from page edit time
- `personCard`: optional person-specific routing card (handles, socials, emails, timezone, lane, ask-for, avoid-asking-for, confidence, privacy tier)
- `relationships`: typed edges to related pages (target, kind, weight, confidence, evidence kind, privacy tier, note)

For a people wiki, start with `reports/person-agent-directory.md`, then open
the person page with `wiki_get` before using contact details or inferred
facts.

<Accordion title="Entity page example">
```yaml
pageType: entity
entityType: person
id: entity.example-person
canonicalId: maintainer.example-person
aliases:
  - Alex
  - example-handle
privacyTier: local-private
bestUsedFor:
  - Example ecosystem routing
notEnoughFor:
  - legal approval
lastRefreshedAt: "2026-04-29T00:00:00.000Z"
personCard:
  handles:
    - "@example-handle"
  socials:
    - "https://x.example/example-handle"
  emails:
    - alex@example.com
  timezone: America/Chicago
  lane: Example ecosystem
  askFor:
    - Example rollout questions
  avoidAskingFor:
    - unrelated billing decisions
  confidence: 0.8
  privacyTier: confirm-before-use
relationships:
  - targetId: entity.other-person
    targetTitle: Other Person
    kind: collaborates-with
    confidence: 0.7
    evidenceKind: discrawl-stat
claims:
  - id: claim.example.routing
    text: Alex is useful for example-ecosystem routing.
    status: supported
    confidence: 0.9
    evidence:
      - kind: maintainer-whois
        sourceId: source.maintainers
        privacyTier: local-private
```
</Accordion>

## Compile pipeline

Compile reads wiki pages, normalizes summaries, and persists a machine-facing
snapshot in OpenClaw's shared SQLite plugin state. Runtime code uses the
lifecycle-owned owner snapshot to load SQLite during async prompt preparation;
synchronous prompt assembly never scrapes Markdown or reads cache files.
Compiled output also powers first-pass wiki indexing for search/get, claim-id
lookup back to owning pages, compact prompt supplements, and report
generation.

Source edits and vault restores become machine-facing only after the next
compile. Restarting or refreshing the plugin lifecycle compares the vault's
causally chained compile publication with SQLite and rejects a snapshot from a
newer, rolled-back state. A compiler that started before the rollback cannot
publish against the restored predecessor. Prompt preparation does not poll the
vault or install file watchers.
After rollback quarantine, a compile in the running process clears the owner
immediately; a separate compiler process requires plugin lifecycle refresh so
the daemon can confirm the new durable publication.
ChatGPT import rollback records post-import edits before compile and keeps
their recovery paths in plugin state, so an interrupted rollback can reconcile
the recovery directory and report the same preserved pages on retry. Target
recovery finishes before a persisted process-restart fence. After that point,
retries rebuild derived indexes, dashboards, and compiled caches without
rewriting source pages or moving or deleting recovery artifacts. A later normal
compile may refresh machine-managed Related blocks. This covers in-process
failure and process restart after ordinary filesystem calls return. It does not
guarantee write ordering across kernel or host power loss. A pathname write
racing fence persistence either remains after a successful fence or is
preserved under `recovered/` by a pre-fence retry. Writes through a file
descriptor opened before an import-owned inode is classified and unlinked are
not guaranteed and may be lost.
Compiled caches are rebuildable: cache rows from before publication epochs are
treated as misses and replaced by the next compile; they are not migrated.

## Dashboards and health reports

When `render.createDashboards` is enabled, compile maintains dashboards under
`reports/`:

| Report                              | Tracks                                             |
| ----------------------------------- | -------------------------------------------------- |
| `reports/open-questions.md`         | pages with unresolved questions                    |
| `reports/contradictions.md`         | contradiction note clusters                        |
| `reports/low-confidence.md`         | low-confidence pages and claims                    |
| `reports/claim-health.md`           | claims missing structured evidence                 |
| `reports/stale-pages.md`            | stale or unknown freshness                         |
| `reports/person-agent-directory.md` | person/entity routing cards                        |
| `reports/relationship-graph.md`     | structured relationship edges                      |
| `reports/provenance-coverage.md`    | evidence class coverage                            |
| `reports/privacy-review.md`         | non-public privacy tiers needing review before use |

## Search and retrieval

Two search backends:

- `shared`: use the shared memory search flow when available
- `local`: search the wiki locally

Three corpora: `wiki`, `memory`, `all`.

- `wiki_search` / `wiki_get` use compiled digests as a first pass when possible
- claim ids resolve back to the owning page
- contested/stale/fresh claims influence ranking
- provenance labels survive into results

Search modes (`--mode` / tool `mode` param):

| Mode              | Boosts                                                         |
| ----------------- | -------------------------------------------------------------- |
| `auto`            | balanced default                                               |
| `find-person`     | person-like entities, aliases, handles, socials, canonical IDs |
| `route-question`  | agent cards, ask-for/best-used-for hints, relationship context |
| `source-evidence` | source pages and structured evidence metadata                  |
| `raw-claim`       | matching structured claims; returns claim/evidence metadata    |

When a result matches a structured claim, `wiki_search` returns
`matchedClaimId`, `matchedClaimStatus`, `matchedClaimConfidence`,
`evidenceKinds`, and `evidenceSourceIds` in its details payload. Text output
includes compact `Claim:` and `Evidence:` lines when available.

## Agent tools

| Tool          | Purpose                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wiki_status` | current vault mode and scope, resolved agent, health, Obsidian CLI availability                                                                               |
| `wiki_search` | search wiki pages and, when configured, the shared memory corpus; accepts `mode` for person lookup, question routing, source evidence, or raw claim drilldown |
| `wiki_get`    | read a wiki page by id/path, falling back to the shared memory corpus when shared search is enabled and the lookup misses                                     |
| `wiki_apply`  | narrow synthesis/metadata mutations without freeform page surgery                                                                                             |
| `wiki_lint`   | structural checks, provenance gaps, contradictions, open questions                                                                                            |

The plugin also registers a non-exclusive memory corpus supplement, so shared
`memory_search` and `memory_get` can reach the wiki when the active memory
plugin supports corpus selection.

## Browsing the wiki in the Control UI

The [Control UI](/web/control-ui) can browse the compiled wiki directly: open
the Memory page, then **Dreams → Diary → Memory Wiki**. The tab clusters
synthesis, entity, and concept pages — plus source and report pages that
carry claims, open questions, or contradictions — with per-page counts and a
full-vault page breakdown, and opens full page content inline. Raw sources
and reports without that metadata count toward the breakdown but are not
listed as cards; open them from the **Imported Insights** sub-tab, which
reviews what external-history imports surfaced before promotion.

Both sub-tabs appear once the plugin is enabled; in agent-scoped vault setups
they show the selected agent's own vault. The UI reads through the plugin's
gateway methods (`wiki.overview`, `wiki.get`, `wiki.importInsights`); inline
page previews use `wiki.get`, the same lookup agents reach through the
`wiki_get` tool.

Each dashboard keeps at most the newest 2,500 cards in its compiled snapshot.
When a vault exceeds that bound, the UI shows the returned and total item counts.

Dashboard requests never scan raw vault pages or wait for a full vault compile.
During automatic recovery, the UI reports that the dashboards are rebuilding;
reload the tab shortly. When
`ingest.autoCompile` is `false`, a source change or older cache reports that a
compile is required instead. Run `openclaw wiki compile`, then reload the tab.

## Prompt and context behavior

When `context.includeCompiledDigestPrompt` is enabled, memory prompt sections
append a compact compiled snapshot from plugin state: top pages only,
top claims only, contradiction count, question count, confidence/freshness
qualifiers. This is opt-in because it changes prompt shape; it mainly matters
for context engines or prompt assembly that explicitly consume memory
supplements.

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
            scope: "global",
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
          unsafeLocal: {
            allowPrivateMemoryCoreAccess: false,
            paths: [],
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

| Key                                        | Values / default                               | Notes                                                                         |
| ------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `vaultMode`                                | `isolated` (default), `bridge`, `unsafe-local` | chooses input and integration behavior                                        |
| `vault.scope`                              | `global` (default), `agent`                    | one shared vault or one child vault per agent                                 |
| `vault.path`                               | global default `<state-dir>/wiki/main`         | exact vault globally; agent-scope parent defaults to `<state-dir>/wiki`       |
| `vault.renderMode`                         | `native` (default), `obsidian`                 |                                                                               |
| `bridge.readMemoryArtifacts`               | default `true`                                 | import active memory plugin public artifacts                                  |
| `bridge.followMemoryEvents`                | default `true`                                 | include event logs in bridge mode                                             |
| `unsafeLocal.allowPrivateMemoryCoreAccess` | default `false`                                | required to run `unsafe-local` imports                                        |
| `unsafeLocal.paths`                        | default `[]`                                   | explicit local paths to import in `unsafe-local` mode                         |
| `ingest.autoCompile`                       | default `true`                                 | rebuild compiled output after imported sources change                         |
| `search.backend`                           | `shared` (default), `local`                    |                                                                               |
| `search.corpus`                            | `wiki` (default), `memory`, `all`              |                                                                               |
| `context.includeCompiledDigestPrompt`      | default `false`                                | append the selected agent's compact digest snapshot to memory prompt sections |
| `render.createBacklinks`                   | default `true`                                 | generate deterministic related blocks                                         |
| `render.createDashboards`                  | default `true`                                 | generate dashboard pages                                                      |

The state directory is `~/.openclaw` by default. When `OPENCLAW_STATE_DIR` is
set, default wiki vaults use that directory instead. Explicit `vault.path`
values keep their configured location, and `~/` still expands against the home
directory.

### Per-agent vaults

Set `vault.scope` to `agent` to give every configured agent a separate wiki.
In this scope, `vault.path` is a parent directory and OpenClaw appends the
normalized agent id:

```json5
{
  agents: {
    entries: {
      support: { default: true },
      marketing: {},
    },
  },
  plugins: {
    entries: {
      "memory-wiki": {
        enabled: true,
        config: {
          vaultMode: "bridge",
          vault: {
            scope: "agent",
            path: "~/.openclaw/wiki",
          },
          bridge: {
            enabled: true,
            readMemoryArtifacts: true,
          },
        },
      },
    },
  },
}
```

This resolves to `~/.openclaw/wiki/support` and
`~/.openclaw/wiki/marketing`. If `vault.path` is omitted in agent scope, the
parent defaults to `<state-dir>/wiki`, where the state directory is
`~/.openclaw` or the value of `OPENCLAW_STATE_DIR`. The default `main` agent
therefore uses `<state-dir>/wiki/main`.

Agent tools, compiled prompt digests, and the wiki supplement exposed through
`memory_search` / `memory_get` resolve the vault from the active agent context.
CLI calls use the configured default agent unless the command passes
`--agent <agentId>`. Gateway calls in a multi-agent setup still require the
request's `agentId`.

In bridge mode, agent-scoped imports accept a public memory artifact only when
its `agentIds` includes the selected agent. Artifacts owned by another agent,
without ownership metadata, or with an unknown owner are skipped. Global scope
keeps the existing shared-artifact behavior.

<Warning>
Changing `vault.scope` does not copy or split an existing vault. In agent scope,
an explicitly configured `vault.path` becomes a parent directory, so move or
import existing pages deliberately before switching production agents. Back up
the vault first.

Per-agent vaults are a same-process knowledge boundary, not an operating-system
security boundary. Plugins and unsandboxed tools with host filesystem access can
still read another agent's directory. Use [sandboxing](/gateway/sandboxing) or
[separate Gateway profiles](/gateway/multiple-gateways) when agents do not trust
each other.
</Warning>

### Example: builtin memory + bridge mode

Use this when you want builtin memory for recall and `memory-wiki` for a
maintained knowledge layer. Each layer stays focused: `memory-core` searches
memory notes and eligible session sources, while `memory-wiki` compiles stable
entities, claims, dashboards, and source pages.

```json5
{
  plugins: {
    entries: {
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

This keeps builtin memory in charge of active recall, `memory-wiki` focused on
compiled pages and dashboards, and prompt shape unchanged until you
intentionally enable compiled digest prompts.

## CLI

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

See [CLI: wiki](/cli/wiki) for the full command reference, including
`wiki okf import`, `wiki apply metadata`, `wiki unsafe-local import`,
`wiki chatgpt import` / `wiki chatgpt rollback`, and the full `wiki obsidian`
subcommand set.

## Obsidian support

When `vault.renderMode` is `obsidian`, the plugin writes Obsidian-friendly
Markdown and can optionally use the official `obsidian` CLI for status
probing, vault search, opening a page, invoking a command, and jumping to the
daily note. This is optional; the wiki still works in native mode without
Obsidian.

Agent-scoped vaults can still use Obsidian-friendly Markdown, but configuration
validation rejects `obsidian.useOfficialCli: true` with `vault.scope: "agent"`.
The current `obsidian.vaultName` setting is global and cannot select a distinct
Obsidian vault for each agent. Use the wiki tools and CLI operations instead,
or keep an Obsidian-operated wiki in global scope.

## Recommended workflow

<Steps>
<Step title="Keep the active memory plugin for recall">
Recall, promotion, and dreaming stay owned by the configured memory backend.
</Step>
<Step title="Enable memory-wiki">
Start with `isolated` mode unless you explicitly want bridge mode.
</Step>
<Step title="Use wiki_search / wiki_get when provenance matters">
Prefer these over `memory_search` when you want wiki-specific ranking or page-level belief structure.
</Step>
<Step title="Use wiki_apply for narrow syntheses or metadata updates">
Avoid hand-editing managed generated blocks.
</Step>
<Step title="Run wiki_lint after meaningful changes">
Catches contradictions, open questions, and provenance gaps.
</Step>
<Step title="Turn on dashboards for stale/contradiction visibility">
Set `render.createDashboards: true` (default).
</Step>
</Steps>

## Related docs

- [Memory Overview](/concepts/memory)
- [CLI: memory](/cli/memory)
- [CLI: wiki](/cli/wiki)
- [Plugin SDK overview](/plugins/sdk-overview)
