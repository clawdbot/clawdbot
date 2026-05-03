---
summary: "Run parallel specialist agents without clogging shared model and tool capacity"
title: "Parallel specialist lanes"
sidebarTitle: "Specialist lanes"
read_when:
  - You route group chats to dedicated agents
  - You want parallel work without one long task blocking every chat
  - You are designing a multi-agent operations setup
status: active
---

Parallel specialist lanes let one Gateway route different chats or rooms to
different agents, while keeping the user experience fast. The trick is to treat
parallelism as a scarce-resource design problem, not just as "more agents".

## First principles

A specialist lane only improves throughput when it reduces contention for the
real bottlenecks:

- **Session locks**: only one run should mutate a given session at a time.
- **Global model capacity**: all visible chat runs still share provider limits.
- **Tool capacity**: shell, browser, network, and repository work can be slower
  than the model turn itself.
- **Context budget**: long transcripts make every future turn slower and less
  focused.
- **Ownership ambiguity**: duplicate agents doing the same job waste capacity.

OpenClaw already serializes runs per session and caps global parallelism through
the [command queue](/concepts/queue). Specialist lanes add policy on top:
which agent owns which work, what stays in chat, and what becomes background
work.

## Recommended rollout

### Phase 1: lane contracts + background heavy work

Give every lane a written contract in its workspace and system prompt:

- **Purpose**: the work this lane owns.
- **Non-goals**: work it should hand off instead of attempting.
- **Chat budget**: quick answers stay in chat; long tasks should acknowledge
  briefly, then run in a background sub-agent or task.
- **Handoff rule**: when another lane owns the work, say where it should go and
  provide a compact handoff summary.
- **Tool-risk rule**: prefer the smallest tool surface that can do the job.

This is the cheapest phase and fixes most clogging: one coding job no longer
turns the research lane into molasses, and each chat keeps its own context clean.

### Phase 2: priority and concurrency controls

Tune queue and model capacity around the business value of each lane:

```json5
{
  agents: {
    defaults: {
      maxConcurrent: 4,
      subagents: { maxConcurrent: 8 },
    },
  },
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
    },
  },
}
```

Use direct/personal chats and production-ops agents for high-priority work. Let
research, drafting, and batch coding move to background tasks when the system is
busy.

### Phase 3: coordinator / traffic controller

Add a small coordinator pattern once multiple lanes are active:

- Track active lane tasks and owners.
- Detect duplicate requests across groups.
- Route handoff summaries between lanes.
- Surface only blockers, completed results, and decisions the human must make.

Do not start here. A coordinator without lane contracts just coordinates chaos.

## Minimal lane contract template

```md
# Lane contract

## Owns

- <job this lane is responsible for>

## Does not own

- <work to hand off>

## Chat budget

- Answer quick questions directly.
- For multi-step, slow, or tool-heavy work: acknowledge briefly, spawn/background
  the work, then return the result when complete.

## Handoff

If another lane owns the request, reply with:

- target lane
- objective
- relevant context
- exact next action

## Tool posture

Use the smallest tool surface that can complete the task. Avoid broad shell or
network work unless this lane explicitly owns it.
```

## Related

- [Multi-agent routing](/concepts/multi-agent)
- [Command queue](/concepts/queue)
- [Sub-agents](/tools/subagents)
