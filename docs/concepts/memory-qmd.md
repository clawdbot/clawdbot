---
summary: "QMD memory backend removal and migration"
read_when:
  - Migrating an installation that used the QMD memory backend
title: "QMD memory backend removal"
---

# QMD memory backend removal

The optional QMD memory backend has been removed. Builtin memory is now the only memory engine.

Run `openclaw doctor --fix` to remove retired `memory.backend`, `memory.qmd.*`, and
`memory.search.qmd.*` settings, including agent-scoped variants. Your Markdown memory sources are
indexed by the builtin engine on its next sync. Doctor preserves configured QMD paths and extra
collections in the corresponding `memory.search.extraPaths` setting. Custom QMD glob patterns are
removed; builtin memory indexes its supported files under each preserved path and reports that
change during migration. QMD indexes, exported session Markdown, downloaded models, and collection
metadata are derived state and do not require migration.

See [Memory](/concepts/memory) for the current architecture and configuration.
