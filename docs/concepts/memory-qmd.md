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
- **Index extra directories** -- project docs, team notes, anything on disk.
- **Index session transcripts** -- recall earlier conversations.
- **Fully local** -- runs via Bun + node-llama-cpp, auto-downloads GGUF models.
- **Automatic fallback** -- if QMD is unavailable, OpenClaw falls back to the
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
automatically -- collections, updates, and embedding runs are handled for you.
It prefers current QMD collection and MCP query shapes, but still falls back to
legacy `--mask` collection flags and older MCP tool names when needed.
Boot-time reconciliation also recreates stale managed collections back to their
canonical patterns when an older QMD collection with the same name is still
present.

## How the sidecar works

- OpenClaw creates collections from your workspace memory files and any
  configured `memory.qmd.paths`, then runs `qmd update` + `qmd embed` on boot
  and periodically (default every 5 minutes).
- The default workspace collection tracks `MEMORY.md` plus the `memory/`
  tree. Lowercase `memory.md` is not indexed as a root memory file.
- Boot refresh runs in the background so chat startup is not blocked.
- Searches use the configured `searchMode` (default: `search`; also supports
  `vsearch` and `query`). If a mode fails, OpenClaw retries with `qmd query`.
- If QMD fails entirely, OpenClaw falls back to the builtin SQLite engine.

<Info>
The first search may be slow -- QMD auto-downloads GGUF models (~2 GB) for
reranking and query expansion on the first `qmd query` run.
</Info>

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
search results. `memory_get` understands this prefix and reads from the correct
collection root.

## Indexing session transcripts

Enable session indexing to recall earlier conversations:

```json5
{
  memory: {
    backend: "qmd",
    qmd: {
      sessions: { enabled: true },
    },
  },
}
```

Transcripts are exported as sanitized User/Assistant turns into a dedicated QMD
collection under `~/.openclaw/agents/<id>/qmd/sessions/`.

## Search scope

By default, QMD search results are surfaced in direct and channel sessions
(not groups). Configure `memory.qmd.scope` to change this:

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

When scope denies a search, OpenClaw logs a warning with the derived channel and
chat type so empty results are easier to debug.

## Citations

When `memory.citations` is `auto` or `on`, search snippets include a
`Source: <path#line>` footer. Set `memory.citations = "off"` to omit the footer
while still passing the path to the agent internally.

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

**First search very slow?** QMD downloads GGUF models on first use. Pre-warm
with `qmd query "test"` using the same XDG dirs OpenClaw uses.

**Search times out?** Increase `memory.qmd.limits.timeoutMs` (default: 4000ms).
Set to `120000` for slower hardware.

**Empty results in group chats?** Check `memory.qmd.scope` -- the default only
allows direct and channel sessions.

**Root memory search suddenly got too broad?** Restart the gateway or wait for
the next startup reconciliation. OpenClaw recreates stale managed collections
back to canonical `MEMORY.md` and `memory/` patterns when it detects a same-name
conflict.

**Workspace-visible temp repos causing `ENAMETOOLONG` or broken indexing?**
QMD traversal currently follows the underlying QMD scanner behavior rather than
OpenClaw's builtin symlink rules. Keep temporary monorepo checkouts under
hidden directories like `.tmp/` or outside indexed QMD roots until QMD exposes
cycle-safe traversal or explicit exclusion controls.

## Configuration

For the full config surface (`memory.qmd.*`), search modes, update intervals,
scope rules, and all other knobs, see the
[Memory configuration reference](/reference/memory-config).

## Related

- [Memory overview](/concepts/memory)
- [Builtin memory engine](/concepts/memory-builtin)
- [Honcho memory](/concepts/memory-honcho)
