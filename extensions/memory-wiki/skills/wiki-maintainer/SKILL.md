---
name: wiki-maintainer
description: Maintain the OpenClaw memory wiki vault with deterministic pages, managed blocks, and source-backed updates.
---

Use this skill when working inside a memory-wiki vault.

- Prefer `wiki_status` first when you need to understand the vault mode, path, or Obsidian CLI availability.
- Prefer `memory_search` with `corpus=all` when the shared memory tools are available and you want one recall pass across durable memory plus the compiled wiki.
- Use `wiki_search` to discover candidate pages when you want wiki-specific ranking/provenance, then `wiki_get` to inspect the exact page before editing or citing it.
- Use `wiki_apply` for narrow synthesis filing and metadata updates when a tool-level mutation is enough.
- Run `wiki_lint` after meaningful wiki updates so contradictions, provenance gaps, and open questions get surfaced before you trust the vault.
- Use `openclaw wiki ingest`, `openclaw wiki compile`, and `openclaw wiki lint` as the default maintenance loop.
- In `bridge` mode, run `openclaw wiki bridge import` before relying on search results if you need the latest public memory artifacts pulled in.
- In `unsafe-local` mode, use `openclaw wiki unsafe-local import` only when the user explicitly opted into private local path access.
- Keep generated sections inside managed markers. Do not overwrite human note blocks.
- Treat raw sources, memory artifacts, and daily notes as evidence. Do not let wiki pages become the only source of truth for new claims.
- Keep page identity stable. Favor updating existing entities and concepts over spawning duplicates with slightly different names.
- When creating or refreshing indexes, preserve Obsidian-friendly wikilinks if the vault render mode is `obsidian`.
