---
summary: "Orchestrate concurrent sub-agents from Code Mode scripts with structured results, bounded fan-out, and live progress"
title: "Swarm"
sidebarTitle: "Swarm"
read_when:
  - You want a Code Mode script to fan out work across several agents
  - You need structured child results, decision gates, or first-completion pipelines
  - You are disabling Swarm or tuning tools.swarm limits
  - You want to observe collector children in chat
---

Swarm is an experimental way to orchestrate many sub-agents from a
[Code Mode](/tools/code-mode) script. It is enabled by default, with an explicit
opt-out. Use normal JavaScript or TypeScript control flow such as `Promise.all`,
`while`, and `if` to fan out work, collect results, and make decisions.

There is no graph DSL and no separate workflow format. The program is the
orchestration. Swarm adds awaitable collector children, structured results,
bounded concurrency, and progress reporting to that program.

## Enable Swarm

Swarm needs no enablement setting. Omitted `tools.swarm`, an empty object, or
an object that sets only limits all leave Swarm enabled. Code Mode remains
separately opt-in, and normal tool policy still applies. Existing Codex sessions
can retain an older tool catalog; see the
[fresh-session guidance](/tools/swarm#use-swarm-from-other-harnesses) below.

To opt out, turn off **Settings → Agents & Tools → Labs → Swarm** in the
Control UI. The switch saves `tools.swarm.enabled: false` immediately and
applies to future runs without restarting the Gateway. Or set the boolean
shorthand in `openclaw.json`:

```json5
{
  tools: {
    swarm: false,
  },
}
```

`swarm: { enabled: false }` has the same effect while preserving configured
limits. To re-enable Swarm, remove the explicit opt-out, set `swarm: true` or
`swarm: { enabled: true }`, or turn the Labs switch back on.

To tune the limits, use object form. These are the defaults; you only need to
include values you want to change:

```json5
{
  tools: {
    swarm: {
      maxConcurrent: 8,
      maxChildrenPerGroup: 50,
      maxTotalPerGroup: 200,
      waitTimeoutSecondsMax: 600,
      defaultAgentId: "",
    },
  },
}
```

| Field                   | Default | Description                                                                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`               | `true`  | Enables collector features subject to tool policy; set `false` to opt out. Code Mode has additional requirements below.        |
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
`agents.entries.*.tools.swarm`. Per-agent values merge over the top-level
setting. An agent's `false` or `{ enabled: false }` disables Swarm for that
agent; `true` or `{ enabled: true }` enables it even if globally disabled.
A limits-only per-agent object inherits global enablement, so it does not
re-enable a global `false`.

## Requirements

To use the `agents.run`, `phase`, and `log` guest globals, enable OpenClaw Code
Mode and leave Swarm enabled:

```json5
{
  tools: {
    codeMode: true,
  },
}
```

Code Mode exposes these globals, `API.read("agents.d.ts")`, and Swarm prompt
hints only when its catalog contains the native OpenClaw `sessions_spawn`
tool and the run's execution allowlist permits it. An MCP tool with the same
name does not qualify. Tool profiles, allow/deny policy, provider rules, and
sandbox policy can remove the native tool. If the Swarm API is absent, check
[Code Mode activation](/tools/code-mode#activation) and
[Sub-agents](/tools/subagents).

Code Mode waits for collector results internally; its `agents.run()` API does
not require the standalone `agents_wait` tool to be allowed. The
[low-level tool flow](/tools/swarm#use-swarm-from-other-harnesses) needs both
`sessions_spawn` and `agents_wait` allowed. Enabling Swarm never grants tools
or bypasses policy.

`defaultAgentId` and per-run `agentId` values must name a configured target
permitted by the requester's `subagents.allowAgents` policy. OpenClaw rejects
an unknown or disallowed target instead of falling back to another agent.

## Write a Swarm script

When the [requirements](/tools/swarm#requirements) are met, Code Mode exposes
this guest API:

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
rejects the promise with an error whose `name` is `"SwarmAgentError"` and whose
`runId`, `status`, and `message` identify the failed child and outcome. There is
no global `SwarmAgentError` constructor; inspect the caught error's fields.
Spawn or bridge failures can reject with other errors. Read the exact generated
declarations and short orchestration idioms from `API.read("agents.d.ts")`
inside Code Mode.

Use `label` for a recognizable child name in the dashboard and sidebar. Use
`phase` in the options to publish a phase immediately before that child
starts, or call `phase()` when several children belong to the same stage.
`log()` publishes a short progress note. Progress calls are fire-and-forget;
they do not delay the script if the UI is unavailable.

### Fan out in parallel with structured results

This example launches one researcher per topic, waits for every outcome, then
asks a final child to synthesize the successful reports. Failed lanes stay in
the result, even if synthesis also fails:

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

const settled = await Promise.allSettled(
  topics.map((topic) =>
    agents.run(`Review the ${topic} path. Return one finding with evidence.`, {
      label: `review-${topic}`,
      thinking: "high",
      fastMode: "auto",
      schema: reportSchema,
    }),
  ),
);

const reports = [];
const failures = [];
for (const [index, outcome] of settled.entries()) {
  if (outcome.status === "fulfilled") {
    reports.push({ topic: topics[index], report: outcome.value });
  } else {
    failures.push({ topic: topics[index], error: String(outcome.reason) });
  }
}

if (reports.length === 0) return { reports, failures };

phase("Synthesis");
log(`Collected ${reports.length} reports; ${failures.length} lanes failed.`);

try {
  const synthesis = await agents.run(
    `Reconcile these reports, explain disagreements, and disclose failed lanes:\n${JSON.stringify({ reports, failures })}`,
    { label: "synthesis" },
  );
  return { synthesis, reports, failures };
} catch (error) {
  return { reports, failures, synthesisError: String(error) };
}
```

`Promise.allSettled` preserves partial results while waiting for every child.
`Promise.all` rejects on the first failure and does not collect the remaining
outcomes for you. Keep completed work and report failed lanes; do not respawn
the batch automatically. A later provider failure can still prevent a final
model reply, so retain the collected results for recovery.

OpenClaw starts up to `maxConcurrent` children for the group and queues the rest
in submission order.

Code Mode separately bounds concurrent guest bridge calls with
`tools.codeMode.maxPendingToolCalls` (default `16`, maximum `128`). Swarm
launches, progress notes, and result waits queue automatically when those slots
are full. Queued requests retain their original arguments across snapshot
resumes; stopping the run discards requests that have not been admitted.
`maxConcurrent` still limits running children, and group child limits still
apply. Raw tool calls do not use this Swarm queue and must remain within the
bridge-call limit.

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
The accepted spawn receipt describes this path: collect the result with
`agents_wait`, or await `agents.run()` in OpenClaw Code Mode. Do not use
`sessions_yield` to wait for collectors; they do not send completion notifications.

The target agent resolves in this order:

1. `agentId` on the spawn or `agents.run()` call.
2. `tools.swarm.defaultAgentId`.
3. The requesting agent.

A dedicated, lean worker agent is useful when swarm children need a smaller
tool surface, cheaper model, or tighter sandbox policy. OpenClaw does not ship
a built-in `worker` agent id; configure one before naming it as the default.
Harden that worker with `tools.swarm: false` in its per-agent configuration so
it can be spawned but cannot start swarms from its own top-level sessions:

```json5
{
  tools: { swarm: { enabled: true, defaultAgentId: "worker" } },
  agents: {
    entries: {
      main: {
        default: true,
        subagents: { allowAgents: ["worker"] },
      },
      worker: { tools: { swarm: false } },
    },
  },
}
```

Collector approvals fail closed. A child never opens an operator approval
prompt. A tool action that would require approval is denied, and the child can
report that denial in its result so the script can decide what to do next.

For structured output, OpenClaw adds a synthetic `structured_output` tool to
the child and validates its payload against the supplied JSON Schema. An
invalid payload gets one corrective nudge. If no payload is submitted, or the
retry still does not validate, the collector completion keeps the child's raw
text, leaves `structured` unset, and includes `schemaError`. The low-level `agents_wait`
result exposes those fields for explicit recovery logic.

### Keep collector groups flat

Swarm children can delegate recursively, but the usual orchestration idiom is
to return work to the parent instead of expanding the collector tree:

```javascript
const plan = await agents.run("Plan this job as independent tasks.", {
  schema: {
    type: "object",
    properties: { tasks: { type: "array", items: { type: "string" } } },
    required: ["tasks"],
    additionalProperties: false,
  },
});
return await Promise.all(plan.tasks.map((task) => agents.run(task)));
```

Nested collectors are discouraged for Swarm. Group caps, budgets, and
observability all assume flat collector groups. Set
`agents.defaults.subagents.maxSpawnDepth: 1` when a workflow must enforce that
shape.

Every child has one admission owner. Announce and interactive children use
`agents.defaults.subagents.maxChildrenPerAgent` (default `5`) and do not count
collector children. Collector children use only `maxChildrenPerGroup` and
`maxTotalPerGroup`; they do not consume the per-session child budget. The spawn
depth guard still applies to both modes.

After admission, children above `maxConcurrent` queue FIFO within their swarm
group, nested inside the global sub-agent lane. These concurrency layers queue
work rather than rejecting it. A collector spawn that exceeds either group cap
is rejected with the relevant config key in the error.

## Observe a Swarm

Keep the parent session open in Chat while a swarm is active. The Control UI and
native Android, iOS, and macOS chat surfaces show a compact Swarm progress widget
between the transcript and composer.

In the Control UI, cards show queued, running, completed, and failed counts with
visible status markers. Click or tap **Child details**, or activate it with the
keyboard, to expand available child names, status icons, and run durations. The
view shows up to four active groups plus the latest completed group, with an
explicit count when more groups are active. Each card displays at most 64 markers
and 64 child details; its counts include every accepted group member.

The latest completed group's counts remain visible after the children finish,
including when the parent fails before writing its final response. These are
child outcomes, not confirmation that the parent produced a synthesis. Counts
come from retained collector records, so reloading the page or cleaning up a
child session does not reduce the reported total. They expire with the existing
collector retention policy; this is not a permanent execution archive.

Native Android, iOS, and macOS chat surfaces still show active-only phase-grouped
grids, capped at 256 markers per phase with an overflow count. Accessible labels
identify each child's status. All clients present killed and timed-out children
as failed. Native groups leave the widget when none of their children are queued
or running; the native widget disappears when no active groups remain.

The session sidebar keeps the normal parent/child tree. Expand the parent row to
inspect a collector child or open its transcript without losing the swarm hierarchy.

Delete-mode collectors can clean up their child sessions immediately after
completion while retaining their waitable results. Those collector records remain
available until the group is archived after every member reaches its retention
deadline. Retained child sessions are archived as a batch at that point.

## Stop a Swarm

Use **Stop** in the parent chat to cancel a running swarm. A Stop targeting a
specific parent run also cancels its associated collector children and their
nested descendants. Collector mode changes result delivery, not cancellation
scope. Successful cancellation prevents selected queued children from starting
as running siblings stop; it does not cancel work from unrelated parent turns.

If Stop reports incomplete descendant cancellation, inspect the remaining work
on the [Tasks page](/automation/tasks#control-ui) and retry cancellation for
those children. A stopped parent alone does not confirm that every child stopped,
and a cancellation acknowledgment does not promise instantaneous runtime cleanup.

Already-accepted children remain independent when the parent completes normally,
yields, or times out. If the parent is no longer active, cancel the child tasks
directly. See [Sub-agent stopping](/tools/subagents#stopping) for exact-run and
session-wide Stop scopes.

## Use Swarm from other harnesses

You can use Swarm without OpenClaw Code Mode. Its core tools are
harness-independent: start collector children with
`sessions_spawn({ collect: true })` and drain them with bounded `agents_wait`
calls. Both tools must be allowed by the effective tool policy; default-on
Swarm does not add them to a restrictive tool profile or allowlist.

Codex Code Mode automatically exposes eligible dynamic OpenClaw tools under
`tools.*`. It does not use OpenClaw's QuickJS guest API or require
`tools.codeMode`, but `tools.swarm` must still be enabled. Codex harness
`agents_wait` calls support the full 600-second timeout.

Codex records its dynamic tool catalog when a native thread starts. A thread
created without `agents_wait` cannot gain that reader just by enabling Swarm or
upgrading OpenClaw, so collector spawn fields remain unavailable on that thread.
For an ordinary unlocked chat, use `/new` or `/reset` to start with current tools.
For a [supervised, model-locked Chat](/plugins/codex-supervision#branch-from-a-local-session),
open the Control UI's global **New Session** page and select a concrete
Codex-backed model to start a separate ordinary session. Keep the supervised
Chat intact: `/new`, `/reset`, and parent-linked **New chat** are blocked there.
The new session still needs a tool policy that permits both collector tools.

With the currently supported Codex runtime, dynamic OpenClaw tool results reach
Code Mode as JSON text. Parse each result before reading fields. Codex also
serializes dynamic tool calls, so `Promise.all` does not submit several
`sessions_spawn` calls concurrently. Launch collectors in a bounded loop;
already-accepted children can still run while later launches are submitted.

```javascript
function parseToolResult(value) {
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}

const tasks = [
  "Check the authentication path.",
  "Check the storage path.",
  "Check the recovery path.",
];
const launches = [];
const failures = [];

for (const [index, task] of tasks.entries()) {
  const launch = parseToolResult(
    await tools.sessions_spawn({
      task,
      collect: true,
      label: `review-${index + 1}`,
    }),
  );
  if (launch.status !== "accepted") {
    failures.push({ task, error: launch.error ?? "Collector spawn was not accepted." });
    continue;
  }
  launches.push(launch);
}

const pending = new Set(launches.map((launch) => launch.runId));
const completed = [];

while (pending.size > 0) {
  const ids = [...pending].slice(0, 1000);
  const batch = parseToolResult(
    await tools.agents_wait({
      ids,
      timeoutSeconds: 30,
    }),
  );

  // Rotate this bounded window behind ids that have not been checked yet.
  for (const runId of ids) {
    if (pending.delete(runId)) pending.add(runId);
  }

  for (const item of batch.completed) {
    pending.delete(item.runId);
    if (item.status !== "done") {
      failures.push(item);
    } else {
      completed.push(item); // Process each result as soon as it finishes.
    }
  }

  for (const failure of batch.errors ?? []) {
    pending.delete(failure.runId);
    failures.push(failure);
  }
}

return { completed, failures };
```

Drain the pending set before synthesizing the successful results and reporting
failures. A rejected launch or failed child must not discard results from other
accepted children. Keep the returned run IDs for recovery; do not repeat
successful launches or automatically rerun failed work.

Each `agents_wait` call accepts 1–1000 run ids. It returns:

```typescript
type AgentsWaitResult = {
  completed: Array<{
    runId: string;
    status: "done" | "failed" | "killed" | "timeout";
    result: string;
    structured?: unknown;
    error?: string;
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

A completed item can contain partial `structured` data and still have
`status: "failed"` when the provider or runtime fails afterward. In that case,
`error` is the authoritative terminal failure. Recovery code should prefer a
nonblank `error`, then `schemaError`, then a nonblank `result`, and finally a
run/status fallback.

Individual failed items do not make a mixed `agents_wait` poll a top-level tool
error. The poll remains a successful JSON result so callers can process its
`completed`, `pending`, and `errors` arrays independently.

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
