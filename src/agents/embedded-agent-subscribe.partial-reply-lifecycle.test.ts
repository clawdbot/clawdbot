import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  isEnabled: vi.fn(() => false),
  trace: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => logger,
}));

import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";

function emitPartialThenProviderFailure(emit: (event: unknown) => void): void {
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
  });
  const failedAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
    stopReason: "error",
    errorMessage: "provider failed after partial",
    provider: "test-provider",
    model: "test-model",
  };
  emit({ type: "message_end", message: failedAssistant });
  emit({ type: "agent_end", messages: [failedAssistant], willRetry: false });
}

describe("subscribeEmbeddedAgentSession partial reply lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins a partial reply task created while terminal events settle", async () => {
    let resolvePartial: (() => void) | undefined;
    const onPartialReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePartial = resolve;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-provider-failure",
      onBeforeTerminalDelivery: async () => undefined,
      onPartialReply,
    });

    emitPartialThenProviderFailure(emit);
    let settled = false;
    const settlement = subscription.waitForPendingEvents().then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePartial?.();
    await settlement;
    expect(settled).toBe(true);
  });

  it("contains and logs a rejected partial reply after unsubscribe", async () => {
    const callbackError = new Error("draft send rejected");
    let rejectPartial: ((reason: unknown) => void) | undefined;
    const onPartialReply = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPartial = reject;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-rejection",
      onPartialReply,
    });

    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
    });

    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    subscription.unsubscribe();
    rejectPartial?.(callbackError);
    await expect(subscription.waitForPendingEvents()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      `assistant partial reply callback failed: ${String(callbackError)}`,
    );
  });

  it("queue-only drain is not blocked by a stalled partial reply callback", async () => {
    // Timeout salvage drains only the serialized event chain — the queue whose handlers mutate the assistant
    // text buffer. A stalled onPartialReply transport callback is external
    // fan-out and cannot change the buffered text, so it must not hold an
    // already-aborted run in settlement. Pre-fix, the salvage path used
    // waitForPendingEvents, which also awaits pendingPartialReplyTasks; a
    // stalled callback would block the drain until the bounded liveness
    // deadline (120s) elapsed.
    let resolvePartialReply!: () => void;
    const partialReply = new Promise<void>((resolve) => {
      resolvePartialReply = resolve;
    });
    const onPartialReply = vi.fn(() => partialReply);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-stalled-partial-callback",
      onPartialReply,
    });

    // First delta keeps the partial-reply callback pending through the queue-only drain.
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "partial " },
    });
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());

    // A second delta queues behind the first on the serialized event chain.
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "answer" },
    });

    let broadDrained = false;
    const broadDrain = subscription.waitForPendingEvents().then(() => {
      broadDrained = true;
    });

    // The event chain drains while the broad join still waits for the callback.
    await subscription.waitForPendingEvents({ includePartialReplies: false });
    expect(broadDrained).toBe(false);

    resolvePartialReply();
    await broadDrain;
    expect(broadDrained).toBe(true);

    subscription.unsubscribe();
  });
});
