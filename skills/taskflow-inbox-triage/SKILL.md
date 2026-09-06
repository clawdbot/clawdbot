---
name: taskflow-inbox-triage
description: "Preview synthetic inbox routing with a real TaskFlow approval pause, and identify the adapters needed for live triage."
metadata: { "openclaw": { "emoji": "📥" } }
---

# TaskFlow inbox triage

Use `skills/taskflow/examples/inbox-triage.lobster` through the managed Lobster run/approval/resume procedure in `skills/taskflow/SKILL.md`. The default batch is synthetic and already classified. The workflow routes all items into `business`, `personal` and `later` ID lists, suspends for actual approval, then returns those lists without sending anything.

## Input and result

Each item has a nonempty `id` (at most 80 characters) and `route` (`business`, `personal` or `later`). The batch is capped at 20 items. Invalid input fails visibly; an empty batch yields three empty lists. Override the defaults with `argsJson` on the initial run, for example:

```json
{
  "items": [
    { "id": "demo-business-1", "route": "business" },
    { "id": "demo-personal-1", "route": "personal" },
    { "id": "demo-later-1", "route": "later" },
    { "id": "demo-business-2", "route": "business" }
  ]
}
```

Pass this object serialized as the `argsJson` string. Use synthetic IDs when trying the example. Approval confirms the preview only; it does not authorize or perform real delivery.

## Connect real inbox work explicitly

A real controller needs an inbox reader and classifier that produce the bounded input above, plus adapters for these routes:

| Route      | Real controller responsibility                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `business` | Post through an authorized Slack adapter, persist the returned thread ID, then wait for a correlated human reply. |
| `personal` | Notify the owner through an authorized channel adapter and record the delivery outcome.                           |
| `later`    | Retain a bounded summary reference for an explicitly scheduled end-of-day run.                                    |

These adapters are **not supplied** by the example. Classify every item before routing it; do not decide a mixed batch from its first element. Use a directly available classification tool or a real adapter, not an assumed embedded `openclaw.invoke` bridge. Keep approvals before real side effects.

For business replies, the controller registers the event listener, calls `setWaiting` with bounded thread correlation in `waitJson`, and resumes only after the matching reply arrives. A Lobster approval token, echoed waiting JSON or a `setWaiting` call alone does not install that listener. Embedded Lobster input/`ask` requests are not supported.

If classification uses detached work, launch it through the [public requester-bound plugin path](https://docs.openclaw.ai/plugins/sdk-runtime) before linking it with `runTask`. Wait for actual completion before interpreting results; `pending` or an observation timeout is not terminal failure. On failure, record a failed/blocked flow outcome and report it. Do not synthesize a child after launch or linkage is refused.

Persist only the IDs, small summaries and cursor needed to continue. After restart or a revision conflict, reload the owner-bound flow and reconcile before applying the next transition. Check every mutation, including `finish`; do not report success from an unchecked result. See [Task Flow](https://docs.openclaw.ai/automation/taskflow) for controller-driven resumption and cancellation.
