---
doc-schema-version: 1
summary: "Command ladder and fixes for jobs that do not fire or do not deliver"
read_when:
  - An automation did not fire at its scheduled time
  - A job ran but nothing arrived in chat
  - Diagnosing timezone or session rollover surprises
title: "Automation troubleshooting"
sidebarTitle: "Troubleshooting"
---

A command ladder and the common failure shapes for scheduled jobs. Part of the [Automations](/automation/cron-jobs) guide.

## Troubleshooting

### Command ladder

```bash
openclaw status
openclaw gateway status
openclaw automations status
openclaw automations list
openclaw automations runs <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
openclaw doctor
```

<AccordionGroup>
  <Accordion title="Automations not firing">
    - Check `cron.enabled` and the `OPENCLAW_SKIP_CRON` env var.
    - Confirm the Gateway is running continuously.
    - For `cron` schedules, verify timezone (`--tz`) vs the host timezone.
    - `reason: not-due` in run output means the manual run was checked with `openclaw automations run <jobId> --due` and the job was not due yet.

  </Accordion>
  <Accordion title="Job fired but no delivery">
    - Delivery mode `none` means no runner fallback send is expected. The agent can still send directly with the `message` tool when a chat route is available.
    - Delivery target missing/invalid (`channel`/`to`) means outbound was skipped.
    - For Matrix, copied or legacy jobs with lowercased `delivery.to` room IDs can fail because Matrix room IDs are case-sensitive. Edit the job to the exact `!room:server` or `room:!room:server` value from Matrix.
    - Channel auth errors (`unauthorized`, `Forbidden`) mean delivery was blocked by credentials.
    - When the dispatcher records intentional suppression, job state, run history, and finished events include `deliverySuppressionReason` (`empty`, `silent`, `heartbeat`, or `channel_transform`). This is separate from `lastDeliveryError` / `deliveryError`; required delivery failures also log an error when they happen.
    - If the isolated run returns only the silent token (`NO_REPLY` / `no_reply`), OpenClaw suppresses direct outbound delivery and the fallback queued-summary path, so nothing is posted back to chat.
    - If the agent should message the user itself, check that the job has a usable route (`channel: "last"` with a previous chat, or an explicit channel/target).

  </Accordion>
  <Accordion title="Automations or heartbeat appear to prevent /new-style rollover">
    - Daily and idle reset freshness is not based on `updatedAt`; see [Session management](/concepts/session#session-lifecycle).
    - Automation wakeups, heartbeat runs, exec notifications, and gateway bookkeeping may update the session row for routing/status, but they do not extend `sessionStartedAt` or `lastInteractionAt`.
    - For legacy rows created before those fields existed, OpenClaw can recover `sessionStartedAt` from the transcript JSONL session header when the file is still available. Legacy idle rows without `lastInteractionAt` use that recovered start time as their idle baseline.

  </Accordion>
  <Accordion title="Timezone gotchas">
    - Cron expressions without `--tz` use the gateway host timezone.
    - `at` schedules without timezone are treated as UTC.
    - Heartbeat `activeHours` uses configured timezone resolution.

  </Accordion>
</AccordionGroup>
