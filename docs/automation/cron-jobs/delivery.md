---
doc-schema-version: 1
summary: "Announce, webhook, and none delivery modes, failure alerts, and output language"
read_when:
  - Routing automation output to a channel or a webhook
  - Tuning failure notifications, thresholds, and cooldowns
  - Fixing an automation that replies in the wrong language
title: "Automation delivery"
sidebarTitle: "Delivery"
---

Where a finished run sends its output, what happens when a run or a delivery fails, and how to pin the reply language. Part of the [Automations](/automation/cron-jobs) guide.

## Delivery and output

| Mode       | What happens                                                        |
| ---------- | ------------------------------------------------------------------- |
| `announce` | Fallback-deliver final text to the target if the agent did not send |
| `webhook`  | POST finished event payload to a URL                                |
| `none`     | No runner fallback delivery                                         |

A successful primary webhook run with no nonblank summary intentionally skips the POST and records `deliverySuppressionReason: "empty"`, matching announce delivery's optional-output contract. Execution errors still send the error event even without a summary.

When `gateway.publicOrigin` is configured and the Control UI is enabled, chat
notifications include an `Inspect` link into the Control UI. Command and script
completion announcements open the automation run; isolated agent announcements
open the run's session.

For a `current` job using `announce` (the default), the final assistant result is a first-class session completion, not a WebChat-specific outbound message. OpenClaw waits for active turns in the creation-bound conversation, verifies that the same session generation still owns the key, and commits the result through the canonical transcript writer with cron job/run provenance and a job/run idempotency key. A retry cannot append the same result twice.

WebChat receives the committed `session.message` event immediately. The same assistant result comes from `chat.history` after a refresh or reconnect; no follow-up user message is required. Delivery is successful only after that transcript/event commit succeeds.

If the bound conversation is an external channel, OpenClaw also performs its normal durable channel send. That send still happens at most once, and the required session commit does not create a second external message. A verified `message` tool send suppresses the automatic channel resend but does not suppress the session commit. The run is reported delivered only after both the external recipient handoff (when required) and the canonical session commit succeed.

When the bound conversation has no external channel route — WebChat/Control UI conversations, or a gateway with no channel plugins configured — the session commit alone completes delivery and the run succeeds without attempting an external send. If the conversation does name an external route that cannot be resolved at run time, the committed result stays in the conversation and the run records the resolution failure as its delivery error: a delivery failure, not a turn failure.

For current agent-turn jobs, configuring unrelated external channels does not change this behavior. An explicit delivery channel, recipient, account, or thread still uses normal channel resolution. If that resolution fails, the report remains in the conversation and the run records the delivery error, even when no external channel could be selected.

<Warning>
  Every outbound automation webhook uses the strict SSRF guard. Loopback,
  private/internal, link-local, and other special-use targets are refused by
  default for primary delivery, completion and failure destinations, and
  failure-alert webhooks.

Allow only the receiver you trust with an exact hostname or IP exemption:

```json5
{
  cron: {
    webhookSsrfPolicy: {
      allowedHostnames: ["127.0.0.1"],
    },
  },
}
```

Use `dangerouslyAllowPrivateNetwork: true` under `webhookSsrfPolicy` only when
every configured automation webhook may reach trusted private-network
services. Leaving the policy unset keeps strict behavior.
</Warning>

Use `--announce --channel telegram --to "-1001234567890"` for channel delivery. For Telegram forum topics, use `-1001234567890:topic:123`; OpenClaw also accepts the Telegram-owned `-1001234567890:123` shorthand. Direct RPC/config callers may pass `delivery.threadId` as a string or number. Slack/Discord/Mattermost targets use explicit prefixes (`channel:<id>`, `user:<id>`). Matrix room IDs are case-sensitive; use the exact room ID or `room:!room:server` form from Matrix.

On hosts with multiple configured channels, isolated announce jobs created with `automations add|create` or changed with `automations edit` must set `--channel <channel-plugin-id>` unless a provider-prefixed `--to` or a preserved session route selects the channel. Use `--best-effort-deliver` only when unresolved fallback delivery is acceptable; it does not choose a channel, and a delivery failure does not fail the job.

Channel announcements retry transient failures only when no payload may have reached the recipient. A successful retry records delivery without retaining the earlier attempt's error, including with best-effort delivery. Partial or ambiguous sends are not replayed by the announcement retry loop.

When announce delivery uses `channel: "last"` or omits `channel`, a provider-prefixed target such as `telegram:123` can select the channel before the scheduler falls back to session history or a single configured channel. Only prefixes advertised by the loaded plugin are provider selectors. If `delivery.channel` is explicit, the target prefix must name the same provider; `channel: "whatsapp"` with `to: "telegram:123"` is rejected instead of letting WhatsApp interpret the Telegram ID as a phone number. Target-kind and service prefixes (`channel:<id>`, `user:<id>`, `imessage:<handle>`, `sms:<number>`) stay channel-owned target syntax, not provider selectors.

For isolated jobs, chat delivery is shared: if a chat route is available, the agent can use the `message` tool even with `--no-deliver`. If the agent sends to the configured/current target, OpenClaw skips the fallback announce. Otherwise `announce`, `webhook`, and `none` only control what the runner does with the final reply after the agent turn.

When an agent creates an isolated reminder from an active chat, OpenClaw stores the preserved live delivery target for the fallback announce route. Internal session keys may be lowercase; provider delivery targets are not reconstructed from those keys when current chat context is available.

Implicit announce delivery uses configured channel allowlists to validate and reroute stale targets. DM pairing-store approvals are not fallback automation recipients; set `delivery.to` or configure the channel `allowFrom` entry when a scheduled job should proactively send to a DM.

### Failure notifications

Execution failures use one scheduler-owned threshold and cooldown policy. A job with an existing failure route is covered by default after 2 consecutive failures with a 1-hour cooldown. The route can be a resolved failure destination or the job's primary announce target. Jobs with no such route stay quiet unless a per-job or global `failureAlert` object explicitly activates the policy.

Failure notification routes resolve in this order:

1. Route fields in the job's `failureAlert` object.
2. `job.delivery.failureDestination`, layered over the destination fields in global `cron.failureAlert` (`mode`, `channel`, `to`, `accountId`). The retired `cron.failureDestination` block is merged into the global object by `openclaw doctor --fix`.
3. The job's primary announce target.

- `job.failureAlert: false` disables execution and required-delivery failure alerts for that job. The auto-disable safety notification remains active.
- Global `cron.failureAlert.enabled: false` disables inherited notifications. A per-job `failureAlert` object explicitly re-enables that job; `enabled: true` explicitly enables the global policy.
- A per-job `failureAlert` object or any global `cron.failureAlert` object activates and tunes the policy even when the job had no existing route.
- `delivery.bestEffort: true` suppresses inherited/default execution-failure alerts. An explicit per-job `failureAlert` remains authoritative.
- `delivery.failureDestination` is only supported on `sessionTarget="isolated"` jobs unless the primary delivery mode is `webhook`.
- `failureAlert.includeSkipped: true` opts a job or global automation alert policy into repeated skipped-run alerts. Skipped runs keep a separate consecutive-skip counter, so they do not affect execution-error backoff.
- `openclaw automations edit` exposes per-job alert tuning: `--failure-alert`/`--no-failure-alert`, `--failure-alert-after <n>`, `--failure-alert-channel`, `--failure-alert-to`, `--failure-alert-cooldown`, `--failure-alert-include-skipped`/`--failure-alert-exclude-skipped`, `--failure-alert-mode`, and `--failure-alert-account-id`.

In the Control UI, custom failure alerts show stored threshold, cooldown, and mode overrides. An omitted channel displays the neutral `last` choice without storing it. Leave the threshold or cooldown blank, or choose **Inherit global setting** for alert mode, to use the Gateway's normal global and routing defaults. Cooldowns accept decimal seconds with millisecond precision, including `0` for no cooldown; for example, `1.001` seconds preserves `1001` milliseconds. Editing other job fields or cloning a job preserves its alert policy, including the skipped-run setting.

A required completion-delivery failure is distinct from an execution failure: a run can record `status: "ok"` with `completionStatus: "failed"`. It does not increment the execution-failure streak or backoff. A delivery-failure alert can notify through a resolved alternate failure destination without waiting for `failureAlert.after`. All such alerts, including the first delivery failure after an execution alert, honor the shared job/global `failureAlert.cooldownMs` (default 1 hour); suppressed alerts still leave the delivery failure in run history. Skipped runs and quiet trigger checks do not clear the cooldown; successful completion does. The scheduler never retries the already-failed primary route for an alert.

Chat failure notifications include the run start time in the agent's configured user timezone. When `gateway.publicOrigin` is configured and the Control UI is enabled, they also include an `Inspect` link to the automation run. Webhook message text stays stable; integrations can read the same instant from the structured `runAtMs` field and construct their own links.
Chat notifications show normalized failure causes or allowlisted producer facts for known command and script failures. Arbitrary commands, paths, provider bodies, secrets, delivery errors, skip reasons, diagnostics, and stack/error text remain in automation history. Failure webhooks retain the structured raw error for diagnostic integrations.

A provider rejection of an unsupported model records `model_not_found` in the job state and run history. The failure notice points to `openclaw doctor --fix` for provider-declared retirements, or changing/removing the automation's model override. Known retired automation model routes fail before another inference request. Doctor replaces an override with the provider's declared successor when the agent's model policy allows it. Without a declared successor, it clears the override so the job inherits the agent default. If a pinned override's successor is disallowed, Doctor retains the reference and reports the required policy change. A missing account catalog entry or a discovery outage alone does not authorize a migration.

The scheduler also provides an unconditional safety backstop. A time-based recurring job is auto-disabled after 10 consecutive execution failures; a successful run resets that streak. On the terminal failure, the richer auto-disable notification replaces the regular threshold alert. Repeated schedule-computation failures auto-disable after 3 errors. The job records `state.autoDisabled.reason` as `consecutive-failures` or `schedule-errors`, and the owning agent receives a notification with a safe cause and recovery command. Raw errors stay in automation history. After fixing the cause, run `openclaw automations enable <jobId>`; enabling clears the recorded reason and failure streaks. Because disabled jobs are hidden by the default list, use `openclaw automations list --all` to inspect them.

### Output language

Automation jobs do not infer a reply language from channel, locale, or previous messages. Put the language rule in the scheduled message or template:

```bash
openclaw automations edit <jobId> \
  --message "Summarize the updates. Respond in Chinese; keep URLs, code, and product names unchanged."
```

For template files, keep the language instruction in the rendered prompt and verify placeholders such as `{{language}}` are filled before the job runs. If the output mixes languages, make the rule explicit, for example: "Use Chinese for narrative text and keep technical terms in English."
