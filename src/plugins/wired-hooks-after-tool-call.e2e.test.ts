import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * Test: after_tool_call hook wiring (pi-embedded-subscribe.handlers.tools.ts)
 */
import { createBaseToolHandlerState } from "../agents/pi-tool-handler-state.test-helpers.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeToolCall: vi.fn(async () => {}),
    runAfterToolCall: vi.fn(async () => {}),
  },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

// Mock agent events (used by handlers)
vi.mock("../infra/agent-events.js", () => ({
  emitAgentCommandOutputEvent: vi.fn(),
  emitAgentItemEvent: vi.fn(),
  emitAgentEvent: vi.fn(),
}));

function createToolHandlerCtx(params: {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  onBlockReplyFlush?: unknown;
}) {
  return {
    params: {
      runId: params.runId,
      session: { messages: [] },
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      onBlockReplyFlush: params.onBlockReplyFlush,
    },
    hookRunner: hookMocks.runner,
    state: {
      ...createBaseToolHandlerState(),
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    flushBlockReplyBuffer: vi.fn(),
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };
}

function getAfterToolCallCall(index = 0) {
  const call = (hookMocks.runner.runAfterToolCall as ReturnType<typeof vi.fn>).mock.calls[index];
  return {
    event: call?.[0] as
      | {
          toolName?: string;
          params?: unknown;
          error?: unknown;
          durationMs?: unknown;
          runId?: string;
          toolCallId?: string;
        }
      | undefined,
    context: call?.[1] as
      | {
          toolName?: string;
          agentId?: string;
          sessionKey?: string;
          sessionId?: string;
          runId?: string;
          toolCallId?: string;
        }
      | undefined,
  };
}

function expectAfterToolCallPayload(params: {
  index?: number;
  expectedEvent: Record<string, unknown>;
  expectedContext: Record<string, unknown>;
}) {
  const { event, context } = getAfterToolCallCall(params.index);
  expect(event).toBeDefined();
  expect(context).toBeDefined();
  if (!event || !context) {
    throw new Error("missing hook call payload");
  }
  expect(event).toEqual(expect.objectContaining(params.expectedEvent));
  expect(context).toEqual(expect.objectContaining(params.expectedContext));
}

let handleToolExecutionStart: typeof import("../agents/pi-embedded-subscribe.handlers.tools.js").handleToolExecutionStart;
let handleToolExecutionEnd: typeof import("../agents/pi-embedded-subscribe.handlers.tools.js").handleToolExecutionEnd;

describe("after_tool_call hook wiring", () => {
  beforeAll(async () => {
    ({ handleToolExecutionStart, handleToolExecutionEnd } =
      await import("../agents/pi-embedded-subscribe.handlers.tools.js"));
  });

  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeToolCall.mockClear();
    hookMocks.runner.runBeforeToolCall.mockResolvedValue(undefined);
    hookMocks.runner.runAfterToolCall.mockClear();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
  });

  it("calls runAfterToolCall in handleToolExecutionEnd when hook is registered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createToolHandlerCtx({
      runId: "test-run-1",
      agentId: "main",
      sessionKey: "test-session",
      sessionId: "test-ephemeral-session",
    });

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "wired-hook-call-1",
        args: { path: "/tmp/file.txt" },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "wired-hook-call-1",
        isError: false,
        result: { content: [{ type: "text", text: "file contents" }] },
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runBeforeToolCall).not.toHaveBeenCalled();
    expectAfterToolCallPayload({
      expectedEvent: {
        toolName: "read",
        params: { path: "/tmp/file.txt" },
        error: undefined,
        runId: "test-run-1",
        toolCallId: "wired-hook-call-1",
      },
      expectedContext: {
        toolName: "read",
        agentId: "main",
        sessionKey: "test-session",
        sessionId: "test-ephemeral-session",
        runId: "test-run-1",
        toolCallId: "wired-hook-call-1",
      },
    });
    expect(typeof getAfterToolCallCall().event?.durationMs).toBe("number");
  });

  it("includes error in after_tool_call event on tool failure", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createToolHandlerCtx({ runId: "test-run-2" });

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId: "call-err",
        args: { command: "fail" },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "call-err",
        isError: true,
        result: { status: "error", error: "command failed" },
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(1);
    expect(getAfterToolCallCall().event?.error).toBeDefined();
    expect(getAfterToolCallCall().context?.agentId).toBeUndefined();
  });

  it("does not call runAfterToolCall when no hooks registered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(false);

    const ctx = createToolHandlerCtx({ runId: "r" });

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "call-2",
        isError: false,
        result: {},
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("keeps start args isolated per run when toolCallId collides", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sharedToolCallId = "shared-tool-call-id";

    const ctxA = createToolHandlerCtx({
      runId: "run-a",
      sessionKey: "session-a",
      sessionId: "ephemeral-a",
      agentId: "agent-a",
    });
    const ctxB = createToolHandlerCtx({
      runId: "run-b",
      sessionKey: "session-b",
      sessionId: "ephemeral-b",
      agentId: "agent-b",
    });

    await handleToolExecutionStart(
      ctxA as never,
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: sharedToolCallId,
        args: { path: "/tmp/path-a.txt" },
      } as never,
    );
    await handleToolExecutionStart(
      ctxB as never,
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: sharedToolCallId,
        args: { path: "/tmp/path-b.txt" },
      } as never,
    );

    await handleToolExecutionEnd(
      ctxA as never,
      {
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: sharedToolCallId,
        isError: false,
        result: { content: [{ type: "text", text: "done-a" }] },
      } as never,
    );
    await handleToolExecutionEnd(
      ctxB as never,
      {
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: sharedToolCallId,
        isError: false,
        result: { content: [{ type: "text", text: "done-b" }] },
      } as never,
    );

    expect(hookMocks.runner.runAfterToolCall).toHaveBeenCalledTimes(2);
    expectAfterToolCallPayload({
      index: 0,
      expectedEvent: { runId: "run-a", params: { path: "/tmp/path-a.txt" } },
      expectedContext: {},
    });
    expectAfterToolCallPayload({
      index: 1,
      expectedEvent: { runId: "run-b", params: { path: "/tmp/path-b.txt" } },
      expectedContext: {},
    });
  });
});
