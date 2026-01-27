---
summary: "CLI reference for `moltbot reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
---

# `moltbot reset`

Reset local config/state (keeps the CLI installed).

```bash
moltbot reset
moltbot reset --dry-run
moltbot reset --scope config+creds+sessions --yes --non-interactive
```

