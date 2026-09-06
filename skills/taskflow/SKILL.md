---
name: taskflow
description: "Run approval-gated workflows with durable TaskFlow state; distinguish workflow execution from linking real detached tasks."
metadata: { "openclaw": { "emoji": "🪝" } }
---

# TaskFlow

Use a managed TaskFlow for multi-step work with one owner, bounded state and explicit waits. A single detached ACP/subagent run with deliverable completion gets a mirrored flow automatically; it does not need a second managed flow.

## Run a workflow

Use the available `lobster` tool in a non-sandboxed session with the Lobster plugin installed, activated and allowed. This skill is guidance, not plugin registration: it does not provide an `api` object or a task-launch tool.

The examples require Node on the Gateway host and use synthetic, already-classified data. They route every item, pause for approval, then return the routing result. They do not read mail, send messages, modify PRs or launch detached children. Paths below assume the Gateway working directory is the repository root; otherwise use the example file's absolute path.

```json
{
  "action": "run",
  "pipeline": "skills/taskflow/examples/inbox-triage.lobster",
  "flowControllerId": "lobster/inbox-triage",
  "flowGoal": "Review synthetic inbox routing",
  "maxStdoutBytes": 8192
}
```

For PR intake, use `skills/taskflow/examples/pr-intake.lobster` and controller `lobster/pr-intake` instead. Its intents are `close`, `request_changes`, `refactor` and `maintainer_review`; no GitHub actions occur.

## Approve and resume

Read the tool result's `details` (also rendered as JSON text). It contains `status`, `requiresApproval`, `flow` and `mutation` directly, not a nested `envelope`.

1. For a non-cancelled result, require `mutation.applied === true`. Otherwise report its `code` and stop; workflow success alone does not prove the flow update persisted.
2. For `needs_approval`, present `requiresApproval.prompt` and `items`, then wait for the user's decision.
3. In the same owner session, build a separate `action: "resume"` call with the returned `resumeToken` as `token` (or the returned `approvalId`), `flowId` from `mutation.flow.flowId`, `flowExpectedRevision` from `mutation.flow.revision`, and `approve` set to the user's decision. Keep `maxStdoutBytes: 8192` on resume.

Use the **post-mutation** revision, not the older top-level `flow.revision`. Set `approve: false` only when the user declines. On approval, check the new `mutation.applied` and flow status; on cancellation, check `mutation.cancelled`. Report errors, rejected mutations and pending cancellations rather than claiming completion. Do not blindly retry side effects after a revision conflict: reload and reconcile first.

## Complete the goal

A linked child reaching a terminal state does not finish a managed flow. Compare its result with the flow goal, schedule the next in-scope step, and call `finish(...)` only after the goal's acceptance condition is verified.

Persist explicit acceptance state in `stateJson` for terminal-outcome workflows. For example, a PR-landing flow should remain running or waiting through review and CI, and finish only after the hosting service reports the PR as merged.

## Durable state is not a scheduler

TaskFlow records persist in SQLite. Controllers must reload the latest record and explicitly resume; arbitrary JavaScript and in-flight work are not replayed. Lobster approval pauses are not listeners for Slack replies. Keep persisted state to bounded IDs, route summaries and cursors, not full messages or histories.

Plugin authors use `api.runtime.tasks.managedFlows`; `flows` and `runs` provide owner-scoped lookups. `runTask` links an **already launched, authoritative** ACP/subagent execution with matching owner and canonical run/session IDs; it never launches one. Do not invent IDs, timestamps or backing records. See the [plugin launch/link contract](https://docs.openclaw.ai/plugins/sdk-runtime) and [Task Flow](https://docs.openclaw.ai/automation/taskflow).

For inbox routing and real-adapter requirements, read `skills/taskflow-inbox-triage/SKILL.md`. For tool setup, see [Lobster](https://docs.openclaw.ai/tools/lobster).
