// Regression coverage for the Feishu reply-session-init-conflict retry path (#108320).
import { describe, expect, it, vi } from "vitest";
import { isFeishuReplySessionInitConflictError, runFeishuInboundWithConflictRetry } from "./bot.js";

const CONFLICT_MESSAGE =
  "reply session initialization conflicted for agent:main:feishu:dm:ou_sender_1";

describe("isFeishuReplySessionInitConflictError", () => {
  it("matches a direct conflict string", () => {
    expect(isFeishuReplySessionInitConflictError(CONFLICT_MESSAGE)).toBe(true);
  });

  it("matches an Error whose message is the conflict", () => {
    expect(isFeishuReplySessionInitConflictError(new Error(CONFLICT_MESSAGE))).toBe(true);
  });

  it("matches through an error cause chain", () => {
    const wrapper = new Error("feishu: failed to dispatch message");
    (wrapper as Error & { cause?: unknown }).cause = new Error(CONFLICT_MESSAGE);
    expect(isFeishuReplySessionInitConflictError(wrapper)).toBe(true);
  });

  it("matches through AggregateError.errors", () => {
    const aggregate = new AggregateError([new Error(CONFLICT_MESSAGE)], "broadcast failed");
    expect(isFeishuReplySessionInitConflictError(aggregate)).toBe(true);
  });

  it("returns false for unrelated errors and empty values", () => {
    expect(isFeishuReplySessionInitConflictError(new Error("network timeout"))).toBe(false);
    expect(isFeishuReplySessionInitConflictError(undefined)).toBe(false);
    expect(isFeishuReplySessionInitConflictError(null)).toBe(false);
  });
});

describe("runFeishuInboundWithConflictRetry", () => {
  it("returns the result when the first attempt succeeds without retry", async () => {
    const run = vi.fn(async () => "ok");
    await expect(runFeishuInboundWithConflictRetry(run)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries on conflict and succeeds once the conflict clears", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const run = vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new Error(CONFLICT_MESSAGE);
        return "ok";
      });
      const pending = runFeishuInboundWithConflictRetry(run);
      const assertion = expect(pending).resolves.toBe("ok");
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws immediately without retrying on a non-conflict error", async () => {
    const run = vi.fn(async () => {
      throw new Error("network timeout");
    });
    await expect(runFeishuInboundWithConflictRetry(run)).rejects.toThrow("network timeout");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("exhausts the bounded retries and rethrows the conflict on persistent failure", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => {
        throw new Error(CONFLICT_MESSAGE);
      });
      const pending = runFeishuInboundWithConflictRetry(run);
      // Attach the rejection handler before advancing fake timers so the
      // rejection raised during the timer flush is not reported as unhandled.
      const assertion = expect(pending).rejects.toThrow(CONFLICT_MESSAGE);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      // 1 initial attempt + 3 retries (1s/2s/4s backoff), matching Signal's schedule.
      expect(run).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
