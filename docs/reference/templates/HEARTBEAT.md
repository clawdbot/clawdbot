---
summary: "Workspace template for HEARTBEAT.md"
title: "HEARTBEAT.md template"
read_when:
  - Bootstrapping a workspace manually
---

# HEARTBEAT.md template

`HEARTBEAT.md` lives in the agent workspace. Keep the file empty, or with only Markdown comments and headings, when you want OpenClaw to skip heartbeat model calls.

The default runtime template is:

```markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
```

Add short tasks below the comments only when you want the agent to check something periodically. Keep heartbeat instructions small because they are read during recurring wakes.

## Related

- [Heartbeat config](/gateway/config-agents)
