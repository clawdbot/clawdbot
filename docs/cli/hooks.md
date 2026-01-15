---
summary: "CLI reference for `clawdbot hooks` (Gmail Pub/Sub + webhook helpers)"
read_when:
  - You want to wire Gmail Pub/Sub events into Clawdbot hooks
  - You want to run the gog watch service and renew loop
---

# `clawdbot hooks`

Webhook helpers and hook-based integrations.

Related:
- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
clawdbot hooks gmail setup --account you@example.com
clawdbot hooks gmail run
```

