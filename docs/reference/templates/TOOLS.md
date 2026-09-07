---
summary: "Optional workspace file for local environment notes"
title: "TOOLS.md"
read_when:
  - Bootstrapping a workspace manually
---

# TOOLS.md - local environment notes

Create `TOOLS.md` at the configured agent workspace root if you want to keep local
environment notes separate from operating instructions. Keeping those notes in
the `## Tools` section of `AGENTS.md` remains supported. Skills define how tools
work; neither notes location controls tool availability.

OpenClaw loads this file only when it exists. Setup does not create it, and its
absence adds no missing-file prompt marker or editor tab. Existing files appear
under **Settings → Agents → Files**. The normal bootstrap read and injection
limits apply.

```markdown
# Local environment

## Devices

- Office speaker: use for spoken summaries when requested.

## Toolchain

- Project environments have their own dependency instructions.
- Check the current repository before choosing a package manager.
```

These notes can reach subagents and ordinary cron runs; keep secrets and private
user memory out of them. Lightweight runs still exclude workspace context.

`openclaw doctor --fix` does not merge or delete this file. If an older version
already migrated it, review the notes in `AGENTS.md` before moving anything back;
OpenClaw does not split that section or restore archives automatically.

See the [workspace limitations](/concepts/agent-workspace#optional-toolsmd-limitations)
before using this file with sandbox workspaces or metadata-governed tool declarations.

See the [AGENTS.md template](/reference/templates/AGENTS) and [agent workspace guide](/concepts/agent-workspace).
