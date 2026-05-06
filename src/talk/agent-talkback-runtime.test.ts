import { describe, expect, it, vi } from "vitest";
import { createRealtimeVoiceAgentTalkbackQueue } from "./agent-talkback-runtime.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("realtime voice agent talkback queue", () => {
  it("debounces transcript fragments into one consult", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const consult = vi.fn(async ({ question }) => ({ text: `answer:${question}` }));
    const deliver = vi.fn();
    const queue = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: 100,
      isStopped: () => false,
      logger,
      logPrefix: "[test]",
      responseStyle: "brief",
      fallbackText: "fallback",
      consult,
      deliver,
    });

    queue.enqueue("first");
    queue.enqueue("second");
    await vi.advanceTimersByTimeAsync(100);

    expect(consult).toHaveBeenCalledWith({
      question: "first\nsecond",
      responseStyle: "brief",
      signal: expect.any(AbortSignal),
    });
    expect(deliver).toHaveBeenCalledWith("answer:first\nsecond");
    vi.useRealTimers();
  });

  it("accumulates pending questions while a consult is active", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    let finishFirst: ((value: { text: string }) => void) | undefined;
    const consult = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ text: string }>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ text: "second-answer" });
    const deliver = vi.fn();
    const queue = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: 10,
      isStopped: () => false,
      logger,
      logPrefix: "[test]",
      responseStyle: "brief",
      fallbackText: "fallback",
      consult,
      deliver,
    });

    queue.enqueue("first");
    await vi.advanceTimersByTimeAsync(10);
    queue.enqueue("ignored");
    queue.enqueue("second");
    await vi.advanceTimersByTimeAsync(10);
    finishFirst?.({ text: "first-answer" });
    await vi.runAllTimersAsync();

    expect(consult).toHaveBeenNthCalledWith(1, {
      question: "first",
      responseStyle: "brief",
      signal: expect.any(AbortSignal),
    });
    expect(consult).toHaveBeenNthCalledWith(2, {
      question: "ignored\nsecond",
      responseStyle: "brief",
      signal: expect.any(AbortSignal),
    });
    expect(deliver).toHaveBeenCalledWith("first-answer");
    expect(deliver).toHaveBeenCalledWith("second-answer");
    vi.useRealTimers();
  });

  it("delivers fallback text when consult fails", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const deliver = vi.fn();
    const queue = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: 1,
      isStopped: () => false,
      logger,
      logPrefix: "[test]",
      responseStyle: "brief",
      fallbackText: "fallback",
      consult: vi.fn(async () => {
        throw new Error("boom");
      }),
      deliver,
    });

    queue.enqueue("question");
    await vi.advanceTimersByTimeAsync(1);

    expect(logger.warn).toHaveBeenCalledWith("[test] consult failed: boom");
    expect(deliver).toHaveBeenCalledWith("fallback");
    vi.useRealTimers();
  });

  it("cancels pending debounced work on close", async () => {
    vi.useFakeTimers();
    const consult = vi.fn(async () => ({ text: "answer" }));
    const queue = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: 100,
      isStopped: () => false,
      logger: makeLogger(),
      logPrefix: "[test]",
      responseStyle: "brief",
      fallbackText: "fallback",
      consult,
      deliver: vi.fn(),
    });

    queue.enqueue("question");
    queue.close();
    await vi.advanceTimersByTimeAsync(100);

    expect(consult).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("aborts the active consult on close without delivering fallback", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    let signal: AbortSignal | undefined;
    const consult = vi.fn(
      ({ signal: nextSignal }) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          signal = nextSignal;
          nextSignal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const deliver = vi.fn();
    const queue = createRealtimeVoiceAgentTalkbackQueue({
      debounceMs: 1,
      isStopped: () => false,
      logger,
      logPrefix: "[test]",
      responseStyle: "brief",
      fallbackText: "fallback",
      consult,
      deliver,
    });

    queue.enqueue("question");
    await vi.advanceTimersByTimeAsync(1);
    queue.close();
    await vi.runAllTimersAsync();

    expect(signal?.aborted).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
