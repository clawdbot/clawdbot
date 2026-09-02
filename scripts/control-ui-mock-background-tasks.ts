function historyMessage(role: "assistant" | "user", text: string, timestamp: number) {
  return { content: [{ type: "text", text }], role, timestamp };
}

function finishedTask(n: number, now: number) {
  const task = {
    id: `task-mock-finished-${n}`,
    taskId: `task-mock-finished-${n}`,
    status: n === 3 ? "failed" : "completed",
    runtime: "subagent",
    agentId: "openclaw-mock",
    title: `Finished mock task number ${n} with a fairly long title`,
    createdAt: now - n * 600_000,
    startedAt: now - n * 600_000,
    endedAt: now - n * 500_000,
    updatedAt: now - n * 500_000,
  };
  return n === 3
    ? { ...task, error: "Mock task stopped after finding an invalid event scope." }
    : { ...task, terminalSummary: `Mock task ${n} completed its assigned inspection.` };
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
  const tasks = [
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
      lastToolName: "read",
      progressSummary: "Tracing task events through the background task rail",
      sessionKey: requesterSessionKey,
      ownerKey: requesterSessionKey,
      childSessionKey: taskSessionKey,
    },
    {
      id: "task-mock-running-2",
      taskId: "task-mock-running-2",
      status: "running",
      runtime: "subagent",
      agentId: "openclaw-mock",
      title: "Audit gateway event scope guards",
      createdAt: now - 95_000,
      startedAt: now - 95_000,
      updatedAt: now - 1_000,
      progressSummary: "Comparing agent-scoped task event paths",
      sessionKey: requesterSessionKey,
      ownerKey: requesterSessionKey,
      childSessionKey: secondTaskSessionKey,
    },
    finishedTask(1, now),
    finishedTask(2, now),
    finishedTask(3, now),
    finishedTask(4, now),
    finishedTask(5, now),
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
      // One live subagent task exercises the rail, collapsed badge, and running-task status row.
      "tasks.list": { tasks },
      "tasks.get": { cases: tasks.map(taskDetailCase) },
    },
  };
}
