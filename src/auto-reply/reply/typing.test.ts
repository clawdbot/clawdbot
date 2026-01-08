import { afterEach, describe, expect, it, vi } from "vitest";

import { createTypingController } from "./typing.js";

describe("typing controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops after run completion and dispatcher idle", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);

    typing.markRunComplete();
    vi.advanceTimersByTime(1_000);
    expect(onReplyStart).toHaveBeenCalledTimes(4);

    typing.markDispatchIdle();
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(4);
  });

  it("keeps typing until both idle and run completion are set", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    typing.markDispatchIdle();
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);

    typing.markRunComplete();
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);
  });

  it("does not start typing after run completion", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    typing.markRunComplete();
    await typing.startTypingOnText("late text");
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("does not restart typing after it has stopped", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    typing.markRunComplete();
    typing.markDispatchIdle();

    vi.advanceTimersByTime(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    // Late callbacks should be ignored and must not restart the interval.
    await typing.startTypingOnText("late tool result");
    vi.advanceTimersByTime(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });
});
