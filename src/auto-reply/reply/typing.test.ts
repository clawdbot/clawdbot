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
});
