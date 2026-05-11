import { describe, expect, it, vi } from "vitest";
import { createRealtimeVoiceAgentTalkbackQueue } from "./agent-talkback-runtime.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function expectConsultRequest(
  call: unknown,
  expected: { metadata: unknown; question: string; responseStyle: string },
) {
  if (!call || typeof call !== "object") {
    throw new Error("Expected talkback consult request object");
  }
  const { signal, ...request } = call as { signal?: unknown };
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(request).toStrictEqual(expected);
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

    expectConsultRequest(consult.mock.calls[0]?.[0], {
      metadata: undefined,
      question: "first\nsecond",
      responseStyle: "brief",
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

    expectConsultRequest(consult.mock.calls[0]?.[0], {
      metadata: undefined,
      question: "first",
      responseStyle: "brief",
    });
    expectConsultRequest(consult.mock.calls[1]?.[0], {
      metadata: undefined,
      question: "ignored\nsecond",
      responseStyle: "brief",
    });
    expect(deliver).toHaveBeenCalledWith("first-answer");
    expect(deliver).toHaveBeenCalledWith("second-answer");
    vi.useRealTimers();
  });

  it("keeps active pending questions split by metadata", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const ownerMetadata = { senderIsOwner: true };
    const guestMetadata = { senderIsOwner: false };
    let finishFirst: ((value: { text: string }) => void) | undefined;
    const consult = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ text: string }>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ text: "owner-answer" })
      .mockResolvedValueOnce({ text: "guest-answer" });
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
    queue.enqueue("owner", ownerMetadata);
    queue.enqueue("guest", guestMetadata);
    await vi.advanceTimersByTimeAsync(10);
    finishFirst?.({ text: "first-answer" });
    await vi.runAllTimersAsync();

    expectConsultRequest(consult.mock.calls[1]?.[0], {
      metadata: ownerMetadata,
      question: "owner",
      responseStyle: "brief",
    });
    expectConsultRequest(consult.mock.calls[2]?.[0], {
      metadata: guestMetadata,
      question: "guest",
      responseStyle: "brief",
    });
    expect(deliver).toHaveBeenCalledWith("owner-answer");
    expect(deliver).toHaveBeenCalledWith("guest-answer");
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

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("[test] consult failed: elapsedMs=0 boom");
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

    if (!signal) {
      throw new Error("Expected talkback consult abort signal");
    }
    expect(signal.aborted).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
