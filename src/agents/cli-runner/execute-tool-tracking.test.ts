import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  updateMcpLoopbackToolCallCapture,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";

type Tracking = ReturnType<typeof createCliToolTracking>;

function createTracking() {
  const context = buildPreparedCliRunContext();
  context.preparedBackend.mcpClientGrantCapture = {
    transportToken: "test-token",
    adoptProcessToken: vi.fn(),
    revokeProcessToken: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
  };
  const tracking = createCliToolTracking(context);
  tracking.beginGatewayCapture("deadline-test");
  return tracking;
}

function startParsed(tracking: Tracking, toolCallId: string, args: Record<string, unknown>) {
  tracking.handleCliToolUseStart({
    toolCallId,
    name: "mcp__openclaw__ask_user",
    kind: "mcp_tool_use",
    args,
  });
}

function startQuestion(tracking: Tracking, toolCallId: string, timeoutSeconds?: unknown) {
  const args = { questions: [], timeoutSeconds };
  startParsed(tracking, toolCallId, args);
  const capture = markMcpLoopbackToolCallStarted({
    captureKey: "deadline-test",
    toolName: "ask_user",
    args,
  });
  if (!capture) {
    throw new Error("expected captured ask_user call");
  }
  updateMcpLoopbackToolCallCapture(capture, { toolName: "ask_user", args });
  return capture;
}

describe("CLI loopback ask_user deadline tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the deadline until Claude emits the correlated tool result", () => {
    const tracking = createTracking();
    const listener = vi.fn();
    tracking.onActiveLoopbackAskUserDeadlineChange(listener);
    const capture = startQuestion(tracking, "tool-1");
    expect(tracking.getActiveLoopbackAskUserDeadline()).toBe(Date.now() + 910_000);
    expect(listener).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(900_000);
    recordMcpLoopbackToolCallResult({
      captureHandle: capture,
      toolName: "ask_user",
      args: capture.call.args,
      outcome: "completed",
    });
    startQuestion(tracking, "tool-2", 60);
    expect(tracking.getActiveLoopbackAskUserDeadline()).toBe(Date.now() + 10_000);
    expect(listener).toHaveBeenCalledOnce();

    tracking.handleCliToolResult({
      toolCallId: "tool-1",
      name: "mcp__openclaw__ask_user",
      isError: false,
    });
    expect(tracking.getActiveLoopbackAskUserDeadline()).toBe(Date.now() + 70_000);
    expect(listener).toHaveBeenCalledTimes(2);

    tracking.handleCliToolResult({
      toolCallId: "tool-2",
      name: "mcp__openclaw__ask_user",
      isError: false,
    });
    expect(tracking.getActiveLoopbackAskUserDeadline()).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(3);
    tracking.finalizeCapture(() => {});
  });

  it("reports the earliest concurrent uniquely correlated question", () => {
    const tracking = createTracking();
    startQuestion(tracking, "later", 600);
    vi.advanceTimersByTime(100);
    startQuestion(tracking, "earlier", 30);
    expect(tracking.getActiveLoopbackAskUserDeadline()).toBe(Date.now() + 40_000);
    tracking.finalizeCapture(() => {});
  });

  it("fails closed for invalid and ambiguous correlation", () => {
    const tracking = createTracking();
    startQuestion(tracking, "invalid", "bad");
    expect(tracking.getActiveLoopbackAskUserDeadline()).toBeUndefined();
    tracking.handleCliToolResult({
      toolCallId: "invalid",
      name: "mcp__openclaw__ask_user",
      isError: true,
    });

    const args = { questions: [], timeoutSeconds: 3_600 };
    startParsed(tracking, "duplicate-1", args);
    startParsed(tracking, "duplicate-2", args);
    const capture = markMcpLoopbackToolCallStarted({
      captureKey: "deadline-test",
      toolName: "ask_user",
      args,
    });
    updateMcpLoopbackToolCallCapture(capture, { toolName: "ask_user", args });
    expect(tracking.getActiveLoopbackAskUserDeadline()).toBeUndefined();
    tracking.finalizeCapture(() => {});
  });

  it("fails closed after correlation overflow", () => {
    const tracking = createTracking();
    for (let index = 0; index < 65; index += 1) {
      startQuestion(tracking, `overflow-${index}`, 30 + index);
      if (index === 0) {
        expect(tracking.getActiveLoopbackAskUserDeadline()).toBeDefined();
      }
    }
    expect(tracking.getActiveLoopbackAskUserDeadline()).toBeUndefined();
    tracking.finalizeCapture(() => {});
  });
});
