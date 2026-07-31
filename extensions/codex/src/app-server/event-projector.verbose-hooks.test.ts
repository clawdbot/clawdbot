import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  SessionManager,
  expect,
  it,
  vi,
  THREAD_ID,
  TURN_ID,
  createParams,
  createProjector,
  createProjectorWithHooks,
  buildEmptyToolTelemetry,
  requireRecord,
  requireArray,
  mockCallArg,
  findAgentEvent,
  forCurrentTurn,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector verbose output and hook projection", () => {
  it("emits verbose tool summaries through onToolResult", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledWith({
      text: "🛠️ `run tests (workspace)`",
    });
  });

  it("can emit raw verbose tool summaries through onToolResult", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      toolProgressDetail: "raw",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    expect(onToolResult).toHaveBeenCalledWith({
      text: "🛠️ `` run tests (workspace), `pnpm test extensions/codex` ``",
    });
  });

  it("redacts secrets in verbose command summaries", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      toolProgressDetail: "raw",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "OPENAI_API_KEY=sk-1234567890abcdefZZZZ pnpm test",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    const text = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string }).text;
    expect(text).toContain("OPENAI_API_KEY=*** pnpm test");
    expect(text).not.toContain("sk-1234567890abcdefZZZZ");
  });

  it("uses argument details instead of lifecycle status in verbose tool summaries", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "lcm_grep",
          arguments: { query: "inProgress text" },
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        },
      }),
    );

    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledWith({
      text: "🧩 Lcm Grep: `inProgress text`",
    });
  });

  it("emits completed tool output only when verbose full is enabled", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });

    await projector.handleNotification(
      turnCompleted([
        {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "read",
          arguments: { path: "README.md" },
          status: "completed",
          contentItems: [{ type: "inputText", text: "file contents" }],
          success: true,
          durationMs: 12,
        },
      ]),
    );

    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(onToolResult).toHaveBeenNthCalledWith(1, {
      text: "📖 Read: `from README.md`",
    });
    expect(onToolResult).toHaveBeenNthCalledWith(2, {
      text: "📖 Read: `from README.md`\n```txt\nfile contents\n```",
    });
  });

  it("marks failed completed tool output as error progress", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });

    await projector.handleNotification(
      turnCompleted([
        {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "bash",
          arguments: { command: "ls /tmp/missing" },
          status: "failed",
          contentItems: [{ type: "inputText", text: "No such file or directory" }],
          success: false,
          durationMs: 12,
        },
      ]),
    );

    expect(onToolResult).toHaveBeenNthCalledWith(2, {
      text: "🛠️ `list files in /tmp/missing`\n```txt\nNo such file or directory\n```",
      isError: true,
    });
  });

  it("uses a safe markdown fence for verbose tool output", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });

    await projector.handleNotification(
      turnCompleted([
        {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "read",
          arguments: { path: "README.md" },
          status: "completed",
          contentItems: [{ type: "inputText", text: "line\n```\nMEDIA:/tmp/secret.png" }],
          success: true,
          durationMs: 12,
        },
      ]),
    );

    expect(onToolResult).toHaveBeenNthCalledWith(2, {
      text: "📖 Read: `from README.md`\n````txt\nline\n```\nMEDIA:/tmp/secret.png\n````",
    });
  });

  it("bounds streamed verbose tool output", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });

    for (let i = 0; i < 25; i += 1) {
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-1",
          delta: `line ${i}\n`,
        }),
      );
    }
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "final output should not duplicate streamed output",
          exitCode: 0,
          durationMs: 12,
        },
      ]),
    );

    expect(onToolResult).toHaveBeenCalledTimes(21);
    const truncatedOutput = mockCallArg(onToolResult, 19, 0, "onToolResult") as {
      text?: string;
    };
    expect(truncatedOutput.text).toContain("...(truncated)...");
    expect(JSON.stringify(onToolResult.mock.calls)).not.toContain(
      "final output should not duplicate",
    );
  });

  it("continues projecting turn completion when an event consumer throws", async () => {
    const onAgentEvent = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await expect(
      projector.handleNotification(
        turnCompleted([
          { type: "plan", id: "plan-1", text: "step one\nstep two" },
          { type: "agentMessage", id: "msg-1", text: "final answer" },
        ]),
      ),
    ).resolves.toBeUndefined();

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(findAgentEvent(onAgentEvent, { stream: "plan" }).data.steps).toEqual([
      { step: "step one", status: "pending" },
      { step: "step two", status: "pending" },
    ]);
    expect(result.assistantTexts).toEqual(["final answer"]);
    expect(JSON.stringify(result.messagesSnapshot)).toContain("Codex plan");
  });

  it("fires before_compaction and after_compaction hooks for codex compaction items", async () => {
    const { projector, beforeCompaction, afterCompaction } = await createProjectorWithHooks();
    const openSpy = vi.spyOn(SessionManager, "open");

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    expect(openSpy).not.toHaveBeenCalled();

    const beforePayload = requireRecord(
      mockCallArg(beforeCompaction, 0, 0, "beforeCompaction"),
      "before payload",
    );
    expect(beforePayload.messageCount).toBe(1);
    expect(String(beforePayload.sessionFile)).toContain("session.jsonl");
    const beforeMessages = requireArray(beforePayload.messages, "before messages");
    expect(requireRecord(beforeMessages[0], "before message").role).toBe("assistant");
    const beforeContext = requireRecord(
      mockCallArg(beforeCompaction, 0, 1, "beforeCompaction"),
      "before context",
    );
    expect(beforeContext.runId).toBe("run-1");
    expect(beforeContext.sessionId).toBe("session-1");
    const afterPayload = requireRecord(
      mockCallArg(afterCompaction, 0, 0, "afterCompaction"),
      "after payload",
    );
    expect(afterPayload.messageCount).toBe(1);
    expect(afterPayload.compactedCount).toBe(-1);
    expect(String(afterPayload.sessionFile)).toContain("session.jsonl");
    const afterContext = requireRecord(
      mockCallArg(afterCompaction, 0, 1, "afterCompaction"),
      "after context",
    );
    expect(afterContext.runId).toBe("run-1");
    expect(afterContext.sessionId).toBe("session-1");
  });

  it("projects codex hook started and completed notifications into agent events", async () => {
    const onAgentEvent = vi.fn();
    const params = await createParams();
    const projector = await createProjector({ ...params, onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("hook/started", {
        run: {
          id: "hook-1",
          eventName: "preToolUse",
          handlerType: "command",
          executionMode: "sync",
          scope: "turn",
          source: "project",
          sourcePath: "/repo/.codex/hooks.json",
          status: "running",
          statusMessage: null,
          entries: [],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("hook/completed", {
        run: {
          id: "hook-1",
          eventName: "preToolUse",
          handlerType: "command",
          executionMode: "sync",
          scope: "turn",
          source: "project",
          sourcePath: "/repo/.codex/hooks.json",
          status: "blocked",
          statusMessage: "blocked by hook",
          durationMs: 42,
          entries: [{ kind: "stderr", text: "blocked" }],
        },
      }),
    );

    const started = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.hook",
      phase: "started",
    }).data;
    expect(started.threadId).toBe(THREAD_ID);
    expect(started.turnId).toBe(TURN_ID);
    expect(started.hookRunId).toBe("hook-1");
    expect(started.eventName).toBe("preToolUse");
    expect(started.status).toBe("running");
    const completed = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.hook",
      phase: "completed",
    }).data;
    expect(completed.hookRunId).toBe("hook-1");
    expect(completed.status).toBe("blocked");
    expect(completed.statusMessage).toBe("blocked by hook");
    expect(completed.durationMs).toBe(42);
    expect(completed.entries).toEqual([{ kind: "stderr", text: "blocked" }]);
  });

  it("projects thread-scoped codex hook notifications that omit a turn id", async () => {
    const onAgentEvent = vi.fn();
    const params = await createParams();
    const projector = await createProjector({ ...params, onAgentEvent });

    await projector.handleNotification({
      method: "hook/started",
      params: {
        threadId: THREAD_ID,
        turnId: null,
        run: {
          id: "hook-thread-1",
          eventName: "sessionStart",
          handlerType: "command",
          executionMode: "sync",
          scope: "thread",
          source: "project",
          sourcePath: "/repo/.codex/hooks.json",
          status: "running",
          statusMessage: null,
          entries: [],
        },
      },
    });

    const started = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.hook",
      phase: "started",
    }).data;
    expect(started.threadId).toBe(THREAD_ID);
    expect(started.turnId).toBeNull();
    expect(started.hookRunId).toBe("hook-thread-1");
    expect(started.eventName).toBe("sessionStart");
    expect(started.scope).toBe("thread");
  });
});
