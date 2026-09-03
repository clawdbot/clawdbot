---
name: feishu-perm
description: |
  Feishu collaborator and permission workflows. Activate when the user explicitly asks to inspect or change sharing, permissions, or collaborators.
---

# Feishu permissions

Use the single `feishu_perm` tool and its current action schema. This tool is disabled by default because it changes access to user data; if it is unavailable, explain that `channels.feishu.tools.perm` must be enabled.

## Workflow

1. Resolve the exact file token and type.
2. Use `list` to inspect current collaborators before changing access.
3. For `add`, resolve the collaborator's exact identifier and choose the least permission that satisfies the request.
4. For `remove`, confirm the exact collaborator and file when the request is ambiguous or broad.
5. Report the resulting permission change without exposing unrelated collaborator data.

Never infer an email, user ID, department, or chat from a display name alone. Follow the current schema for supported member types, token types, and permission levels.
