---
summary: "CLI reference for `clawdbot memory` (status/index/search)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
---

# `clawdbot memory`

Memory search tools (semantic memory status/index/search).
Provided by the active memory plugin (default: `memory-core`; use `plugins.slots.memory = "none"` to disable).

Related:
- Memory concept: [Memory](/concepts/memory)
 - Plugins: [Plugins](/plugins)

## Examples

```bash
clawdbot memory status
clawdbot memory status --deep
clawdbot memory status --deep --index
clawdbot memory status --deep --index --verbose
clawdbot memory index
clawdbot memory search "release checklist"
```

## Options

- `--verbose`: emit debug logs during memory probes and indexing.
