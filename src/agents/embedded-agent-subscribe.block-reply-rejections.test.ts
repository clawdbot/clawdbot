// Block-reply rejection tests ensure async callback failures are contained and
// do not escape as process-level unhandled rejections.
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
