---
name: taskflow-inbox-triage
description: Example TaskFlow pattern for inbox triage, intent routing, waiting on replies, and later summaries.
metadata: { "openclaw": { "emoji": "📥" } }
---

# TaskFlow inbox triage

This is a concrete example of how to think about TaskFlow without turning the core runtime into a DSL.

## Goal

Triage inbox items with one owner flow:

- business → post to Slack and wait for reply
- personal → notify the owner now
- everything else → keep for end-of-day summary

## Pattern

1. Create one flow for the inbox batch.
2. Run one detached task to classify new items.
3. Persist the routing state in `stateJson`.
4. Move to `waiting` only when an outside reply is required.
5. Resume the flow when classification or human input completes.
6. Finish when the batch has been routed.

## Suggested `stateJson` shape

```json
{
  "businessThreads": [],
  "personalItems": [],
  "eodSummary": []
}
```

Suggested `waitJson` when blocked on Slack:

```json
{
  "kind": "reply",
  "channel": "slack",
  "threadKey": "slack:thread-1"
}
```

## Minimal runtime calls

```ts
const taskFlow = api.runtime.tasks.flow.fromToolContext(ctx);

const created = taskFlow.createManaged({
  controllerId: "my-plugin/inbox-triage",
  goal: "triage inbox",
  currentStep: "classify",
  stateJson: {
    businessThreads: [],
    personalItems: [],
    eodSummary: [],
  },
});

const child = taskFlow.runTask({
  flowId: created.flowId,
  runtime: "acp",
  childSessionKey: "agent:main:subagent:classifier",
  task: "Classify inbox messages",
  status: "running",
  startedAt: Date.now(),
  lastEventAt: Date.now(),
});

if (!child.created) {
  throw new Error(child.reason);
}

const waiting = taskFlow.setWaiting({
  flowId: created.flowId,
  expectedRevision: created.revision,
  currentStep: "await_business_reply",
  stateJson: {
    businessThreads: ["slack:thread-1"],
    personalItems: [],
    eodSummary: [],
  },
  waitJson: {
    kind: "reply",
    channel: "slack",
    threadKey: "slack:thread-1",
  },
});

if (!waiting.applied) {
  throw new Error(waiting.code);
}

const resumed = taskFlow.resume({
  flowId: waiting.flow.flowId,
  expectedRevision: waiting.flow.revision,
  status: "running",
  currentStep: "route_items",
  stateJson: waiting.flow.stateJson,
});

if (!resumed.applied) {
  throw new Error(resumed.code);
}

taskFlow.finish({
  flowId: resumed.flow.flowId,
  expectedRevision: resumed.flow.revision,
  stateJson: resumed.flow.stateJson,
});
```

## Related example

- `skills/taskflow/examples/inbox-triage.lobster`
