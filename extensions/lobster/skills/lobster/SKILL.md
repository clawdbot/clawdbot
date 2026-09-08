---
name: lobster
description: Run Lobster workflows with human approval or structured review questions, and recover pending workflow input after conversation resets or restarts.
---

# Lobster workflows

Use the `lobster` tool when available to execute a pipeline or workflow file,
including a one-off task that must pause for review. Do not emulate a checkpoint
by remembering a question only in chat. A simple action with no workflow or
review need does not require Lobster.

## Choose the execution mode

- Use ordinary `run` for pipelines that finish immediately. Ordinary token-based
  approval workflows remain supported.
- For structured questions, deferred reviews, or approvals that should be
  rediscoverable, pass `flowControllerId` and `flowGoal` on the **initial** `run`.
  Choose this managed Task Flow mode from the user's intent; the user does not
  need to know the mode names.
- Do not restart an existing workflow just to switch modes: earlier steps may
  already have had effects. Inspect its state before proposing replacement work.

For an existing review workflow, for example:

```json
{
  "action": "run",
  "pipeline": "review.lobster",
  "flowControllerId": "draft-review",
  "flowGoal": "Review the prepared draft"
}
```

Use the actual workflow path, not the example filename. Check the workflow's
steps and required commands before running it; a workflow does not install
connectors, grant credentials, or schedule itself. Its control flow is defined,
but external data, commands, and model-backed steps can produce different results.

Omit `cwd` unless needed. When supplied, it must be relative to and remain inside
the Gateway's working directory, not an absolute path. This is not necessarily
the agent's workspace. Managed resume uses the saved working directory; omit
`cwd` on that call rather than copying its saved absolute value.

## Ask for the actual decision

- `needs_input`: explain `requiresInput.prompt`, relevant `subject`, and the
  fields or choices required by `responseSchema` in ordinary language. Wait for
  the user's answer. Defaults are suggestions, not answers or consent. Never
  invent a response, and clarify missing or ambiguous required values.
- `needs_approval`: present the prompt and affected items, then wait for explicit
  approval or denial. An input response is not interchangeable with approval.
- `ok`: report the actual result. `cancelled`: report that execution was cancelled;
  do not imply earlier effects were rolled back.

Do not expose checkpoint tokens in user-facing messages. Managed results include
`flow.flowId` and `flow.revision`; these identify the saved run and its current
revision. They do not grant another session access.

## Recover and resume managed work

To recover the question after compaction or a reset of the same session, call
`{"action":"status"}` to list pending flows, then
`{"action":"status","flowId":"<flowId>"}` to read `flow.waitJson` and `flow.revision`.
Follow `nextOffset` with `flowOffset` if the pending list has another page.
If several pending reviews match the request, ask which one the user means.

Respond with the selected `flow.flowId` and **returned `flow.revision`** as
`flowExpectedRevision`. Serialize the user's answer as a JSON string in
`responseJson`, for example:

```json
{
  "action": "resume",
  "flowId": "<flowId>",
  "flowExpectedRevision": 2,
  "responseJson": "{\"decision\":\"publish\"}"
}
```

The revision and answer above are illustrative; use the current saved question
and the actual answer. For an approval wait, send `approve: true` or
`approve: false` instead of `responseJson`. To cancel an input wait, send
`cancel: true` instead. Send exactly one decision. The adapter retrieves the
saved checkpoint; do not copy tokens from old conversation context.

After a schema validation error, inspect the returned wait and new revision,
clarify the answer if needed, and submit the correction with that revision.
After a revision conflict, inspect the current question and state; do not blindly
retry the same answer against a newer checkpoint. After interruption, timeout,
or an uncertain execution failure, inspect state and effects before doing more
work. Do not automatically restart or replay the workflow.

If a managed reply exceeds `maxStdoutBytes`, use its flow ID to inspect saved
state with `status` and a larger `maxStdoutBytes`. An oversized question is still
saved as a wait; do not run the workflow again just to obtain the question.

For an **ordinary** approval, resume with the returned `requiresApproval.resumeToken`
as `token` (or its `approvalId`) and the user's `approve` decision. Structured
input is only supported when the workflow was started in managed mode.

## Persistence boundaries

Waiting flows have no seven-day expiry, but both OpenClaw state and Lobster
checkpoint files must be retained. Keep the workflow file unchanged while a
review is pending: the runtime reloads it on resume. Terminal flow records remain
subject to normal cleanup; they are not a permanent audit archive.

Recovery is scoped to the same session key, including a conversation reset that
preserves that key. A new session cannot retrieve the old session's waits.
This interface does not create forms, Inbox items, reviewer assignments, or
automatic reminders. Do not promise those when presenting a pending review.
