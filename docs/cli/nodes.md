---
summary: "CLI reference for `clawdbot nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - You’re managing paired nodes (cameras, screen, canvas)
  - You need to approve requests or invoke node commands
---

# `clawdbot nodes`

Manage paired nodes (devices) and invoke node capabilities.

Related:
- Nodes overview: [Nodes](/nodes)
- Camera: [Camera nodes](/nodes/camera)
- Images: [Image nodes](/nodes/images)

## Common commands

```bash
clawdbot nodes list
clawdbot nodes pending
clawdbot nodes approve <requestId>
clawdbot nodes status
```

## Invoke / run

```bash
clawdbot nodes invoke --node <id|name|ip> --command <command> --params <json>
clawdbot nodes run --node <id|name|ip> <command...>
```

