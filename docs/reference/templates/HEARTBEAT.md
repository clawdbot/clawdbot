---
summary: "Workspace template for HEARTBEAT.md"
title: "HEARTBEAT.md template"
read_when:
  - Bootstrapping a workspace manually
---

# HEARTBEAT.md template

`HEARTBEAT.md` lives in the agent workspace and holds the periodic heartbeat checklist. Keep it empty, or with only whitespace, Markdown comments, ATX headings, empty list stubs (`- `, `* [ ]`), or fence markers, to make OpenClaw skip the heartbeat model call entirely (`reason=empty-heartbeat-file`).

Shipped default content:

```markdown
<!-- Heartbeat template; comments-only content prevents scheduled heartbeat API calls. -->

# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add a short checklist below when the heartbeat should inspect shared context.
```

Add a short checklist below the comment lines only when one heartbeat turn should inspect the items together. Keep it small: heartbeat runs read this file every tick (default every 30 minutes), so bloated instructions burn tokens on every wake.

For independently scheduled or due-only checks, create [cron jobs](/automation/cron-jobs). Heartbeat scratch no longer supports scheduler syntax. Run `openclaw doctor --fix` to convert older `tasks:` blocks.

## Related

- [Heartbeat](/gateway/heartbeat)
- [Heartbeat config](/gateway/config-agents)
