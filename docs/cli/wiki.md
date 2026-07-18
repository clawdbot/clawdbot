---
summary: "CLI reference for `openclaw wiki` (memory-wiki vault status, search, compile, lint, apply, bridge, ChatGPT import, and Obsidian helpers)"
read_when:
  - You want to use the memory-wiki CLI
  - You are documenting or changing `openclaw wiki`
title: "Wiki"
---

# `openclaw wiki`

Inspect and maintain the `memory-wiki` vault. Provided by the bundled `memory-wiki` plugin.

Related: [Memory Wiki plugin](/plugins/memory-wiki), [Memory Overview](/concepts/memory), [CLI: memory](/cli/memory)

## Common commands

```bash
openclaw wiki status
openclaw wiki doctor
openclaw wiki init
openclaw wiki ingest ./notes/alpha.md
openclaw wiki okf import ./knowledge-catalog/okf/bundles/ga4
openclaw wiki compile
openclaw wiki lint
openclaw wiki search "alpha"
openclaw wiki search "who should I ask about Teams?" --mode route-question
openclaw wiki get entity.alpha --from 1 --lines 80

openclaw wiki apply synthesis "Alpha Summary" \
  --body "Short synthesis body" \
  --source-id source.alpha

openclaw wiki apply metadata entity.alpha \
  --source-id source.alpha \
  --status review \
  --question "Still active?"

openclaw wiki bridge import
openclaw wiki unsafe-local import
openclaw wiki chatgpt import --export ./chatgpt-export --dry-run
openclaw wiki chatgpt rollback <run-id>

openclaw wiki obsidian status
openclaw wiki obsidian search "alpha"
openclaw wiki obsidian open syntheses/alpha-summary.md
openclaw wiki obsidian command workspace:quick-switcher
openclaw wiki obsidian daily
```

## Agent selection

When `plugins.entries.memory-wiki.config.vault.scope` is `agent`, select the
vault with the top-level `--agent <id>` option:

```bash
openclaw wiki --agent support status
openclaw wiki --agent support search "refund policy"
openclaw wiki --agent marketing ingest ./campaign-notes.md
```

In a setup with multiple configured agents, `--agent` is required for CLI
operations so a command cannot read or write an arbitrary default vault. If
only one agent is configured, that agent remains the default. Unknown agent ids
fail before the vault operation starts. The option does not change the selected
path when `vault.scope` is `global`.

Gateway clients follow the same rule: pass `agentId` on vault-backed `wiki.*`
requests in an agent-scoped multi-agent setup. A missing or unknown id is an
error. Agent turns, wiki tools, memory corpus supplements, and compiled prompt
digests already carry the active runtime agent context.

## Commands

### `wiki status`

Show vault mode and scope, resolved agent, health, and Obsidian CLI availability. Use this first to check whether the intended vault is initialized, bridge mode is healthy, or Obsidian integration is available.

When bridge mode is active and configured to read memory artifacts, this command queries the running Gateway so it sees the same active memory plugin context as agent/runtime memory.

### `wiki doctor`

Run wiki health checks and report actionable fixes. Exits non-zero when unhealthy.

When bridge mode is active and configured to read memory artifacts, this command queries the running Gateway before building the report. Disabled bridge imports and bridge configs that do not read memory artifacts stay local/offline.

Typical issues:

- bridge mode enabled without public memory artifacts
- invalid or missing vault layout
- missing external Obsidian CLI when Obsidian mode is expected

### `wiki init`

Create the wiki vault layout and starter pages, including top-level indexes and cache directories.

### `wiki ingest <path>`

Import a local markdown or text file into the wiki `sources/` folder as a source page. `<path>` must be a local file path; there is no URL ingest today. Rejects binary files.

Imported source pages carry provenance frontmatter (`sourceType: local-file`, `sourcePath`, `ingestedAt`). Ingest always recompiles the vault afterward.

Flags: `--title <title>` overrides the source title (default: derived from the filename).

### `wiki okf import <path>`

Import an unpacked Open Knowledge Format bundle into wiki concept pages.

The importer reads every non-reserved `.md` concept document in the OKF directory tree, requires a non-empty `type` field, and treats unknown OKF `type` values as generic concepts. Reserved OKF `index.md` and `log.md` files are not imported as concepts.

Imported pages are flattened under `concepts/` so existing wiki compile, search, get, digest, and dashboard flows see them immediately. The original OKF concept ID, `type`, `resource`, `tags`, timestamp, source path, and full frontmatter are preserved in the page frontmatter. Internal OKF markdown links are rewritten to the generated wiki pages; broken or external links are left unchanged. Import always recompiles the vault afterward.

Examples:

```bash
openclaw wiki okf import ./bundles/ga4
openclaw wiki okf import ./bundles/ga4 --json
openclaw wiki search "BigQuery Table" --mode source-evidence --json
openclaw wiki get <path-from-json-result>
```

### `wiki compile`

Rebuild indexes, related blocks, dashboards, and the compiled query/prompt snapshot. The snapshot is persisted in OpenClaw's shared SQLite plugin state and kept in memory for synchronous prompt projection; it does not create cache files in the vault.

If `render.createDashboards` is enabled, compile also refreshes report pages.

### `wiki lint`

Lint the vault and write a report covering:

- structural issues (broken links, missing/duplicate ids, missing page type or title, invalid frontmatter)
- provenance gaps (missing source ids, missing import provenance)
- contradictions (flagged contradictions, conflicting claims)
- open questions
- low-confidence pages and claims
- stale pages and claims

Run this after meaningful wiki updates.

### `wiki search <query>`

Search wiki content. Behavior depends on config:

- `search.backend`: `shared` or `local`
- `search.corpus`: `wiki`, `memory`, or `all`
- `--mode`: `auto`, `find-person`, `route-question`, `source-evidence`, or `raw-claim`

Use `wiki search` for wiki-specific ranking and provenance. For one broad shared recall pass, prefer `openclaw memory search` when the active memory plugin exposes shared search.

Search modes:

- `find-person`: aliases, handles, socials, canonical IDs, and person pages
- `route-question`: ask-for/best-used-for hints and relationship context
- `source-evidence`: source pages and structured evidence fields
- `raw-claim`: structured claim text with claim/evidence metadata

Examples:

```bash
openclaw wiki search "bgroux" --mode find-person
openclaw wiki search "who knows Teams rollout?" --mode route-question
openclaw wiki search "maintainer-whois" --mode source-evidence
openclaw wiki search "strong route Teams" --mode raw-claim --json
```

Text output includes `Claim:` and `Evidence:` lines when a result matches a structured claim. JSON output additionally exposes `matchedClaimId`, `matchedClaimStatus`, `matchedClaimConfidence`, `evidenceKinds`, and `evidenceSourceIds` for agent-side drilldown.

### `wiki get <lookup>`

Read a wiki page by id or relative path.

```bash
openclaw wiki get entity.alpha
openclaw wiki get syntheses/alpha-summary.md --from 1 --lines 80
```

### `wiki apply`

Apply narrow mutations without freeform page surgery:

- `apply synthesis <title>`: create or refresh a synthesis page with a managed summary body
- `apply metadata <lookup>`: update metadata on an existing page

Both accept `--source-id`, `--contradiction`, `--question` (each repeatable), `--confidence <n>` (0-1), and `--status <status>`. `apply metadata` also accepts `--clear-confidence` to remove a stored confidence value. This is the supported way to evolve wiki pages so managed generated blocks stay intact.

### `wiki bridge import`

Import public memory artifacts from the active memory plugin into bridge-backed source pages. Use this in `bridge` mode to pull the latest exported memory artifacts into the wiki vault.

For active bridge artifact reads, the CLI routes the import through Gateway RPC so it uses the runtime memory plugin context. If bridge imports are disabled or artifact reads are off, the command keeps the local/offline zero-import behavior. Index refresh after import is gated by `ingest.autoCompile`.

### `wiki unsafe-local import`

Import from explicitly configured local paths (`unsafeLocal.paths`) in `unsafe-local` mode. Intentionally experimental and same-machine only. Index refresh after import is gated by `ingest.autoCompile`.

### `wiki chatgpt import`

Import a ChatGPT export into draft wiki source pages.

```bash
openclaw wiki chatgpt import --export ./chatgpt-export
openclaw wiki chatgpt import --export ./conversations.json --dry-run
```

| Flag              | Default    | Description                                                   |
| ----------------- | ---------- | ------------------------------------------------------------- |
| `--export <path>` | (required) | ChatGPT export directory or `conversations.json` path.        |
| `--dry-run`       | `false`    | Preview created/updated/skipped counts without writing pages. |

A non-dry-run import that changes any page records an import run id, printed in the summary, needed for rollback.

### `wiki chatgpt rollback <run-id>`

Roll back a previously applied ChatGPT import run, removing pages it created and restoring pages it overwrote. No-ops (and reports `alreadyRolledBack`) if the run was already rolled back.

### `wiki obsidian ...`

Obsidian helper commands for vaults running in Obsidian-friendly mode: `status`, `search`, `open`, `command`, `daily`. These require the official `obsidian` CLI on `PATH` when `obsidian.useOfficialCli` is enabled.

Configuration validation rejects `obsidian.useOfficialCli: true` when
`vault.scope` is `agent` because `obsidian.vaultName` is one global setting,
not a per-agent mapping. Obsidian-friendly Markdown rendering remains
available.

## Practical usage guidance

- Use `wiki search` + `wiki get` when provenance and page identity matter.
- Use `wiki apply` instead of hand-editing managed generated sections.
- Use `wiki lint` before trusting contradictory or low-confidence content.
- Use `wiki compile` after bulk imports or source changes when you want fresh dashboards and compiled digests immediately.
- Use `wiki okf import` when a data catalog, documentation export, or agent enrichment pipeline already emits OKF markdown bundles.
- Use `wiki bridge import` when bridge mode depends on newly exported memory artifacts.

## Configuration tie-ins

`openclaw wiki` behavior is shaped by:

- `plugins.entries.memory-wiki.config.vaultMode`
- `plugins.entries.memory-wiki.config.vault.scope`
- `plugins.entries.memory-wiki.config.vault.path`
- `plugins.entries.memory-wiki.config.search.backend`
- `plugins.entries.memory-wiki.config.search.corpus`
- `plugins.entries.memory-wiki.config.bridge.*`
- `plugins.entries.memory-wiki.config.obsidian.*`
- `plugins.entries.memory-wiki.config.ingest.autoCompile`
- `plugins.entries.memory-wiki.config.render.*`
- `plugins.entries.memory-wiki.config.context.includeCompiledDigestPrompt`

See [Memory Wiki plugin](/plugins/memory-wiki) for the full config model.

## Related

- [CLI reference](/cli)
- [Memory wiki](/plugins/memory-wiki)
