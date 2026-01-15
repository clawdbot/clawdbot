---
summary: "CLI reference for `clawdbot reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
---

# `clawdbot reset`

Reset local config/state (keeps the CLI installed).

```bash
clawdbot reset
clawdbot reset --dry-run
clawdbot reset --scope config+creds+sessions --yes --non-interactive
```

