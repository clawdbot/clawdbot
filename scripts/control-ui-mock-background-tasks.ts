function historyMessage(role: "assistant" | "user", text: string, timestamp: number) {
  return { content: [{ type: "text", text }], role, timestamp };
}

export function buildBackgroundTasksMock(baseTime: number) {
  const now = Date.now();
  const taskSessionKey = "agent:openclaw-mock:subagent:mock-task-1";
  return {
    "chat.history": {
      cases: [
        {
          match: { sessionKey: taskSessionKey },
          response: {
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
            sessionId: "control-ui-mock-task-session",
            thinkingLevel: null,
          },
        },
      ],
    },
    // One live subagent task exercises the rail, collapsed badge, and running-task status row.
    "tasks.list": {
      tasks: [
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
        },
        ...[1, 2, 3, 4, 5].map((n) => ({
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
        })),
      ],
    },
  };
}
