import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
  type DiagnosticToolLoopEvent,
} from "../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { CRITICAL_THRESHOLD } from "./tool-loop-detection.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(),
  };
});
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("before_tool_call loop detection behavior", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };
  const enabledLoopDetectionContext = {
    agentId: "main",
    sessionKey: "main",
    loopDetection: { enabled: true },
  };

  const disabledLoopDetectionContext = {
    agentId: "main",
    sessionKey: "main",
    loopDetection: { enabled: false },
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = {
      hasHooks: vi.fn(),
      runBeforeToolCall: vi.fn(),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    hookRunner.hasHooks.mockReturnValue(false);
  });

  function createWrappedTool(
    name: string,
    execute: ReturnType<typeof vi.fn>,
    loopDetectionContext = enabledLoopDetectionContext,
  ) {
    return wrapToolWithBeforeToolCallHook(
      { name, execute } as unknown as AnyAgentTool,
      loopDetectionContext,
    );
  }

  async function withToolLoopEvents(
    run: (emitted: DiagnosticToolLoopEvent[]) => Promise<void>,
    filter: (evt: DiagnosticToolLoopEvent) => boolean = () => true,
  ) {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop" && filter(evt)) {
        emitted.push(evt);
      }
    });
    try {
      await run(emitted);
    } finally {
      stop();
    }
  }

  async function withToolExecutionEvents(
    run: (emitted: DiagnosticEventPayload[], flush: () => Promise<void>) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((evt) => {
      if (evt.type.startsWith("tool.execution.")) {
        emitted.push(evt);
      }
    });
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await run(emitted, flush);
    } finally {
      stop();
    }
  }

  function createPingPongTools(options?: { withProgress?: boolean }) {
    const readExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ type: "text", text: `read ${toolCallId}` }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "read ok" }],
          details: { ok: true },
        });
    const listExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ type: "text", text: `list ${toolCallId}` }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "list ok" }],
          details: { ok: true },
        });
    return {
      readTool: createWrappedTool("read", readExecute),
      listTool: createWrappedTool("list", listExecute),
    };
  }

  async function runPingPongSequence(
    readTool: ReturnType<typeof createWrappedTool>,
    listTool: ReturnType<typeof createWrappedTool>,
    count: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      if (i % 2 === 0) {
        await readTool.execute(`read-${i}`, { path: "/a.txt" }, undefined, undefined);
      } else {
        await listTool.execute(`list-${i}`, { dir: "/workspace" }, undefined, undefined);
      }
    }
  }

  function createGenericReadRepeatFixture() {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    return {
      tool: createWrappedTool("read", execute),
      params: { path: "/tmp/file" },
    };
  }

  function createNoProgressProcessFixture(sessionId: string) {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    });
    return {
      tool: createWrappedTool("process", execute),
      params: { action: "poll", sessionId },
    };
  }

  function expectCriticalLoopEvent(
    loopEvent: DiagnosticToolLoopEvent | undefined,
    params: {
      detector: "ping_pong" | "known_poll_no_progress";
      toolName: string;
      count?: number;
    },
  ) {
    expect(loopEvent?.type).toBe("tool.loop");
    expect(loopEvent?.level).toBe("critical");
    expect(loopEvent?.action).toBe("block");
    expect(loopEvent?.detector).toBe(params.detector);
    expect(loopEvent?.count).toBe(params.count ?? CRITICAL_THRESHOLD);
    expect(loopEvent?.toolName).toBe(params.toolName);
  }

  function expectToolLoopBlockedResult(result: unknown, expectedReason: string) {
    const record = requireRecord(result, "tool result");
    const content = requireArray(record.content, "tool result content");
    const textContent = requireRecord(content[0], "tool result content item");
    expect(textContent.type).toBe("text");
    expect(String(textContent.text)).toContain(expectedReason);
    const details = requireRecord(record.details, "tool result details");
    expect(details.status).toBe("blocked");
    expect(details.deniedReason).toBe("tool-loop");
    expect(String(details.reason)).toContain(expectedReason);
  }

  async function expectUnblockedToolExecution(
    tool: ReturnType<typeof createWrappedTool>,
    toolCallId: string,
    params: unknown,
  ) {
    const result = await tool.execute(toolCallId, params, undefined, undefined);
    const record = requireRecord(result, "tool result");
    requireArray(record.content, "tool result content");
    requireRecord(record.details, "tool result details");
    return result;
  }

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${label} was not an object`);
    }
    return value as Record<string, unknown>;
  }

  function requireArray(value: unknown, label: string): unknown[] {
    expect(Array.isArray(value)).toBe(true);
    if (!Array.isArray(value)) {
      throw new Error(`${label} was not an array`);
    }
    return value;
  }

  function expectEventFields(
    event: DiagnosticEventPayload | DiagnosticToolLoopEvent | undefined,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    const record = requireRecord(event, "diagnostic event");
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
    return record;
  }

  it("blocks known poll loops when no progress repeats", async () => {
    const { tool, params } = createNoProgressProcessFixture("sess-1");

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-${i}`, params);
    }

    const result = await tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
    expectToolLoopBlockedResult(result, "CRITICAL");
  });

  it("does nothing when loopDetection.enabled is false", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    });
    const tool = wrapToolWithBeforeToolCallHook({ name: "process", execute } as any, {
      ...disabledLoopDetectionContext,
    });
    const params = { action: "poll", sessionId: "sess-off" };

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-${i}`, params);
    }
  });

  it("does not block known poll loops when output progresses", async () => {
    const execute = vi.fn().mockImplementation(async (toolCallId: string) => {
      return {
        content: [{ type: "text", text: `output ${toolCallId}` }],
        details: { status: "running", aggregated: `output ${toolCallId}` },
      };
    });
    const tool = createWrappedTool("process", execute);
    const params = { action: "poll", sessionId: "sess-2" };

    for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-progress-${i}`, params);
    }
  });

  it("keeps generic repeated calls unblocked below critical threshold", async () => {
    const { tool, params } = createGenericReadRepeatFixture();

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `read-${i}`, params);
    }
  });

  it("blocks generic repeated no-progress calls at critical threshold", async () => {
    const { tool, params } = createGenericReadRepeatFixture();

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `read-${i}`, params);
    }

    const result = await tool.execute(`read-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
    expectToolLoopBlockedResult(result, "identical outcomes");
  });

  it("does not carry loop history across run ids", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    const params = { path: "/tmp/file" };
    const firstRunTool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      ...enabledLoopDetectionContext,
      runId: "heartbeat-1",
    });
    const secondRunTool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      ...enabledLoopDetectionContext,
      runId: "heartbeat-2",
    });

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(firstRunTool, `old-run-${i}`, params);
    }

    await expectUnblockedToolExecution(secondRunTool, "new-run-0", params);
  });

  it("escalates generic repeat diagnostics from warning to critical", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { tool, params } = createGenericReadRepeatFixture();

      for (let i = 0; i < 21; i += 1) {
        await tool.execute(`read-bucket-${i}`, params, undefined, undefined);
      }

      const genericEvents = emitted.filter((evt) => evt.detector === "generic_repeat");
      expect(genericEvents.map((evt) => [evt.level, evt.count])).toEqual([
        ["warning", 10],
        ["critical", 20],
      ]);
    });
  });

  it("emits structured warning diagnostic events for ping-pong loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, 9);

      await listTool.execute("list-9", { dir: "/workspace" }, undefined, undefined);
      await readTool.execute("read-10", { path: "/a.txt" }, undefined, undefined);
      await listTool.execute("list-11", { dir: "/workspace" }, undefined, undefined);

      const pingPongWarns = emitted.filter(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(pingPongWarns).toHaveLength(1);
      const loopEvent = pingPongWarns[0];
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("warning");
      expect(loopEvent?.action).toBe("warn");
      expect(loopEvent?.detector).toBe("ping_pong");
      expect(loopEvent?.count).toBe(10);
      expect(loopEvent?.toolName).toBe("list");
    });
  });

  it("blocks ping-pong loops at critical threshold and emits critical diagnostic events", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      const result = await listTool.execute(
        `list-${CRITICAL_THRESHOLD - 1}`,
        { dir: "/workspace" },
        undefined,
        undefined,
      );
      expectToolLoopBlockedResult(result, "CRITICAL");

      const loopEvent = emitted.at(-1);
      expectCriticalLoopEvent(loopEvent, {
        detector: "ping_pong",
        toolName: "list",
      });
    });
  });

  it("does not block ping-pong at critical threshold when outcomes are progressing", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools({ withProgress: true });
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      await expectUnblockedToolExecution(listTool, `list-${CRITICAL_THRESHOLD - 1}`, {
        dir: "/workspace",
      });

      const criticalPingPong = emitted.find(
        (evt) => evt.level === "critical" && evt.detector === "ping_pong",
      );
      expect(criticalPingPong).toBeUndefined();
      const warningPingPong = emitted.find(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expectEventFields(warningPingPong, {
        type: "tool.loop",
        level: "warning",
        action: "warn",
        detector: "ping_pong",
      });
    });
  });

  it("emits structured critical diagnostic events when blocking loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { tool, params } = createNoProgressProcessFixture("sess-crit");

      for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
        await tool.execute(`poll-${i}`, params, undefined, undefined);
      }

      const result = await tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
      expectToolLoopBlockedResult(result, "CRITICAL");

      const loopEvent = emitted.at(-1);
      expectCriticalLoopEvent(loopEvent, {
        detector: "known_poll_no_progress",
        toolName: "process",
      });
    });
  });

  it("emits diagnostic tool execution events without parameter values", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const tool = wrapToolWithBeforeToolCallHook({ name: "bash", execute } as any, {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      runId: "run-1",
      trace,
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute(
        "tool-call-1",
        { command: "pwd", token: "sk-1234567890abcdef1234567890abcdef" },
        undefined,
        undefined,
      );
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.completed",
      ]);
      const started = expectEventFields(emitted[0], {
        type: "tool.execution.started",
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        toolName: "exec",
        toolCallId: "tool-call-1",
        paramsSummary: {
          kind: "object",
        },
      });
      const startedTrace = requireRecord(started.trace, "started trace");
      expect(startedTrace.traceId).toBe(trace.traceId);
      expect(startedTrace.parentSpanId).toBe(trace.spanId);
      expect(typeof startedTrace.spanId).toBe("string");
      expect(startedTrace.traceFlags).toBe(trace.traceFlags);
      expect(emitted[0]?.trace).not.toBe(trace);
      expect(Object.isFrozen(emitted[0]?.trace)).toBe(true);
      const completed = expectEventFields(emitted[1], {
        type: "tool.execution.completed",
      });
      expect(typeof completed.durationMs).toBe("number");
      expect(JSON.stringify(emitted)).not.toContain("sk-1234567890abcdef1234567890abcdef");
      expect(JSON.stringify(emitted)).not.toContain("pwd");
    });
  });

  it("emits diagnostic tool execution error events with redacted errors", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new Error("failed with key sk-1234567890abcdef1234567890abcdef"));
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-error", { path: "/tmp/file" }, undefined, undefined),
      ).rejects.toThrow("failed with key");
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.error",
      ]);
      const errorEvent = expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolName: "read",
        toolCallId: "tool-call-error",
        errorCategory: "Error",
      });
      expect(typeof errorEvent.durationMs).toBe("number");
      expect(JSON.stringify(emitted[1])).not.toContain("sk-1234567890abcdef1234567890abcdef");
    });
  });

  it("emits blocked diagnostics without error severity for intentional hook vetoes", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "blocked by policy",
    });
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "nope" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      const result = await tool.execute("tool-call-blocked", { path: "/tmp/file" });
      await flush();

      expect(result).toEqual({
        content: [{ type: "text", text: "blocked by policy" }],
        details: {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(emitted.map((evt) => evt.type)).toEqual(["tool.execution.blocked"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.blocked",
        toolName: "read",
        toolCallId: "tool-call-blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked by policy",
      });
    });
  });

  it("does not let hostile thrown values break diagnostic error emission", async () => {
    const hostileError = new Proxy(
      {},
      {
        get() {
          throw new Error("diagnostic getter should not run");
        },
        getOwnPropertyDescriptor() {
          throw new Error("diagnostic descriptor failed");
        },
      },
    );
    const execute = vi.fn().mockRejectedValue(hostileError);
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-hostile-error", { path: "/tmp/file" }, undefined, undefined),
      ).rejects.toBe(hostileError);
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.error",
      ]);
      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolName: "read",
        toolCallId: "tool-call-hostile-error",
        errorCategory: "object",
      });
      expect(emitted[1]).not.toHaveProperty("errorCode");
    });
  });

  it("emits only numeric HTTP status codes as diagnostic tool error codes", async () => {
    const error = Object.assign(new Error("rate limited"), {
      code: "SECRET_TOKEN",
      status: 429,
    });
    const execute = vi.fn().mockRejectedValue(error);
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-status-code", { path: "/tmp/file" }, undefined, undefined),
      ).rejects.toThrow("rate limited");
      await flush();

      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        errorCode: "429",
      });
      expect(JSON.stringify(emitted[1])).not.toContain("SECRET_TOKEN");
    });
  });

  it("summarizes hostile object params without enumerating keys", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook({ name: "bash", execute } as any, {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });
    const params = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("should not enumerate params");
        },
      },
    );

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute("tool-call-proxy", params, undefined, undefined);
      await flush();

      const started = expectEventFields(emitted[0], {
        type: "tool.execution.started",
      });
      expect(started.paramsSummary).toEqual({ kind: "object" });
    });
  });
});

describe("before_tool_call requireApproval handling", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };
  const mockCallGateway = vi.mocked(callGatewayTool);

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${label} was not an object`);
    }
    return value as Record<string, unknown>;
  }

  function requireHookCall(
    index: number,
  ): [event: Record<string, unknown>, context: Record<string, unknown>] {
    const call = hookRunner.runBeforeToolCall.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing before_tool_call hook call ${index + 1}`);
    }
    return [
      requireRecord(call[0], "before_tool_call event"),
      requireRecord(call[1], "before_tool_call context"),
    ];
  }

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn(),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    // Keep the global singleton aligned as a fallback in case another setup path
    // preloads hook-runner-global before this test's module reset/mocks take effect.
    const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
    const hookRunnerGlobalState = globalThis as Record<
      symbol,
      { hookRunner: unknown; registry?: unknown } | undefined
    >;
    if (!hookRunnerGlobalState[hookRunnerGlobalStateKey]) {
      hookRunnerGlobalState[hookRunnerGlobalStateKey] = {
        hookRunner: null,
        registry: null,
      };
    }
    hookRunnerGlobalState[hookRunnerGlobalStateKey].hookRunner = hookRunner;
    mockCallGateway.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function runAbortDuringApprovalWait(options?: { onResolution?: ReturnType<typeof vi.fn> }) {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Abortable",
        description: "Will be aborted",
        onResolution: options?.onResolution,
      },
    });

    const controller = new AbortController();
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-abort", status: "accepted" });
    mockCallGateway.mockImplementationOnce(() => new Promise(() => {}));
    setTimeout(() => controller.abort(new Error("run cancelled")), 10);

    return await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
      signal: controller.signal,
    });
  }

  it("blocks without triggering approval when both block and requireApproval are set", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "Blocked by security plugin",
      requireApproval: {
        title: "Should not reach gateway",
        description: "This approval should be skipped",
        pluginId: "lower-priority-plugin",
      },
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Blocked by security plugin");
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it("blocks when before_tool_call hook execution throws", async () => {
    hookRunner.runBeforeToolCall.mockRejectedValueOnce(new Error("hook crashed"));

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "ls" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty(
      "reason",
      "Tool call blocked because before_tool_call hook failed",
    );
  });

  it("passes diagnostic trace context to before_tool_call hooks", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "pwd" },
      toolCallId: "tool-1",
      ctx: { agentId: "main", sessionKey: "main", runId: "run-1", trace },
    });

    expect(result.blocked).toBe(false);
    const [event, toolContext] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expectRecordFields(toolContext, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expect(toolContext.trace).toEqual(trace);
    expect(toolContext.trace).not.toBe(trace);
    expect(Object.isFrozen(toolContext.trace)).toBe(true);
  });

  it("passes host-derived apply_patch paths to before_tool_call hooks", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@",
      "+y",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-1",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result.blocked).toBe(false);
    const [event, context] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
      derivedPaths: [
        path.join(cwd, "src/new.ts"),
        path.join(cwd, "src/old.ts"),
        path.join(cwd, "src/renamed.ts"),
        path.join(cwd, "src/dead.ts"),
      ],
    });
    expectRecordFields(context, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
    });
  });

  it("derives sandboxed apply_patch paths through the sandbox bridge", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /workspace/src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-sandbox",
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: ({ filePath }: { filePath: string }) => ({
              containerPath: filePath,
              hostPath: "/host/sandbox/src/new.ts",
              relativePath: "src/new.ts",
            }),
          } as never,
        },
        sessionKey: "main",
        runId: "run-patch",
      },
    });

    expect(result.blocked).toBe(false);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      derivedPaths: ["/host/sandbox/src/new.ts"],
    });
  });

  it("does not fail hooks when sandbox path derivation rejects a target", async () => {
    const patch = ["*** Begin Patch", "*** Add File: /outside.ts", "+x", "*** End Patch"].join(
      "\n",
    );
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-sandbox-rejected",
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: () => {
              throw new Error("Path escapes sandbox root");
            },
          } as never,
        },
        sessionKey: "main",
        runId: "run-patch",
      },
    });

    expect(result.blocked).toBe(false);
    const [event, context] = requireHookCall(0);
    expect(event).not.toHaveProperty("derivedPaths");
    expectRecordFields(context, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-sandbox-rejected",
    });
  });

  it("skips derived path extraction when no policies or hooks can consume it", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const params = {};
    Object.defineProperty(params, "input", {
      enumerable: true,
      get() {
        throw new Error("should not derive paths");
      },
    });

    await expect(
      runBeforeToolCallHook({
        toolName: "apply_patch",
        params,
        toolCallId: "patch-no-hooks",
      }),
    ).resolves.toEqual({ blocked: false, params });
    expect(hookRunner.runBeforeToolCall).not.toHaveBeenCalled();
  });

  it("recomputes host-derived paths after trusted policy param rewrites", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const originalPatch = [
      "*** Begin Patch",
      "*** Add File: src/old.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const rewrittenPatch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const seenByLaterPolicy: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-rewriter",
        pluginName: "Trusted Rewriter",
        source: "test",
        policy: {
          id: "rewrite",
          description: "rewrite",
          evaluate: () => ({ params: { input: rewrittenPatch } }),
        },
      },
      {
        pluginId: "trusted-inspector",
        pluginName: "Trusted Inspector",
        source: "test",
        policy: {
          id: "inspect",
          description: "inspect",
          evaluate: (event) => {
            seenByLaterPolicy.push(event.derivedPaths);
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: originalPatch },
      toolCallId: "patch-rewrite",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result).toEqual({ blocked: false, params: { input: rewrittenPatch } });
    expect(seenByLaterPolicy).toEqual([[path.join(cwd, "src/new.ts")]]);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      params: { input: rewrittenPatch },
      derivedPaths: [path.join(cwd, "src/new.ts")],
    });
  });

  it("calls gateway RPC and unblocks on allow-once", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Sensitive",
        description: "Sensitive op",
        pluginId: "sage",
      },
    });

    // First call: plugin.approval.request → returns server-generated id
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-1", status: "accepted" });
    // Second call: plugin.approval.waitDecision → returns allow-once
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-1", decision: "allow-once" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(false);
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
    const requestCall = mockCallGateway.mock.calls.at(0);
    expect(requestCall?.[0]).toBe("plugin.approval.request");
    requireRecord(requestCall?.[1], "approval request gateway client");
    expect(requireRecord(requestCall?.[2], "approval request params").twoPhase).toBe(true);
    expect(requestCall?.[3]).toEqual({ expectFinal: false });
    const waitCall = mockCallGateway.mock.calls.at(1);
    expect(waitCall?.[0]).toBe("plugin.approval.waitDecision");
    requireRecord(waitCall?.[1], "approval wait gateway client");
    expect(waitCall?.[2]).toEqual({ id: "server-id-1" });
  });

  it("blocks on deny decision", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Dangerous",
        description: "Dangerous op",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-2", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-2", decision: "deny" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Denied by user");
  });

  it("blocks on timeout with default deny behavior", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Timeout test",
        description: "Will time out",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-3", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-3", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval timed out");
  });

  it("allows on timeout when timeoutBehavior is allow and preserves hook params", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { command: "safe-command" },
      requireApproval: {
        title: "Lenient timeout",
        description: "Should allow on timeout",
        timeoutBehavior: "allow",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-4", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-4", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf /" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.params).toEqual({ command: "safe-command" });
    }
  });

  it("falls back to block on gateway error", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Gateway down",
        description: "Gateway is unavailable",
      },
    });

    mockCallGateway.mockRejectedValueOnce(new Error("unknown method plugin.approval.request"));

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval required (gateway unavailable)");
  });

  it("blocks when gateway returns no id", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No ID",
        description: "Registration returns no id",
      },
    });

    mockCallGateway.mockResolvedValueOnce({ status: "error" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Registration returns no id");
  });

  it("blocks on immediate null decision without calling waitDecision even when timeoutBehavior is allow", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No route",
        description: "No approval route available",
        timeoutBehavior: "allow",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-immediate", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval unavailable (no approval route)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
    expect(mockCallGateway.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
    ]);
  });

  it("unblocks immediately when abort signal fires during waitDecision", async () => {
    const result = await runAbortDuringApprovalWait();

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
  });

  it("removes abort listener after waitDecision resolves", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Cleanup listener",
        description: "Wait resolves quickly",
      },
    });

    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener");

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-cleanup", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-cleanup", decision: "allow-once" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
      signal: controller.signal,
    });

    expect(result.blocked).toBe(false);
    expect(removeListenerSpy.mock.calls.map(([type]) => type)).toContain("abort");
  });

  it("calls onResolution with allow-once on approval", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Needs approval",
        description: "Check this",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1", decision: "allow-once" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("allow-once");
  });

  it("allows allow-always decisions for tool approvals", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Needs durable approval",
        description: "Check this durable approval",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-allow-always", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-allow-always",
      decision: "allow-always",
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "echo ok" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({ blocked: false, params: { command: "echo ok" } });
    expect(onResolution).toHaveBeenCalledWith("allow-always");
  });

  it("does not await onResolution before returning approval outcome", async () => {
    const onResolution = vi.fn(() => new Promise<void>(() => {}));

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Non-blocking callback",
        description: "Should not block tool execution",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1-nonblocking", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-r1-nonblocking",
      decision: "allow-once",
    });

    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        runBeforeToolCallHook({
          toolName: "bash",
          params: {},
          ctx: { agentId: "main", sessionKey: "main" },
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("runBeforeToolCallHook waited for onResolution")),
            250,
          );
        }),
      ]);

      expect(result).toEqual({ blocked: false, params: {} });
      expect(onResolution).toHaveBeenCalledWith("allow-once");
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  });

  it("calls onResolution with deny on denial", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Needs approval",
        description: "Check this",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r2", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r2", decision: "deny" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("deny");
  });

  it("calls onResolution with timeout when decision is null", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Timeout resolution",
        description: "Will time out",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r3", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r3", decision: null });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("timeout");
  });

  it("calls onResolution with cancelled on gateway error", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Gateway error",
        description: "Gateway will fail",
        onResolution,
      },
    });

    mockCallGateway.mockRejectedValueOnce(new Error("gateway down"));

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval required (gateway unavailable)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("calls onResolution with cancelled when abort signal fires", async () => {
    const onResolution = vi.fn();
    const result = await runAbortDuringApprovalWait({ onResolution });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("calls onResolution with cancelled when gateway returns no id", async () => {
    const onResolution = vi.fn();

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "No ID",
        description: "Registration returns no id",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ status: "error" });

    await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });
});
