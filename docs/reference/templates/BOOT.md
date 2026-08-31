---
summary: "Workspace template for BOOT.md"
title: "BOOT.md template"
read_when:
  - Adding a BOOT.md checklist
---

# BOOT.md

Add short, explicit startup instructions here. The bundled `boot-md` hook runs this file once per agent workspace every time the gateway starts, if the file exists and has non-whitespace content. Multiple agents sharing a workspace only trigger one run.

The hook ships disabled. Enable it first:

```bash
openclaw hooks enable boot-md
```

If a checklist item sends a message, use the message tool, then reply with the exact silent token `NO_REPLY` (case-insensitive).

## Related

- [Agent workspace](/concepts/agent-workspace)
- [Hooks](/automation/hooks#boot-md)
