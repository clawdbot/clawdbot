---
summary: "Public OpenClaw App SDK for external apps, scripts, dashboards, CI jobs, and IDE extensions"
title: "OpenClaw App SDK"
sidebarTitle: "App SDK"
read_when:
  - You are building an external app, script, dashboard, CI job, or IDE extension that talks to OpenClaw
  - You are choosing between the App SDK and the Plugin SDK
  - You are integrating with Gateway agent runs, sessions, events, approvals, models, or tools
---

The **OpenClaw App SDK** is the public client API for apps outside the
OpenClaw process. Use `@openclaw/sdk` when a script, dashboard, CI job, IDE
extension, or other external app wants to connect to the Gateway, start agent
runs, stream events, wait for results, cancel work, or inspect Gateway
resources.

<Note>
  The App SDK is different from the [Plugin SDK](/plugins/sdk-overview).
  `@openclaw/sdk` talks to the Gateway from outside OpenClaw.
  `openclaw/plugin-sdk/*` is only for plugins that run inside OpenClaw and
  register providers, channels, tools, hooks, or trusted runtimes.
</Note>

## What ships today

`@openclaw/sdk` ships with:

| Surface                   | Status  | What it does                                                                      |
| ------------------------- | ------- | --------------------------------------------------------------------------------- |
| `OpenClaw`                | Ready   | Main client entry point. Owns transport, connection, requests, and events.        |
| `GatewayClientTransport`  | Ready   | WebSocket transport backed by the Gateway client.                                 |
| `oc.agents`               | Ready   | Lists, creates, updates, deletes, and gets agent handles.                         |
| `Agent.run()`             | Ready   | Starts a Gateway `agent` run and returns a `Run`.                                 |
| `oc.runs`                 | Ready   | Creates, gets, waits for, cancels, and streams runs.                              |
| `Run.events()`            | Ready   | Streams normalized per-run events with replay for fast runs.                      |
| `Run.wait()`              | Ready   | Calls `agent.wait` and returns a stable `RunResult`.                              |
| `Run.cancel()`            | Ready   | Calls `sessions.abort` by run id, with session key when available.                |
| `oc.sessions`             | Ready   | Creates, resolves, sends to, patches, compacts, and gets session handles.         |
| `Session.send()`          | Ready   | Calls `sessions.send` and returns a `Run`.                                        |
| `oc.tasks`                | Ready   | Lists, reads, and cancels Gateway task ledger entries.                            |
| `oc.models`               | Ready   | Calls `models.list` and the current `models.authStatus` status RPC.               |
| `oc.tools`                | Ready   | Lists, scopes, and invokes Gateway tools through the policy pipeline.             |
| `oc.artifacts`            | Ready   | Lists, gets, and downloads Gateway transcript artifacts.                          |
| `oc.approvals`            | Ready   | Lists and resolves exec approvals through Gateway approval RPCs.                  |
| `oc.environments`         | Partial | Lists Gateway-local and node environment candidates; create/delete are not wired. |
| `oc.rawEvents()`          | Ready   | Exposes raw Gateway events for advanced consumers.                                |
| `normalizeGatewayEvent()` | Ready   | Converts raw Gateway events into the stable SDK event shape.                      |

The SDK also exports the core types used by those surfaces:
`AgentRunParams`, `RunResult`, `RunStatus`, `OpenClawEvent`,
`OpenClawEventType`, `GatewayEvent`, `OpenClawTransport`,
`GatewayRequestOptions`, `SessionCreateParams`, `SessionSendParams`,
`ArtifactSummary`, `ArtifactQuery`, `ArtifactsListResult`,
`ArtifactsGetResult`, `ArtifactsDownloadResult`,
`TaskSummary`, `TaskStatus`, `TasksListParams`, `TasksListResult`,
`TasksGetResult`, `TasksCancelResult`, `RuntimeSelection`,
`EnvironmentSelection`, `WorkspaceSelection`, `ApprovalMode`, and related
result types.

## Connect to a Gateway

Create a client with an explicit Gateway URL, or inject a custom transport for
tests and embedded app runtimes.

```typescript
import { OpenClaw } from "@openclaw/sdk";

const oc = new OpenClaw({
  url: "ws://127.0.0.1:18789",
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
  requestTimeoutMs: 30_000,
});

await oc.connect();
```

`new OpenClaw({ gateway: "ws://..." })` is equivalent to `url`. The
`gateway: "auto"` option is accepted by the constructor, but automatic Gateway
discovery is not a separate SDK feature yet; pass `url` when the app does not
already know how to discover the Gateway.

For tests, pass an object that implements `OpenClawTransport`:

```typescript
const oc = new OpenClaw({
  transport: {
    async request(method, params) {
      return { method, params };
    },
    async *events() {},
  },
});
```

## Run an agent

Use `oc.agents.get(id)` when the app wants an agent handle, then call
`agent.run()`.

```typescript
const agent = await oc.agents.get("main");

const run = await agent.run({
  input: "Review this pull request and suggest the smallest safe fix.",
  model: "openai/gpt-5.5",
  sessionKey: "main",
  timeoutMs: 30_000,
});

for await (const event of run.events()) {
  const data = event.data as { delta?: unknown };
  if (event.type === "assistant.delta" && typeof data.delta === "string") {
    process.stdout.write(data.delta);
  }
}

const result = await run.wait({ timeoutMs: 120_000 });
console.log(result.status);
```

Provider-qualified model refs such as `openai/gpt-5.5` are split into Gateway
`provider` and `model` overrides. `timeoutMs` stays milliseconds in the SDK and
is converted to Gateway timeout seconds for the `agent` RPC.

`run.wait()` uses the Gateway `agent.wait` RPC. A wait deadline that expires
while the run is still active returns `status: "accepted"` instead of pretending
the run itself timed out. Runtime timeouts, aborted runs, and cancelled runs are
normalized into `timed_out` or `cancelled`.

## Create and reuse sessions

Use sessions when the app wants durable transcript state.

```typescript
const session = await oc.sessions.create({
  agentId: "main",
  label: "release-review",
});

const run = await session.send("Prepare release notes from the current diff.");
await run.wait();
```

`Session.send()` calls `sessions.send` and returns a `Run`. Session handles also
support:

```typescript
await session.abort(run.id);
await session.patch({ label: "renamed-session" });
await session.compact({ maxLines: 200 });
```

## Stream events

The SDK normalizes raw Gateway events into a stable `OpenClawEvent` envelope:

```typescript
type OpenClawEvent = {
  version: 1;
  id: string;
  ts: number;
  type: OpenClawEventType;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  taskId?: string;
  agentId?: string;
  data: unknown;
  raw?: GatewayEvent;
};
```

Common event types include:

| Event type            | Source Gateway event                        |
| --------------------- | ------------------------------------------- |
| `run.started`         | `agent` lifecycle start                     |
| `run.completed`       | `agent` lifecycle end                       |
| `run.failed`          | `agent` lifecycle error                     |
| `run.cancelled`       | Aborted/cancelled lifecycle end             |
| `run.timed_out`       | Timeout lifecycle end                       |
| `assistant.delta`     | Assistant streaming delta                   |
| `assistant.message`   | Assistant message                           |
| `thinking.delta`      | Thinking or plan stream                     |
| `tool.call.started`   | Tool/item/command start                     |
| `tool.call.delta`     | Tool/item/command update                    |
| `tool.call.completed` | Tool/item/command completion                |
| `tool.call.failed`    | Tool/item/command failure or blocked status |
| `approval.requested`  | Exec or plugin approval request             |
| `approval.resolved`   | Exec or plugin approval resolution          |
| `session.created`     | `sessions.changed` create                   |
| `session.updated`     | `sessions.changed` update                   |
| `session.compacted`   | `sessions.changed` compaction               |
| `task.updated`        | Task update events                          |
| `artifact.updated`    | Patch stream events                         |
| `raw`                 | Any event without a stable SDK mapping yet  |

`Run.events()` filters events to one run id and replays already-seen events for
fast runs. That means the documented flow is safe:

```typescript
const run = await agent.run("Summarize the latest session.");

for await (const event of run.events()) {
  if (event.type === "run.completed") {
    break;
  }
}
```

For app-wide streams, use `oc.events()`. For raw Gateway frames, use
`oc.rawEvents()`.

## Models, tools, artifacts, and approvals

Model helpers map to current Gateway methods:

```typescript
await oc.models.list();
await oc.models.status({ probe: false }); // calls models.authStatus
```

Tool helpers expose the Gateway catalog, effective tool view, and direct
Gateway tool invocation. `oc.tools.invoke()` returns a typed envelope instead
of throwing for policy or approval refusals.

```typescript
await oc.tools.list();
await oc.tools.effective({ sessionKey: "main" });
await oc.tools.invoke("tool-name", {
  args: { input: "value" },
  sessionKey: "main",
  confirm: false,
  idempotencyKey: "tool-call-1",
});
```

Artifact helpers expose the Gateway artifact projection for session, run, or
task context. Each call requires one explicit `sessionKey`, `runId`, or
`taskId` scope:

```typescript
const { artifacts } = await oc.artifacts.list({ sessionKey: "main" });
const first = artifacts[0];

if (first) {
  const { artifact } = await oc.artifacts.get(first.id, { sessionKey: "main" });
  const download = await oc.artifacts.download(artifact.id, { sessionKey: "main" });
  console.log(download.encoding, download.url);
}
```

Approval helpers use the exec approval RPCs:

```typescript
const approvals = await oc.approvals.list();
await oc.approvals.respond("approval-id", { decision: "approve" });
```

Task helpers use the durable task ledger that also backs `openclaw tasks`:

```typescript
const tasks = await oc.tasks.list({ status: "running", sessionKey: "agent:main:main" });
const task = await oc.tasks.get(tasks.tasks[0].id);
await oc.tasks.cancel(task.task.id, { reason: "user stopped task" });
```

Environment helpers expose read-only Gateway-local and node discovery:

```typescript
const { environments } = await oc.environments.list();
await oc.environments.status(environments[0].id);
```

## Explicitly unsupported today

The SDK includes names for the product model we want, but it does not silently
pretend Gateway RPCs exist. These calls currently throw explicit unsupported
errors:

```typescript
await oc.environments.create({});
await oc.environments.delete("environment-id");
```

Per-run `workspace`, `runtime`, `environment`, and `approvals` fields are typed
as future shape, but the current Gateway does not support those overrides on
the `agent` RPC. If callers pass them, the SDK throws before submitting the run
so work does not accidentally execute with default workspace, runtime,
environment, or approval behavior.

## App SDK vs Plugin SDK

Use the App SDK when code lives outside OpenClaw:

- Node scripts that start or observe agent runs
- CI jobs that call a Gateway
- dashboards and admin panels
- IDE extensions
- external bridges that do not need to become channel plugins
- integration tests with fake or real Gateway transports

Use the Plugin SDK when code runs inside OpenClaw:

- provider plugins
- channel plugins
- tool or lifecycle hooks
- agent harness plugins
- trusted runtime helpers

App SDK code should import from `@openclaw/sdk`. Plugin code should import from
documented `openclaw/plugin-sdk/*` subpaths. Do not mix the two contracts.

## Related

- [OpenClaw App SDK API design](/reference/openclaw-sdk-api-design)
- [Gateway RPC reference](/reference/rpc)
- [Agent loop](/concepts/agent-loop)
- [Agent runtimes](/concepts/agent-runtimes)
- [Sessions](/concepts/session)
- [Background tasks](/automation/tasks)
- [ACP agents](/tools/acp-agents)
- [Plugin SDK overview](/plugins/sdk-overview)
