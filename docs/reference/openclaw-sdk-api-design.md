---
summary: "Reference design for the public OpenClaw App SDK API, event taxonomy, artifacts, approvals, and package structure"
title: "OpenClaw App SDK API design"
sidebarTitle: "App SDK API design"
read_when:
  - You are implementing the proposed public OpenClaw app SDK
  - You need the draft namespace, event, result, artifact, approval, or security contract for the app SDK
  - You are comparing Gateway protocol resources with the high-level OpenClaw App SDK wrapper
---

This page is the detailed API reference design for the public
[OpenClaw App SDK](/concepts/openclaw-sdk). It is intentionally separate from
the [Plugin SDK](/plugins/sdk-overview).

<Note>
  `@openclaw/sdk` is the external app/client package for talking to the
  Gateway. `openclaw/plugin-sdk/*` is the in-process plugin authoring contract.
  Do not import Plugin SDK subpaths from apps that only need to run agents.
</Note>

The public app SDK should be built in two layers:

1. A low-level generated Gateway client.
2. A high-level ergonomic wrapper with `OpenClaw`, `Agent`, `Session`, `Run`,
   `Task`, `Artifact`, `Approval`, and `Environment` objects.

## Namespace design

The low-level namespaces should closely follow Gateway resources:

```typescript
oc.agents.list();
oc.agents.get("main");
oc.agents.create(...);
oc.agents.update(...);

oc.sessions.list();
oc.sessions.create(...);
oc.sessions.resolve(...);
oc.sessions.send(...);
oc.sessions.messages(...);
oc.sessions.fork(...);
oc.sessions.compact(...);
oc.sessions.abort(...);

oc.runs.create(...);
oc.runs.get(runId);
oc.runs.events(runId, { after });
oc.runs.wait(runId);
oc.runs.cancel(runId);

oc.tasks.list({ status: "running" });
oc.tasks.get(taskId);
oc.tasks.cancel(taskId, { reason });
oc.tasks.events(taskId, { after }); // future API

oc.models.list();
oc.models.status(); // Gateway models.authStatus

oc.tools.list();
oc.tools.invoke("tool-name", { sessionKey, idempotencyKey });

oc.artifacts.list({ runId });
oc.artifacts.get(artifactId, { runId });
oc.artifacts.download(artifactId, { runId });

oc.approvals.list();
oc.approvals.respond(approvalId, ...);

oc.environments.list();
oc.environments.create(...); // future API: current SDK throws unsupported
oc.environments.status(environmentId);
oc.environments.delete(environmentId); // future API: current SDK throws unsupported
```

High-level wrappers should return objects that make common flows pleasant:

```typescript
const run = await agent.run(inputOrParams);
await run.cancel();
await run.wait();

for await (const event of run.events()) {
  // normalized event stream
}

const artifacts = await run.artifacts.list();
const session = await run.session();
```

## Event contract

The public SDK should expose versioned, replayable, normalized events.

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
  raw?: unknown;
};
```

`id` is a replay cursor. Consumers should be able to reconnect with
`events({ after: id })` and receive missed events when retention allows.

Recommended normalized event families:

| Event                 | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `run.created`         | Run accepted.                                               |
| `run.queued`          | Run is waiting for a session lane, runtime, or environment. |
| `run.started`         | Runtime started execution.                                  |
| `run.completed`       | Run finished successfully.                                  |
| `run.failed`          | Run ended with an error.                                    |
| `run.cancelled`       | Run was cancelled.                                          |
| `run.timed_out`       | Run exceeded its timeout.                                   |
| `assistant.delta`     | Assistant text delta.                                       |
| `assistant.message`   | Complete assistant message or replacement.                  |
| `thinking.delta`      | Reasoning or plan delta, when policy allows exposure.       |
| `tool.call.started`   | Tool call began.                                            |
| `tool.call.delta`     | Tool call streamed progress or partial output.              |
| `tool.call.completed` | Tool call returned successfully.                            |
| `tool.call.failed`    | Tool call failed.                                           |
| `approval.requested`  | A run or tool needs approval.                               |
| `approval.resolved`   | Approval was granted, denied, expired, or cancelled.        |
| `question.requested`  | Runtime asks the user or host app for input.                |
| `question.answered`   | Host app supplied an answer.                                |
| `artifact.created`    | New artifact available.                                     |
| `artifact.updated`    | Existing artifact changed.                                  |
| `session.created`     | Session created.                                            |
| `session.updated`     | Session metadata changed.                                   |
| `session.compacted`   | Session compaction happened.                                |
| `task.updated`        | Background task state changed.                              |
| `git.branch`          | Runtime observed or changed branch state.                   |
| `git.diff`            | Runtime produced or changed a diff.                         |
| `git.pr`              | Runtime opened, updated, or linked a pull request.          |

Runtime-native payloads should be available through `raw`, but apps should not
have to parse `raw` for normal UI.

## Result contract

`Run.wait()` should return a stable result envelope:

```typescript
type RunResult = {
  runId: string;
  status: "accepted" | "completed" | "failed" | "cancelled" | "timed_out";
  sessionId?: string;
  sessionKey?: string;
  taskId?: string;
  startedAt?: string | number;
  endedAt?: string | number;
  output?: {
    text?: string;
    messages?: SDKMessage[];
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  artifacts?: ArtifactSummary[];
  error?: SDKError;
};
```

The result should be boring and stable. Timestamp values preserve the Gateway
shape, so current lifecycle-backed runs usually report epoch millisecond
numbers while adapters may still surface ISO strings. Rich UI, tool traces, and
runtime-native details belong in events and artifacts.

`accepted` is a non-terminal wait result: it means the Gateway wait deadline
expired before the run produced a lifecycle end/error. It must not be treated as
`timed_out`; `timed_out` is reserved for a run that exceeded its own runtime
timeout.

## Approvals and questions

Approvals must be first-class because coding agents constantly cross safety
boundaries.

```typescript
run.onApproval(async (request) => {
  if (request.kind === "tool" && request.toolName === "exec") {
    return request.approveOnce({ reason: "CI command allowed by policy" });
  }

  return request.askUser();
});
```

Approval events should carry:

- approval id
- run id and session id
- request kind
- requested action summary
- tool name or environment action
- risk level
- available decisions
- expiration
- whether the decision can be reused

Questions are separate from approvals. A question asks the user or host app for
information. An approval asks for permission to perform an action.

## ToolSpace model

Apps need to understand the tool surface without importing plugin internals.

```typescript
const tools = await run.toolSpace();

for (const tool of tools.list()) {
  console.log(tool.name, tool.source, tool.requiresApproval);
}
```

The SDK should expose:

- normalized tool metadata
- source: OpenClaw, MCP, plugin, channel, runtime, or app
- schema summary
- approval policy
- runtime compatibility
- whether a tool is hidden, readonly, write capable, or host capable

Tool invocation through the SDK should be explicit and scoped. Most apps should
run agents, not call arbitrary tools directly.

## Artifact model

Artifacts should cover more than files.

```typescript
type ArtifactSummary = {
  id: string;
  runId?: string;
  sessionId?: string;
  type:
    | "file"
    | "patch"
    | "diff"
    | "log"
    | "media"
    | "screenshot"
    | "trajectory"
    | "pull_request"
    | "workspace";
  title?: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt: string;
  expiresAt?: string;
};
```

Common examples:

- file edits and generated files
- patch bundles
- VCS diffs
- screenshots and media outputs
- logs and trace bundles
- pull request links
- runtime trajectories
- managed environment workspace snapshots

Artifact access should support redaction, retention, and download URLs without
assuming every artifact is a normal local file.

## Security model

The app SDK must be explicit about authority.

Recommended token scopes:

| Scope               | Allows                                              |
| ------------------- | --------------------------------------------------- |
| `agent.read`        | List and inspect agents.                            |
| `agent.run`         | Start runs.                                         |
| `session.read`      | Read session metadata and messages.                 |
| `session.write`     | Create, send to, fork, compact, and abort sessions. |
| `task.read`         | Read background task state.                         |
| `task.write`        | Cancel or modify task notification policy.          |
| `approval.respond`  | Approve or deny requests.                           |
| `tools.invoke`      | Invoke exposed tools directly.                      |
| `artifacts.read`    | List and download artifacts.                        |
| `environment.write` | Create or destroy managed environments.             |
| `admin`             | Administrative operations.                          |

Defaults:

- no secret forwarding by default
- no unrestricted environment variable pass-through
- secret references instead of secret values
- explicit sandbox and network policy
- explicit remote environment retention
- approvals for host execution unless policy proves otherwise
- raw runtime events redacted before they leave Gateway unless the caller has a
  stronger diagnostic scope

## Managed environment provider

Managed agents should be implemented as environment providers.

```typescript
type EnvironmentProvider = {
  id: string;
  capabilities: {
    checkout?: boolean;
    sandbox?: boolean;
    networkPolicy?: boolean;
    secrets?: boolean;
    artifacts?: boolean;
    logs?: boolean;
    pullRequests?: boolean;
    longRunning?: boolean;
  };
};
```

The first implementation does not need to be a hosted SaaS. It can target
existing node hosts, ephemeral workspaces, CI-style runners, or Testbox-style
environments. The important contract is:

1. prepare workspace
2. bind safe environment and secrets
3. start run
4. stream events
5. collect artifacts
6. clean up or retain by policy

Once this is stable, a hosted cloud service can implement the same provider
contract.

## Package structure

Recommended packages:

| Package                 | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `@openclaw/sdk`         | Public high-level SDK and generated low-level Gateway client. |
| `@openclaw/sdk-react`   | Optional React hooks for dashboards and app builders.         |
| `@openclaw/sdk-testing` | Test helpers and fake Gateway server for app integrations.    |

The repo already has `openclaw/plugin-sdk/*` for plugins. Keep that namespace
separate to avoid confusing plugin authors with app developers.

## Generated client strategy

The low-level client should be generated from versioned Gateway protocol
schemas, then wrapped by handwritten ergonomic classes.

Layering:

1. Gateway schema source of truth.
2. Generated low-level TypeScript client.
3. Runtime validators for external inputs and event payloads.
4. High-level `OpenClaw`, `Agent`, `Session`, `Run`, `Task`, and `Artifact`
   wrappers.
5. Cookbook examples and integration tests.

Benefits:

- protocol drift is visible
- tests can compare generated methods with Gateway exports
- App SDK stays independent from Plugin SDK internals
- low-level consumers still have full protocol access
- high-level consumers get the small product API

## Related

- [OpenClaw App SDK](/concepts/openclaw-sdk)
- [Gateway RPC reference](/reference/rpc)
- [Agent loop](/concepts/agent-loop)
- [Agent runtimes](/concepts/agent-runtimes)
- [Background tasks](/automation/tasks)
- [ACP agents](/tools/acp-agents)
- [Plugin SDK overview](/plugins/sdk-overview)
