---
summary: "CLI reference for `clawdbot logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
---

# `clawdbot logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:
- Logging overview: [Logging](/logging)

## Examples

```bash
clawdbot logs
clawdbot logs --follow
clawdbot logs --json
clawdbot logs --limit 500
```

