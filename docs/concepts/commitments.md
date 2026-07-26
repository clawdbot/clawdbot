---
summary: "Status and cleanup guidance for retired inferred follow-up commitments"
title: "Inferred commitments"
sidebarTitle: "Commitments"
read_when:
  - You are upgrading a configuration that used inferred commitments
  - You want to inspect or dismiss previously stored follow-up records
---

The inferred commitments experiment is retired. OpenClaw no longer extracts new
conversation follow-ups or delivers them through heartbeat, and the former
`commitments` config block is removed by `openclaw doctor --fix`.

Exact reminders and scheduled work continue to use
[scheduled tasks](/automation/cron-jobs). Durable conversational facts belong in
[memory](/concepts/memory).

## Existing records

Previously stored commitments remain in the shared SQLite state database so an
upgrade does not destroy operator-visible history. Use the legacy maintenance
CLI to inspect or dismiss those rows:

```bash
openclaw commitments --all
openclaw commitments dismiss cm_abc123
```

See [`openclaw commitments`](/cli/commitments) for the maintenance command
reference.

## Related

- [Scheduled tasks](/automation/cron-jobs)
- [Memory overview](/concepts/memory)
- [Heartbeat](/gateway/heartbeat)
