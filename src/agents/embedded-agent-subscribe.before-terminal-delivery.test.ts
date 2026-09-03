// Before-terminal-delivery tests cover the async gate that can suppress or
// release deferred assistant events and block replies at run completion.
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { AssistantMessage } from "../llm/types.js";
import {
  emitAssistantTextDeltaAndEnd,
  emitAssistantTextDelta,
  createSubscribedSessionHarness,
  emitMessageStartAndEndForAssistantText,
} from "./embedded-agent-subscribe.e2e-harness.js";

function hasAssistantEvent(calls: Array<unknown[]>): boolean {
  // The gate buffers assistant stream events; tests use this helper to assert
  // nothing leaks before the terminal decision resolves.
  return calls.some((call) => {
    const event = call[0] as { stream?: string } | undefined;
    return event?.stream === "assistant";
  });
}

function hasLifecycleEndEvent(calls: Array<unknown[]>): boolean {
  return calls.some((call) => {
    const event = call[0] as { stream?: string; data?: { phase?: string } } | undefined;
    return event?.stream === "lifecycle" && event.data?.phase === "end";
  });
}

describe("subscribeEmbeddedAgentSession before terminal delivery", () => {
  it("streams commentary before tools while retaining the revisable final reply gate", async () => {
    const onAgentEvent = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => ({
      suppressTerminalDelivery: true as const,
    }));
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-commentary",
      onAgentEvent,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });
    const commentaryMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Checking current state.",
          textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
        },
      ],
      stopReason: "toolUse",
    } as AssistantMessage;

    emit({ type: "message_start", message: commentaryMessage });
    emit({ type: "message_end", message: commentaryMessage });

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "item",
      data: expect.objectContaining({
        kind: "preamble",
        progressText: "Checking current state.",
      }),
    });
    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-after-commentary",
      args: {},
    });
    const preambleCallIndex = onAgentEvent.mock.calls.findIndex(
      ([event]) => event.stream === "item" && event.data?.kind === "preamble",
    );
    const toolCallIndex = onAgentEvent.mock.calls.findIndex(
      ([event]) => event.stream === "item" && event.data?.kind === "tool",
    );
    expect(preambleCallIndex).toBeGreaterThanOrEqual(0);
    expect(toolCallIndex).toBeGreaterThan(preambleCallIndex);

    emitAssistantTextDeltaAndEnd({ emit, text: "Visible final answer." });
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Visible final answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);
  });

  it("suppresses deferred block replies when the terminal gate requests a revision", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => ({
      suppressTerminalDelivery: true,
    }));
    const { emit } = createSubscribedSessionHarness({
      runId: "run-before-terminal-revise",
      onBlockReply,
      onAgentEvent,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "First answer.",
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "First answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBeforeTerminalDelivery).toHaveBeenCalledTimes(1));
    expect(onBeforeTerminalDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        hasAssistantVisibleText: true,
        isError: false,
        incompleteTerminalAssistant: false,
        willRetry: false,
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(false);
  });

  it("waits for async terminal gate decisions before draining", async () => {
    // waitForPendingEvents must include the gate promise or callers can observe
    // a drained subscription before terminal delivery has been decided.
    const onBlockReply = vi.fn();
    let resolveGate: ((value: { suppressTerminalDelivery: true }) => void) | undefined;
    const onBeforeTerminalDelivery = vi.fn(
      () =>
        new Promise<{ suppressTerminalDelivery: true }>((resolve) => {
          resolveGate = resolve;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-wait",
      onBlockReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Slow revise answer.",
    });
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Slow revise answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBeforeTerminalDelivery).toHaveBeenCalledTimes(1));
    let drained = false;
    const waitPromise = subscription.waitForPendingEvents().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveGate?.({ suppressTerminalDelivery: true });
    await waitPromise;
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("defers assistant stream and partial replies until the terminal gate continues", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-assistant-stream",
      onAgentEvent,
      onPartialReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    for (const delta of ["Visible", " stream", "."]) {
      emitAssistantTextDelta({ emit, delta });
    }
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Visible stream." }] },
    });
    expect(hasAssistantEvent(onAgentEvent.mock.calls)).toBe(false);
    expect(onPartialReply).not.toHaveBeenCalled();

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Visible stream." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    const assistantEvents = onAgentEvent.mock.calls.filter(
      ([event]) => event.stream === "assistant",
    );
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0]?.[0].data).toMatchObject({
      text: "Visible stream.",
      delta: "Visible stream.",
    });
    expect(onPartialReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "Visible stream.", delta: "Visible stream." }),
    );
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(true);
  });

  it("does not send final-only assistant events through partial replies", async () => {
    const onPartialReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => undefined);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-final-only",
      onPartialReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Final only.",
    });
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Final only." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("finalizes normally when the terminal gate rejects", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => {
      throw new Error("hook failed");
    });
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-before-terminal-reject",
      onBlockReply,
      onAgentEvent,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Fallback answer.",
    });
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Fallback answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await subscription.waitForPendingEvents();
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Fallback answer." }),
      { assistantMessageIndex: 1 },
    );
    expect(hasLifecycleEndEvent(onAgentEvent.mock.calls)).toBe(true);
  });

  it("flushes deferred block replies when the terminal gate continues", async () => {
    const onBlockReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn(async () => undefined);
    const { emit } = createSubscribedSessionHarness({
      runId: "run-before-terminal-continue",
      onBlockReply,
      onBeforeTerminalDelivery,
      blockReplyBreak: "message_end",
    });

    emitMessageStartAndEndForAssistantText({
      emit,
      text: "Accepted answer.",
    });
    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Accepted answer." }],
          stopReason: "stop",
        },
      ],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledTimes(1));
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Accepted answer." }),
      { assistantMessageIndex: 1 },
    );
  });

  it("preserves original transcript media references on deferred block replies", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-before-terminal-media",
      onBlockReply,
      onBeforeTerminalDelivery: vi.fn(async () => undefined),
      blockReplyBreak: "message_end",
    });
    const text = "MEDIA:/tmp/generated.png\nAttached image";

    emitMessageStartAndEndForAssistantText({ emit, text });
    emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
      willRetry: false,
    });

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledTimes(1));
    const payload = onBlockReply.mock.calls[0]?.[0] as object;
    expect(getReplyPayloadMetadata(payload)).toMatchObject({
      assistantMessageIndex: 1,
      assistantTranscriptMediaUrls: ["/tmp/generated.png"],
    });
  });
});
