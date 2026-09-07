function historyMessage(role: "assistant" | "user", text: string, timestamp: number) {
  return {
    content: [{ type: "text", text }],
    role,
    timestamp,
    __openclaw:
      role === "user" ? { senderId: "mock-operator", senderName: "Riley Example" } : undefined,
  };
}

function finishedTask(n: number, now: number, sessionKey: string) {
  const status = n === 3 ? "failed" : n === 4 ? "cancelled" : n === 5 ? "timed_out" : "completed";
  const task = {
    id: `task-mock-finished-${n}`,
    taskId: `task-mock-finished-${n}`,
    status,
    runtime: "subagent",
    agentId: "openclaw-mock",
    title: `Finished mock task number ${n} with a fairly long title`,
    createdAt: now - n * 600_000,
    startedAt: now - n * 600_000,
    endedAt: now - n * 500_000,
    updatedAt: now - n * 500_000,
    sessionKey,
    ownerKey: sessionKey,
  };
  if (status === "failed") {
    return { ...task, error: "The fixture audit found an invalid event scope." };
  }
  if (status === "cancelled") {
    return { ...task, terminalSummary: "Cancelled after the parent session changed direction." };
  }
  if (status === "timed_out") {
    return { ...task, error: "Timed out while waiting for the remote preview to become ready." };
  }
  return {
    ...task,
    deliveryStatus: n === 2 ? "session_queued" : "delivered",
    diffStat: { files: n + 1, added: n * 3, removed: n },
    terminalSummary: `Mock task ${n} completed its assigned inspection.`,
  };
}

function taskDetailCase(task: { id: string; title: string } & Record<string, unknown>) {
  return {
    match: { taskId: task.id },
    response: {
      task: {
        ...task,
        prompt: `Inspect ${task.title.toLowerCase()} and report the current execution path.`,
      },
    },
  };
}

export function buildBackgroundTasksMock(baseTime: number) {
  const now = Date.now();
  const taskSessionKey = "agent:openclaw-mock:subagent:mock-task-1";
  const secondTaskSessionKey = "agent:openclaw-mock:subagent:mock-task-2";
  const requesterSessionKey = "agent:main:main";
  const cliSessionKey = "agent:main:production-export";
  const tasks = [
    {
      id: "task-mock-queued",
      taskId: "task-mock-queued",
      status: "queued",
      runtime: "subagent",
      agentId: "openclaw-mock",
      title: "Capture the narrow mobile layout",
      createdAt: now - 8_000,
      updatedAt: now - 8_000,
      progressSummary: "Waiting for a background-task slot",
      sessionKey: requesterSessionKey,
      ownerKey: requesterSessionKey,
    },
    {
      id: "task-mock-running",
      taskId: "task-mock-running",
      status: "running",
      runtime: "subagent",
      agentId: "openclaw-mock",
      title: "Map run-status indicator code",
      createdAt: now - 25_000,
      startedAt: now - 25_000,
      updatedAt: now,
      toolUseCount: 7,
      diffStat: { files: 3, added: 128, removed: 20 },
      lastToolName: "read",
      progressSummary: "Tracing task events through the background task rail",
      sessionKey: requesterSessionKey,
      ownerKey: requesterSessionKey,
      childSessionKey: taskSessionKey,
    },
    {
      id: "task-mock-running-2",
      taskId: "task-mock-running-2",
      kind: "exec",
      status: "running",
      runtime: "cli",
      agentId: "openclaw-mock",
      title: "Audit gateway event scope guards",
      createdAt: now - 95_000,
      startedAt: now - 95_000,
      updatedAt: now - 1_000,
      progressSummary: "Comparing agent-scoped task event paths",
      diffStat: { files: 2, added: 55, removed: 21 },
      sessionKey: cliSessionKey,
      ownerKey: cliSessionKey,
    },
    finishedTask(1, now, requesterSessionKey),
    finishedTask(2, now, requesterSessionKey),
    finishedTask(3, now, requesterSessionKey),
    finishedTask(4, now, requesterSessionKey),
    finishedTask(5, now, requesterSessionKey),
  ];
  return {
    sessions: [taskSessionKey, secondTaskSessionKey].map((key) => ({ key })),
    sessionTranscripts: {
      [taskSessionKey]: {
        messages: [
          historyMessage(
            "user",
            "Map the run-status indicator code and report the active execution path.",
            baseTime + 40 * 60_000,
          ),
          historyMessage(
            "assistant",
            "Tracing task events from the gateway through the chat background-tasks rail.",
            baseTime + 40 * 60_000 + 8_000,
          ),
        ],
        thinkingLevel: null,
      },
      [secondTaskSessionKey]: {
        messages: [
          historyMessage(
            "user",
            "Audit the gateway task-event scope guards.",
            baseTime + 41 * 60_000,
          ),
          historyMessage(
            "assistant",
            "Comparing requester, owner, and child-session event routing.",
            baseTime + 41 * 60_000 + 6_000,
          ),
        ],
        thinkingLevel: null,
      },
    },
    methodResponses: {
      // Subagents exercise their activity rows; the detached CLI task exercises
      // the aggregate status row that production shows after a foreground turn.
      "tasks.list": {
        cases: [
          {
            match: { status: ["queued", "running"], sessionKey: requesterSessionKey },
            response: {
              tasks: tasks.filter(
                (task) =>
                  task.sessionKey === requesterSessionKey &&
                  (task.status === "queued" || task.status === "running"),
              ),
            },
          },
          {
            match: {
              status: ["completed", "failed", "timed_out", "cancelled"],
              sessionKey: requesterSessionKey,
              sortBy: "endedAt",
            },
            response: {
              tasks: tasks.filter(
                (task) =>
                  task.sessionKey === requesterSessionKey &&
                  (task.status === "completed" ||
                    task.status === "failed" ||
                    task.status === "timed_out" ||
                    task.status === "cancelled"),
              ),
            },
          },
          {
            match: { status: ["queued", "running"], sessionKey: cliSessionKey },
            response: {
              tasks: tasks.filter(
                (task) =>
                  task.sessionKey === cliSessionKey &&
                  (task.status === "queued" || task.status === "running"),
              ),
            },
          },
          {
            match: { status: ["queued", "running"], limit: 500 },
            response: {
              tasks: tasks.filter((task) => task.status === "queued" || task.status === "running"),
            },
          },
          {
            match: {
              status: ["completed", "failed", "timed_out", "cancelled"],
              sortBy: "endedAt",
              limit: 200,
            },
            response: {
              tasks: tasks.filter(
                (task) =>
                  task.status === "completed" ||
                  task.status === "failed" ||
                  task.status === "timed_out" ||
                  task.status === "cancelled",
              ),
            },
          },
          { match: { limit: 500 }, response: { tasks } },
          // Production scopes chat task queries to their session. The empty
          // fallback prevents main-session work from appearing in unrelated chats.
          { response: { tasks: [] } },
        ],
      },
      "tasks.get": { cases: tasks.map(taskDetailCase) },
      "tasks.cancel": {
        cases: tasks.map((task) => ({
          match: { taskId: task.id },
          response: {
            found: true,
            cancelled: task.status === "queued" || task.status === "running",
            reason:
              task.status === "queued" || task.status === "running"
                ? "Cancelled from the Control UI mock."
                : "Task is already terminal.",
            task:
              task.status === "queued" || task.status === "running"
                ? { ...task, status: "cancelled", endedAt: now, updatedAt: now }
                : task,
          },
        })),
      },
    },
  };
}
