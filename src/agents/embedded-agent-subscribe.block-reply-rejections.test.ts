// Block-reply rejection tests ensure async callback failures are contained and
// do not escape as process-level unhandled rejections.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../auto-reply/heartbeat-tool-response.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  emitMessageStartAndEndForAssistantText,
} from "./embedded-agent-subscribe.e2e-harness.js";

const waitForAsyncCallbacks = async () => {
  // Block reply callbacks are scheduled asynchronously; this drains both
  // microtasks and the immediate queue before checking unhandled rejections.
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

function emitToolRun(params: {
  emit: (evt: unknown) => void;
  toolName: string;
  toolCallId: string;
  result: unknown;
}): void {
  params.emit({
    type: "tool_execution_start",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    args: {},
  });
  params.emit({
    type: "tool_execution_end",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    isError: false,
    result: params.result,
  });
}

describe("subscribeEmbeddedAgentSession block reply rejections", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    // Capture process-level failures so tests prove callback containment.
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
  });

  it("contains rejected async text_end block replies", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onBlockReply = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected async message_end block replies", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onBlockReply = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Hello block" });
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected assistant progress callbacks", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const rejectedCallback = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onAgentEvent: rejectedCallback,
      onPartialReply: rejectedCallback,
      onAssistantMessageStart: rejectedCallback,
      onReasoningStream: rejectedCallback,
      onReasoningEnd: rejectedCallback,
      reasoningMode: "stream",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Hello" });
    emitAssistantTextDelta({ emit, delta: "Hello" });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "Because" },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_end" },
    });
    await waitForAsyncCallbacks();

    expect(rejectedCallback).toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected tool presentation callbacks", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onToolResult = vi.fn().mockRejectedValue(new Error("tool progress failed"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onToolResult,
      verboseLevel: "full",
    });

    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "tool-1",
      result: { content: [{ type: "text", text: "file contents" }] },
    });
    await waitForAsyncCallbacks();

    expect(onToolResult).toHaveBeenCalled();
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected heartbeat response callbacks", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onHeartbeatToolResponse = vi.fn().mockRejectedValue(new Error("heartbeat failed"));
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      onHeartbeatToolResponse,
    });

    emitToolRun({
      emit,
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      toolCallId: "heartbeat-1",
      result: {
        details: {
          status: "recorded",
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        },
      },
    });
    await waitForAsyncCallbacks();

    expect(onHeartbeatToolResponse).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toHaveLength(0);
  });
});
