---
summary: "Local-first search sidecar with BM25, vectors, reranking, and query expansion"
title: "QMD memory engine"
read_when:
  - You want to set up QMD as your memory backend
  - You want advanced memory features like reranking or extra indexed paths
---

[QMD](https://github.com/tobi/qmd) is a local-first search sidecar that runs
alongside OpenClaw. It combines BM25, vector search, and reranking in a single
binary, and can index content beyond your workspace memory files.

## What it adds over builtin

- **Reranking and query expansion** for better recall.
- **Index extra directories** - project docs, team notes, anything on disk.
- **Index session transcripts** - recall earlier conversations.
- **Fully local** - runs with the official llama.cpp provider plugin and
  auto-downloads GGUF models.
- **Automatic fallback** - if QMD is unavailable, OpenClaw falls back to the
  builtin engine seamlessly.

## Getting started

### Prerequisites

- Install QMD: `npm install -g @tobilu/qmd` or `bun install -g @tobilu/qmd`
- SQLite build that allows extensions (`brew install sqlite` on macOS).
- QMD must be on the gateway's `PATH`.
- macOS and Linux work out of the box. Windows is best supported via WSL2.

### Enable

```json5
{
  memory: {
    backend: "qmd",
  },
}
```

OpenClaw creates a self-contained QMD home under
`~/.openclaw/agents/<agentId>/qmd/` and manages the sidecar lifecycle
automatically - collections, updates, and embedding runs are handled for you.
It prefers current QMD collection and MCP query shapes, but falls back to
alternate collection-pattern flags and older MCP tool names when needed.
Startup reconciliation also recreates stale managed collections back to their
canonical patterns when an older QMD collection with the same name is still
present.

## How the sidecar works

- OpenClaw creates collections from your workspace memory files and any
  configured `memory.qmd.paths`, then runs `qmd update` when the QMD manager
  opens and periodically afterward (`memory.qmd.update.interval`, default
  `5m`). Refreshes run through QMD subprocesses, not an in-process filesystem
  crawl. Semantic search modes also run `qmd embed`
  (`memory.qmd.update.embedInterval`, default `60m`).
- QMD continues to own its `index.sqlite`, YAML collection config, and model
  downloads under the per-agent QMD home; these are external-tool artifacts,
  not OpenClaw state tables. OpenClaw-owned coordination lives only in SQLite:
  one shared lease limits embedding work across agents, while one lease in each
  agent database serializes that agent's collection, update, and embed writes.
  Runtime no longer creates QMD file-lock sidecars. `openclaw doctor --fix`
  removes retired sidecars only after proving their old process owner is stale.
  Upgrades are a clean cutover: stop and restart every OpenClaw process that
  shares the state directory before using the new version. Mixed old/new QMD
  writers are unsupported; runtime intentionally does not dual-lock the retired
  sidecars.
- The default workspace collection tracks `MEMORY.md` plus the `memory/`
  tree. Lowercase `memory.md` is not indexed as a root memory file.
- QMD's own scanner ignores hidden paths and common dependency/build
  directories such as `.git`, `.cache`, `node_modules`, `vendor`, `dist`, and
  `build`. Gateway startup does not initialize QMD by default
  (`memory.qmd.update.startup` defaults to `off`), so cold boot avoids
  importing the memory runtime or creating the long-lived watcher before
  memory is first used.
- Set `memory.qmd.update.startup` to `idle` or `immediate` to initialize QMD
  at gateway start anyway. `memory.qmd.update.onBoot` defaults to `true` and
  runs the initial refresh at startup; set it to `false` to skip that
  immediate refresh (the long-lived manager still opens when update or embed
  intervals are configured, so QMD keeps owning its regular watcher/timers).
- Searches use the configured `searchMode` (default: `search`; also supports
  `vsearch` and `query`). `search` is BM25-only, so OpenClaw skips semantic
  vector readiness probes and embedding maintenance in that mode. If a mode
  fails, OpenClaw retries with `qmd query`.
- When `searchMode` is `query`, set `memory.qmd.rerank` to `false` to use
  QMD's hybrid query path without the reranker (requires QMD 2.1 or newer).
  OpenClaw passes `--no-rerank` to the direct QMD CLI path and
  `rerank: false` to QMD's MCP query tool.
- With QMD releases that advertise multi-collection filters, OpenClaw groups
  same-source collections into one QMD search invocation. Older QMD releases
  keep the compatible per-collection fallback.
- If QMD fails entirely, OpenClaw falls back to the builtin SQLite engine.
  Repeated chat-turn attempts back off briefly after an open failure so a
  missing binary or broken sidecar dependency does not create a retry storm;
  `openclaw memory status` and one-shot CLI probes still recheck QMD
  directly.

<Info>
The first search may be slow - QMD auto-downloads GGUF models (~2 GB) for
reranking and query expansion on the first `qmd query` run.
</Info>

## Search performance and compatibility

OpenClaw keeps the QMD search path compatible with both current and older QMD
installs.

On startup, OpenClaw checks the installed QMD help text once per manager. If
the binary advertises support for multiple collection filters, OpenClaw
searches all same-source collections with one command:

```bash
qmd search "router notes" --json -n 10 -c memory-root-main -c memory-dir-main
```

This avoids starting one QMD subprocess per durable-memory collection.
Session transcript collections stay in their own source group, so mixed
`memory` + `sessions` searches still give the result diversifier input from
both sources.

Older QMD builds only accept one collection filter. When OpenClaw detects one
of those builds, it keeps the compatibility path and searches each collection
separately before merging and deduplicating results.

To inspect the installed contract manually, run:

```bash
qmd --help | grep -i collection
```

Current QMD help mentions targeting one or more collections. Older help
usually describes a single collection.

## Model overrides

QMD model environment variables pass through unchanged from the gateway
process, so you can tune QMD globally without adding new OpenClaw config:

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
export QMD_RERANK_MODEL="/absolute/path/to/reranker.gguf"
export QMD_GENERATE_MODEL="/absolute/path/to/generator.gguf"
```

After changing the embedding model, rerun embeddings so the index matches the
new vector space.

## Indexing extra paths

Point QMD at additional directories to make them searchable:

```json5
{
  memory: {
    backend: "qmd",
    qmd: {
      paths: [{ name: "docs", path: "~/notes", pattern: "**/*.md" }],
    },
  },
}
```

Snippets from extra paths appear as `qmd/<collection>/<relative-path>` in
search results. `memory_get` understands this prefix and reads from the
correct collection root.

## Indexing session transcripts

Enable session indexing to recall earlier conversations. QMD needs both the
general `memorySearch` session source and the QMD transcript exporter:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        experimental: { sessionMemory: true },
        sources: ["memory", "sessions"],
      },
    },
  },
  memory: {
    backend: "qmd",
    qmd: {
      sessions: { enabled: true },
    },
  },
}
```

Transcripts export as sanitized User/Assistant turns into a dedicated QMD
collection under `~/.openclaw/agents/<id>/qmd/sessions/`. Setting only
`memorySearch.experimental.sessionMemory` does not export transcripts into
QMD.

Session hits are still filtered by
[`tools.sessions.visibility`](/gateway/config-tools#toolssessions). The
default `tree` visibility includes the current session, its spawned sessions,
and same-agent group sessions watched through ambient group awareness. With
`session.dmScope: "main"`, users in a multi-user DM setup share the main
session and can recall content from its watched groups. Use a per-peer
`dmScope` for DM isolation, or set visibility to `"self"` to opt out of ambient
watched-session reads. Other unrelated same-agent sessions still require
`"agent"` visibility.

## Search scope

By default, QMD search results are surfaced only in direct sessions (not
group or channel chats). Configure `memory.qmd.scope` to change this:

```json5
{
  memory: {
    qmd: {
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
    },
  },
}
```

The snippet above is the actual default rule. When scope denies a search,
OpenClaw logs a warning with the derived channel and chat type so empty
results are easier to debug.

## Citations

When `memory.citations` is `auto` or `on`, search snippets get a
`Source: <path>#L<line>` (or `#L<start>-L<end>`) footer appended. In `auto`
mode the footer is added only for direct-chat sessions. Set
`memory.citations = "off"` to omit the footer while still passing the path to
the agent internally.

## When to use

Choose QMD when you need:

- Reranking for higher-quality results.
- To search project docs or notes outside the workspace.
- To recall past session conversations.
- Fully local search with no API keys.

For simpler setups, the [builtin engine](/concepts/memory-builtin) works well
with no extra dependencies.

## Troubleshooting

**QMD not found?** Ensure the binary is on the gateway's `PATH`. If OpenClaw
runs as a service, create a symlink:
`sudo ln -s ~/.bun/bin/qmd /usr/local/bin/qmd`.

If `qmd --version` works in your shell but OpenClaw still reports
`spawn qmd ENOENT`, the gateway process likely has a different `PATH` than
your interactive shell. Pin the binary explicitly:

```json5
{
  memory: {
    backend: "qmd",
    qmd: {
      command: "/absolute/path/to/qmd",
    },
  },
}
```

Use `command -v qmd` in the environment where QMD is installed, then recheck
with `openclaw memory status --deep`.

**First search very slow?** QMD downloads GGUF models on first use. Pre-warm
with `qmd query "test"` using the same XDG dirs OpenClaw uses.

**Many QMD subprocesses during search?** Update QMD if possible. OpenClaw
uses one process for same-source multi-collection searches only when the
installed QMD advertises support for multiple `-c` filters; otherwise it
keeps the older per-collection fallback for correctness.

**BM25-only QMD still trying to build llama.cpp?** Set
`memory.qmd.searchMode = "search"`. OpenClaw treats that mode as
lexical-only, skips QMD vector status probes and embedding maintenance, and
leaves semantic readiness checks to `vsearch` or `query` setups.

**Search times out?** Increase `memory.qmd.limits.timeoutMs` (default: 4000ms).
Set it higher, for example `120000`, for slower hardware. This limit applies to
QMD's own search commands during agent `memory_search` calls; setup, sync,
builtin fallback, and supplemental corpus work keep their own shorter deadlines.

**Empty results in group or channel chats?** This is expected with the
default `memory.qmd.scope`, which allows only direct sessions. Add an
`allow` rule for `group` or `channel` chat types if you want QMD results
there.

**Root memory search suddenly got too broad?** Restart the gateway or wait
for the next startup reconciliation. OpenClaw recreates stale managed
collections back to canonical `MEMORY.md` and `memory/` patterns when it
detects a same-name conflict.

**Workspace-visible temp repos causing `ENAMETOOLONG` or broken indexing?**
QMD traversal follows the underlying QMD scanner rather than OpenClaw's
builtin symlink rules. Keep temporary monorepo checkouts under hidden
directories like `.tmp/` or outside indexed QMD roots until QMD exposes
cycle-safe traversal or explicit exclusion controls.

## Configuration

For the full config surface (`memory.qmd.*`), search modes, update intervals,
scope rules, and all other knobs, see the
[Memory configuration reference](/reference/memory-config).

## Related

- [Memory overview](/concepts/memory)
- [Builtin memory engine](/concepts/memory-builtin)
- [Honcho memory](/concepts/memory-honcho)
