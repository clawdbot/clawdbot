import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  initializeGlobalHookRunner,
  createMockPluginRegistry,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  requireRecord,
  mockCallArg,
  forCurrentTurn,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector native tool hook projection", () => {
  it("emits after_tool_call observations for Codex-native tool item completions", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector({
      ...(await createParams()),
      agentId: "main",
      sessionKey: "agent:main:session-1",
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-observed",
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
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-observed",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.toolName).toBe("bash");
    expect(event.params).toEqual({ command: "pnpm test extensions/codex", cwd: "/workspace" });
    expect(event.runId).toBe("run-1");
    expect(event.toolCallId).toBe("cmd-observed");
    expect(event.result).toEqual({ status: "completed", exitCode: 0, durationMs: 42 });
    expect(event.durationMs).toBeGreaterThanOrEqual(42);
    const context = requireRecord(
      mockCallArg(afterToolCall, 0, 1, "after_tool_call context"),
      "after_tool_call context",
    );
    expect(context.agentId).toBe("main");
    expect(context.sessionId).toBe("session-1");
    expect(context.sessionKey).toBe("agent:main:session-1");
    expect(context.runId).toBe("run-1");
    expect(context.toolName).toBe("bash");
    expect(context.toolCallId).toBe("cmd-observed");
  });

  it("omits after_tool_call startedAt when native duration is out of range", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-huge-duration",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: Number.MAX_SAFE_INTEGER,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.result).toEqual({
      status: "completed",
      exitCode: 0,
      durationMs: Number.MAX_SAFE_INTEGER,
    });
    expect(event).not.toHaveProperty("durationMs");
  });

  it("does not duplicate native items already covered by PostToolUse relay", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector(
      { ...(await createParams()), sessionKey: "agent:main:session-1" },
      { nativePostToolUseRelayEnabled: true },
    );

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-relayed",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );
    expect(afterToolCall).not.toHaveBeenCalled();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          query: "native tool observability",
          status: "completed",
          durationMs: 5,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.toolName).toBe("web_search");
    expect(event.params).toEqual({ query: "native tool observability" });
    expect(event.runId).toBe("run-1");
    expect(event.toolCallId).toBe("search-observed");
    expect(event.result).toEqual({
      status: "completed",
      durationMs: 5,
      query: "native tool observability",
    });
  });

  it("waits for native apply_patch PostToolUse before suppressing direct FileChange AFTER", async () => {
    const afterToolCall = vi.fn();
    let coverage: "native_apply_patch" | "intercepted" | "pending" = "pending";

    const resolveNativeFileChangeAfterToolCallCoverage = vi.fn(() => coverage);

    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          handler: afterToolCall,
        },
      ]),
    );

    const projector = await createProjector(
      {
        ...(await createParams()),
        sessionKey: "agent:main:session-1",
      },
      {
        nativePostToolUseRelayEnabled: true,
        resolveNativeFileChangeAfterToolCallCoverage,
      },
    );

    const changes = [
      {
        path: "direct.txt",
        kind: { type: "add" },
      },
    ];

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: "patch-direct",
          changes,
          status: "completed",
        },
      }),
    );

    expect(afterToolCall).not.toHaveBeenCalled();

    coverage = "native_apply_patch";

    await projector.handleNotification(
      forCurrentTurn("hook/completed", {
        run: {
          id: "hook-direct",
          eventName: "postToolUse",
          handlerType: "command",
          executionMode: "sync",
          scope: "turn",
          source: "project",
          sourcePath: "/repo/.codex/hooks.json",
          status: "completed",
          statusMessage: null,
          durationMs: 1,
          entries: [],
        },
      }),
    );

    expect(resolveNativeFileChangeAfterToolCallCoverage).toHaveBeenCalledWith("patch-direct");

    expect(afterToolCall).not.toHaveBeenCalled();
  });

  it("synthesizes apply_patch AFTER immediately for an intercepted FileChange", async () => {
    const afterToolCall = vi.fn();

    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          handler: afterToolCall,
        },
      ]),
    );

    const projector = await createProjector(
      {
        ...(await createParams()),
        sessionKey: "agent:main:session-1",
      },
      {
        nativePostToolUseRelayEnabled: true,
        resolveNativeFileChangeAfterToolCallCoverage: () => "intercepted",
      },
    );

    const changes = [
      {
        path: "intercepted.txt",
        kind: { type: "add" },
      },
    ];

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: "patch-intercepted",
          changes,
          status: "completed",
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));

    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );

    expect(event.toolName).toBe("apply_patch");
    expect(event.toolCallId).toBe("patch-intercepted");
    expect(event.params).toEqual({ changes });
    expect(event.result).toEqual({
      status: "completed",
      changes,
    });
  });

  it("falls back to one synthetic FileChange AFTER at turn completion", async () => {
    const afterToolCall = vi.fn();

    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          handler: afterToolCall,
        },
      ]),
    );

    const projector = await createProjector(
      {
        ...(await createParams()),
        sessionKey: "agent:main:session-1",
      },
      {
        nativePostToolUseRelayEnabled: true,
        resolveNativeFileChangeAfterToolCallCoverage: () => "pending",
      },
    );

    const changes = [
      {
        path: "fallback.txt",
        kind: { type: "add" },
      },
    ];

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: "patch-fallback",
          changes,
          status: "completed",
        },
      }),
    );

    expect(afterToolCall).not.toHaveBeenCalled();

    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: "turn-1",
          status: "completed",
          items: [],
          error: null,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));

    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );

    expect(event.toolName).toBe("apply_patch");
    expect(event.toolCallId).toBe("patch-fallback");
  });

  it("uses Codex web search action metadata when the top-level query is empty", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          query: "",
          action: {
            type: "search",
            query: "native action query",
            queries: ["native action query", "secondary query"],
          },
          status: "completed",
          durationMs: 5,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.toolName).toBe("web_search");
    expect(event.params).toEqual({
      query: "native action query",
      queries: ["native action query", "secondary query"],
    });
    expect(event.result).toEqual({
      status: "completed",
      durationMs: 5,
      query: "native action query",
      queries: ["native action query", "secondary query"],
    });
  });

  it("marks unavailable Codex web search queries explicitly", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          query: "",
          action: { type: "other" },
          status: "completed",
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.params).toEqual({
      action: "other",
      queryUnavailable: true,
    });
    expect(event.result).toEqual({
      status: "completed",
      action: "other",
      queryUnavailable: true,
    });
  });
});
