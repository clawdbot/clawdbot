---
summary: "CLI reference for `clawdbot status` (diagnostics, probes, usage snapshots)"
read_when:
  - You want a quick diagnosis of channel health + recent session recipients
  - You want a pasteable “all” status for debugging
---

# `clawdbot status`

Diagnostics for channels + sessions.

```bash
clawdbot status
clawdbot status --all
clawdbot status --deep
clawdbot status --usage
```

Notes:
- `--deep` runs live probes (WhatsApp Web + Telegram + Discord + Slack + Signal).
- Output includes per-agent session stores when multiple agents are configured.
- Overview includes Gateway + Node service install/runtime status when available.
- Overview includes update channel + git SHA (for source checkouts).
- Update info surfaces in the Overview; if an update is available, status prints a hint to run `clawdbot update` (see [Updating](/install/updating)).
