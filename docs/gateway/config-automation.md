---
summary: "Automation config under cron plus the media model template variable surface"
read_when:
  - Scheduling a cron automation
  - Configuring automation failure alerts
  - Looking up media model template variables
title: "Configuration — automations and media template variables"
---

Scheduled automation keys under `cron.*`, plus the media model template variable surface.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## Automations (`cron`)

```json5
{
  cron: {
    enabled: true,
    triggers: {
      enabled: true,
    },
    webhookToken: "replace-with-dedicated-token", // optional bearer token for outbound webhook auth
    webhookSsrfPolicy: {
      allowedHostnames: ["127.0.0.1"], // optional exact exception for a trusted receiver
    },
    sessionRetention: "24h", // duration string ("0h" disables) or false
  },
}
```

- `enabled`: execute stored automation jobs (default: `true`). Set `false` to pause all automation execution without deleting jobs.
- `skipMissedJobs`: skip missed recurring (`cron`/`every`) slots at startup and advance to the next future occurrence (default: `false`). One-shot (`at`) catch-up is unchanged.
- `triggers.enabled`: run event-driven automation triggers (default: `true`). Set `false` to disable condition triggers, script payloads, and stream schedules.
- `sessionRetention`: how long to keep completed isolated automation run sessions before pruning SQLite session rows. Also controls cleanup of archived deleted automation transcripts. Default: `24h`; set `false` or a zero duration such as `"0h"` to disable (negative durations are invalid).
- Terminal run history is retained for 7 days (`lost` rows for 24 hours), with the newest 2000 rows per job and history class enforced as an additional ceiling.
- `webhookToken`: bearer token used for automation webhook POST delivery (`delivery.mode = "webhook"`), if omitted no auth header is sent.
- `webhookSsrfPolicy`: shared outbound SSRF policy for primary, completion, failure-destination, and failure-alert webhooks. Private/internal targets are blocked when omitted. Prefer exact `allowedHostnames`; use `dangerouslyAllowPrivateNetwork: true` only for trusted private-network receivers. The narrow fake-IP proxy flags are `allowRfc2544BenchmarkRange` and `allowIpv6UniqueLocalRange`.
- `webhookSsrfPolicy.blockedHostnames`: denies exact hosts and wildcard subdomains before DNS and all allow rules. `*.example.com` excludes the apex; add `example.com` separately to block it. Empty or unset adds no denials.

The `cron` block is strict; `cron.enabled`, `cron.skipMissedJobs`, `cron.triggers`, `cron.webhookToken`,
`cron.webhookSsrfPolicy`, `cron.sessionRetention`, and `cron.failureAlert` are the only accepted keys. The
retired `cron.webhook` fallback URL is gone: runtime delivery uses per-job
`delivery.mode = "webhook"` plus `delivery.to`, or `delivery.completionDestination`
when preserving announce delivery. `openclaw doctor --fix` strips a leftover
`cron.webhook` from existing config files.

### `cron.failureAlert`

```json5
{
  cron: {
    failureAlert: {
      enabled: false,
      after: 2,
      cooldownMs: 3600000,
      includeSkipped: false,
      mode: "announce",
      channel: "last",
      to: "channel:C1234567890",
      accountId: "main",
    },
  },
}
```

`cron.failureAlert` owns the global alert policy and its default destination. Jobs
with an existing failure route are covered by default after 2 consecutive
execution failures with a 1-hour cooldown; a `cron.failureAlert` object explicitly
activates/tunes the policy even when no route existed. The retired
`cron.failureDestination` block is merged into it by
[`openclaw doctor --fix`](/cli/doctor).

- `enabled`: explicitly enable or disable the global policy. `false` disables inherited notifications unless a job has its own `failureAlert` object; `true` explicitly enables globally. Omitting it preserves route-backed defaults.
- `after`: consecutive failures before an alert fires (positive integer, min: `1`; default: `2`).
- `cooldownMs`: minimum milliseconds between repeated alerts for the same job (non-negative integer; default: `3600000`).
- `includeSkipped`: count consecutive skipped runs toward the alert threshold (default: `false`). Skipped runs are tracked separately and do not affect execution-error backoff.
- `mode`: delivery mode - `"announce"` sends via a channel message; `"webhook"` posts to the target in `to`. Defaults to `"announce"` when enough target data exists.
- `channel`: channel override for announce delivery. `"last"` reuses the last known delivery channel.
- `to`: explicit announce target or webhook URL. Required for webhook mode.
- `accountId`: optional account or channel id to scope alert delivery.
- Route precedence is per-job `failureAlert` route fields, then per-job `delivery.failureDestination` layered over these global destination fields, then the primary announce target.
- Per-job `failureAlert: false` disables execution and required-delivery failure alerts for that job; the auto-disable safety notification remains active. Any per-job `failureAlert` object explicitly enables and tunes that job.
- `delivery.bestEffort: true` suppresses inherited/default execution alerts; an explicit per-job `failureAlert` remains authoritative.
- Required completion-delivery failure (`status: "ok"`, `completionStatus: "failed"`) does not increment execution backoff and may notify immediately only through a resolved alternate failure destination, not the failed primary route.
- `delivery.failureDestination` is only supported for `sessionTarget="isolated"` jobs unless the job's primary `delivery.mode` is `"webhook"`.

See [Automations](/automation/cron-jobs). Isolated automation runs are tracked as [background tasks](/automation/tasks).

## Media model template variables

Template placeholders expanded in `tools.media.models[].args`:

| Variable                    | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `{{Body}}`                  | Full inbound message body                         |
| `{{RawBody}}`               | Raw body (no history/sender wrappers)             |
| `{{BodyStripped}}`          | Body with group mentions stripped                 |
| `{{From}}`                  | Sender identifier                                 |
| `{{To}}`                    | Destination identifier                            |
| `{{MessageSid}}`            | Channel message id                                |
| `{{SessionId}}`             | Current session UUID                              |
| `{{IsNewSession}}`          | `"true"` when new session created                 |
| `{{AttachmentUrl}}`         | Current attachment URL or provider reference      |
| `{{AttachmentPath}}`        | Current attachment local path                     |
| `{{AttachmentContentType}}` | Current attachment MIME content type              |
| `{{AttachmentDir}}`         | Directory containing `AttachmentPath`             |
| `{{AttachmentIndex}}`       | Zero-based source fact index                      |
| `{{Transcript}}`            | Audio transcript                                  |
| `{{Prompt}}`                | Resolved media prompt for CLI entries             |
| `{{MaxChars}}`              | Resolved max output chars for CLI entries         |
| `{{ChatType}}`              | `"direct"` or `"group"`                           |
| `{{GroupSubject}}`          | Group subject (best effort)                       |
| `{{GroupMembers}}`          | Group members preview (best effort)               |
| `{{SenderName}}`            | Sender display name (best effort)                 |
| `{{SenderE164}}`            | Sender phone number (best effort)                 |
| `{{Provider}}`              | Provider hint (whatsapp, telegram, discord, etc.) |

The legacy `{{MediaPath}}`, `{{MediaUrl}}`, `{{MediaType}}`, and `{{MediaDir}}`
names remain available during the plugin SDK compatibility window but are
deprecated. New configuration should use the `Attachment*` variables.

---
