---
summary: "Orchestrate concurrent sub-agents from Code Mode scripts with structured results, bounded fan-out, and live progress"
title: "Swarm"
sidebarTitle: "Swarm"
read_when:
  - You want a Code Mode script to fan out work across several agents
  - You need structured child results, decision gates, or first-completion pipelines
  - You are enabling or tuning tools.swarm limits
  - You want to observe collector children in the session dashboard
---

Swarm is an experimental, opt-in way to orchestrate many sub-agents from a
[Code Mode](/tools/code-mode) script. Use normal JavaScript or TypeScript
control flow such as `Promise.all`, `while`, and `if` to fan out work, collect
results, and make decisions.

There is no graph DSL and no separate workflow format. The program is the
orchestration. Swarm adds awaitable collector children, structured results,
bounded concurrency, and progress reporting to that program.

## Enable Swarm

The recommended path is **Settings → Labs → Swarm** in the Control UI. The
toggle takes effect immediately and writes `tools.swarm.enabled` to your
configuration.

You can also enable Swarm directly in `openclaw.json`:

```json5
{
  tools: {
    swarm: {
      enabled: true,
      maxConcurrent: 8,
      maxChildrenPerGroup: 50,
      maxTotalPerGroup: 200,
      waitTimeoutSecondsMax: 600,
      defaultAgentId: "",
    },
  },
}
```

Boolean shorthand enables or disables the feature with all other values at
their defaults:

```json5
{
  tools: {
    swarm: true,
  },
}
```

| Field                   | Default | Description                                                                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`               | `false` | Exposes collector-mode spawn options, `agents_wait`, and the Code Mode `agents.*` guest API.                                   |
| `maxConcurrent`         | `8`     | Maximum collector children running concurrently in one swarm group. Additional accepted children queue in FIFO order.          |
| `maxChildrenPerGroup`   | `50`    | Maximum live collector children in one group.                                                                                  |
| `maxTotalPerGroup`      | `200`   | Maximum collector children a group may spawn over its lifetime. This is the runaway-spawn backstop.                            |
| `waitTimeoutSecondsMax` | `600`   | Maximum timeout accepted by one `agents_wait` call. The call default is 30 seconds.                                            |
| `defaultAgentId`        | `""`    | Target agent used when a spawn omits `agentId`. An empty value uses the requesting agent. Existing sub-agent allowlists apply. |

Numeric values must be positive integers. OpenClaw bounds
`maxConcurrent` to `1`–`1000`, `maxChildrenPerGroup` to `1`–`10000`,
`maxTotalPerGroup` to `1`–`100000`, and `waitTimeoutSecondsMax` to
`1`–`86400`.

You can override Swarm for one configured agent with
`agents.list[].tools.swarm`. The per-agent object merges over the top-level
`tools.swarm` object.

## Requirements

The `agents.run`, `phase`, and `log` guest globals require both Swarm and
OpenClaw Code Mode:

```json5
{
  tools: {
    codeMode: true,
    swarm: true,
  },
}
```

Code Mode must also have effective access to `sessions_spawn`. Tool profiles,
allow/deny policy, provider rules, and sandbox policy can remove that tool.
See [Code Mode activation](/tools/code-mode#activation) and
[Sub-agents](/tools/subagents) if a script reports that `sessions_spawn` is
unavailable.

`defaultAgentId` and per-run `agentId` values must name a configured target
permitted by the requester's `subagents.allowAgents` policy. OpenClaw rejects
an unknown or disallowed target instead of falling back to another agent.

## Write a Swarm script

When Swarm is enabled, Code Mode exposes this guest API:

```typescript
type AgentRunOptions = {
  label?: string;
  model?: string;
  thinking?: string;
  fastMode?: boolean | "auto";
  agentId?: string;
  schema?: Record<string, unknown>;
  phase?: string;
};

agents.run(prompt: string, options?: AgentRunOptions & { schema?: undefined }): Promise<string>;
agents.run<T>(prompt: string, options: AgentRunOptions & { schema: Record<string, unknown> }): Promise<T>;
phase(title: string): void;
log(message: string): void;
```

Without `schema`, `agents.run()` resolves to the child's final text. With a
JSON Schema, it resolves to the value submitted through the child's
`structured_output` tool. A failed, killed, timed-out, or schema-invalid child
rejects the promise with a `SwarmAgentError`. Read the exact generated
declarations and short orchestration idioms from `API.read("agents.d.ts")`
inside Code Mode.

Use `label` for a recognizable child name in the dashboard and sidebar. Use
`phase` in the options to publish a phase immediately before that child
starts, or call `phase()` when several children belong to the same stage.
`log()` publishes a short progress note. Progress calls are fire-and-forget;
they do not delay the script if the UI is unavailable.

### Fan out in parallel with structured results

This example launches one researcher per topic, waits for all of them, then
asks a final child to synthesize their structured reports:

```javascript
const reportSchema = {
  type: "object",
  properties: {
    finding: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: ["finding", "evidence", "confidence"],
  additionalProperties: false,
};

const topics = ["authentication", "storage", "recovery"];
phase("Independent review");

const reports = await Promise.all(
  topics.map((topic) =>
    agents.run(`Review the ${topic} path. Return one finding with evidence.`, {
      label: `review-${topic}`,
      thinking: "high",
      fastMode: "auto",
      schema: reportSchema,
    }),
  ),
);

phase("Synthesis");
log(`Collected ${reports.length} independent reports.`);

return await agents.run(
  `Reconcile these reports and explain disagreements:\n${JSON.stringify(reports)}`,
  { label: "synthesis" },
);
```

`Promise.all` is the fan-out and fan-in boundary. OpenClaw starts up to
`maxConcurrent` children for the group and queues the rest in submission
order.

### Loop on a decision gate

Use a bounded `while` loop when each pass decides whether another pass is
needed:

```javascript
const gateSchema = {
  type: "object",
  properties: {
    ready: { type: "boolean" },
    reason: { type: "string" },
    nextAction: { type: "string" },
  },
  required: ["ready", "reason", "nextAction"],
  additionalProperties: false,
};

let pass = 0;
let decision = { ready: false, reason: "Not checked", nextAction: "Review" };

while (!decision.ready && pass < 4) {
  pass += 1;
  phase(`Decision pass ${pass}`);
  decision = await agents.run(
    `Check whether the release evidence is complete. Previous decision: ${JSON.stringify(decision)}`,
    {
      label: `release-gate-${pass}`,
      schema: gateSchema,
    },
  );
  log(decision.reason);
}

if (!decision.ready) {
  throw new Error(`Gate still closed after ${pass} passes: ${decision.nextAction}`);
}

return decision;
```

Always bound decision loops. `maxTotalPerGroup` is the final safety backstop,
not a substitute for a clear stopping condition.

### Process the first child that finishes

`agents.run()` returns an ordinary promise, so `Promise.race` can react to the
first Code Mode child. For harnesses that call the lower-level tools,
`agents_wait` provides the same first-completion boundary: it returns as soon
as at least one requested run completes, or when the bounded timeout expires.
See [Use Swarm from other harnesses](#use-swarm-from-other-harnesses) for the
complete drain loop.

## How collector children behave

Collector children are ordinary isolated sub-agent sessions with a different
completion path. They write a durable collector result for the parent to
await instead of announcing or steering a reply back into the parent session.

The target agent resolves in this order:

1. `agentId` on the spawn or `agents.run()` call.
2. `tools.swarm.defaultAgentId`.
3. The requesting agent.

A dedicated, lean worker agent is useful when swarm children need a smaller
tool surface, cheaper model, or tighter sandbox policy. OpenClaw does not ship
a built-in `worker` agent id; configure one before naming it as the default.

Collector approvals fail closed. A child never opens an operator approval
prompt. A tool action that would require approval is denied, and the child can
report that denial in its result so the script can decide what to do next.

For structured output, OpenClaw adds a synthetic `structured_output` tool to
the child and validates its payload against the supplied JSON Schema. An
invalid or missing payload gets one corrective nudge. If the retry still does
not validate, the collector completion keeps the child's raw text, leaves
`structured` unset, and includes `schemaError`. The low-level `agents_wait`
result exposes those fields for explicit recovery logic.

Swarm enforces all three group caps before starting more work. Children above
`maxConcurrent` queue FIFO. A spawn that exceeds `maxChildrenPerGroup` or
`maxTotalPerGroup` is rejected with the relevant config key in the error.

## Observe a Swarm

Open the parent session's dashboard in the Control UI while a swarm is active.
The Swarm widget renders each active collector group as one dot per child with
queued, running, done, or failed state. Labels appear in dot tooltips, so short
stable labels make larger swarms easier to read.

The session sidebar keeps the normal parent/child tree. Expand the parent row
to inspect a collector child or open its transcript without losing the swarm
hierarchy.

Collector results remain waitable until their group is archived. After every
member reaches its retention deadline, OpenClaw archives the group's children
as a batch so completed swarms do not remain in the live session tree.

## Use Swarm from other harnesses

You can use Swarm without OpenClaw Code Mode. Its core tools are
harness-independent: start collector children with
`sessions_spawn({ collect: true })` and drain them with bounded `agents_wait`
calls.

Codex Code Mode automatically exposes eligible dynamic OpenClaw tools under
`tools.*`. It does not use OpenClaw's QuickJS guest API or require
`tools.codeMode`, but `tools.swarm` must still be enabled. Use this pattern:

```javascript
const tasks = [
  "Check the authentication path.",
  "Check the storage path.",
  "Check the recovery path.",
];

const launches = await Promise.all(
  tasks.map((task, index) =>
    tools.sessions_spawn({
      task,
      collect: true,
      label: `review-${index + 1}`,
    }),
  ),
);

for (const launch of launches) {
  if (launch.status !== "accepted") {
    throw new Error(launch.error ?? "Collector spawn was not accepted.");
  }
}

const pending = new Set(launches.map((launch) => launch.runId));
const completed = [];

while (pending.size > 0) {
  const ids = [...pending].slice(0, 1000);
  const batch = await tools.agents_wait({
    ids,
    timeoutSeconds: 30,
  });

  // Rotate this bounded window behind ids that have not been checked yet.
  for (const runId of ids) {
    if (pending.delete(runId)) pending.add(runId);
  }

  for (const item of batch.completed) {
    pending.delete(item.runId);
    if (item.status !== "done") {
      throw new Error(item.schemaError ?? item.result ?? `${item.runId}: ${item.status}`);
    }
    completed.push(item); // Process each result as soon as it finishes.
  }

  for (const failure of batch.errors ?? []) {
    pending.delete(failure.runId);
    throw new Error(`${failure.runId}: ${failure.error}`);
  }
}

return completed;
```

Each `agents_wait` call accepts 1–1000 run ids. It returns:

```typescript
type AgentsWaitResult = {
  completed: Array<{
    runId: string;
    status: "done" | "failed" | "killed" | "timeout";
    result: string;
    structured?: unknown;
    schemaError?: string;
    sessionKey: string;
    label?: string;
    usage?: { inputTokens: number; outputTokens: number };
  }>;
  pending: string[];
  errors?: Array<{
    runId: string;
    error: "not_found" | "not_owner";
  }>;
};
```

The call returns immediately when any requested child is already complete,
when at least one pending child completes, when no valid pending ids remain,
or when its timeout expires. Completed records are idempotent, so passing an
already-completed run id returns its result again. Only the spawning session
or its authorized parent chain can wait on a collector.

This is bounded long polling, not a busy status loop. Keep passing only the
remaining run ids until `pending` is empty. Collector mode supports native
OpenClaw sub-agents; it does not support ACP runtime, thread binding, visible
sessions, or persistent session mode.

## Limits and roadmap

Swarm v1 runs one-shot collector children; the planned `agents.session()` API
will add stateful multi-turn workers. Children currently run on the local
Gateway's sub-agent lane; cloud placement is planned as an explicit spawn
option. Saved workflow definitions and a graph DSL are not part of Swarm's
current direction.

## Related

- [Code Mode](/tools/code-mode) for the QuickJS guest runtime and activation rules
- [Sub-agents](/tools/subagents) for child policy, isolation, and session behavior
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools) for per-agent restrictions
- [Tools overview](/tools) for tool profiles and policy routing
