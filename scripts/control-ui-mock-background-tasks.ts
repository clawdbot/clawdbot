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
      ],
    },
  };
}
