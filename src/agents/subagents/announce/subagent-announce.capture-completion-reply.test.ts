// Completion-reply capture tests cover the short polling window used to collect
// final child output after an announce waits for the subagent.
import { describe, expect, it, vi } from "vitest";
import {
  captureSubagentCompletionReplyUsing,
  readLatestSubagentOutputWithRetryUsing,
} from "./subagent-announce-capture.js";

describe("captureSubagentCompletionReply", () => {
  it("returns immediate assistant output from history without polling", async () => {
    const readSubagentOutput = vi
      .fn<(sessionKey: string) => Promise<string | undefined>>()
      .mockResolvedValue("Immediate assistant completion");

    const result = await captureSubagentCompletionReplyUsing({
      sessionKey: "agent:main:subagent:child",
      maxWaitMs: 50,
      retryIntervalMs: 8,
      readSubagentOutput,
    });

    expect(result).toBe("Immediate assistant completion");
    expect(readSubagentOutput).toHaveBeenCalledTimes(1);
  });

  it("polls briefly and returns late tool output once available", async () => {
    vi.useFakeTimers();
    const readSubagentOutput = vi
      .fn<(sessionKey: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Late tool result completion");

    // Fake timers make the retry contract deterministic without waiting for the
    // wall-clock window used by live child sessions.
    const pending = captureSubagentCompletionReplyUsing({
      sessionKey: "agent:main:subagent:child",
      maxWaitMs: 50,
      retryIntervalMs: 8,
      readSubagentOutput,
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBe("Late tool result completion");
    expect(readSubagentOutput).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("captures the final assistant reply when it becomes available at the deadline", async () => {
    vi.useFakeTimers();
    try {
      const readSubagentOutput = vi
        .fn<(sessionKey: string) => Promise<string | undefined>>()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce("Requester-visible final result");

      const pending = captureSubagentCompletionReplyUsing({
        sessionKey: "agent:main:subagent:child",
        maxWaitMs: 5,
        retryIntervalMs: 5,
        readSubagentOutput,
      });
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toBe("Requester-visible final result");
      expect(readSubagentOutput).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("charges slow output reads against the bounded retry deadline", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = performance.now();
      const readSubagentOutput = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 15);
        });
        return undefined;
      });

      const pending = readLatestSubagentOutputWithRetryUsing({
        sessionKey: "agent:main:subagent:child",
        maxWaitMs: 25,
        retryIntervalMs: 10,
        readSubagentOutput,
      });
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toBeUndefined();
      expect(readSubagentOutput).toHaveBeenCalledTimes(2);
      expect(performance.now() - startedAt).toBe(40);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns undefined when no completion output arrives before retry window closes", async () => {
    vi.useFakeTimers();
    const readSubagentOutput = vi
      .fn<(sessionKey: string) => Promise<string | undefined>>()
      .mockResolvedValue(undefined);

    const pending = captureSubagentCompletionReplyUsing({
      sessionKey: "agent:main:subagent:child",
      maxWaitMs: 50,
      retryIntervalMs: 8,
      readSubagentOutput,
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toBeUndefined();
    expect(readSubagentOutput).toHaveBeenCalledTimes(9);
    vi.useRealTimers();
  });

  it.each([0, -5])("does not poll when the retry budget is %i ms", async (maxWaitMs) => {
    vi.useFakeTimers();
    try {
      const readSubagentOutput = vi.fn().mockResolvedValue(undefined);

      await expect(
        captureSubagentCompletionReplyUsing({
          sessionKey: "agent:main:subagent:child",
          maxWaitMs,
          retryIntervalMs: 5,
          readSubagentOutput,
        }),
      ).resolves.toBeUndefined();

      expect(readSubagentOutput).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll when waiting for a completion reply is disabled", async () => {
    vi.useFakeTimers();
    try {
      const readSubagentOutput = vi.fn().mockResolvedValue(undefined);

      await expect(
        captureSubagentCompletionReplyUsing({
          sessionKey: "agent:main:subagent:child",
          waitForReply: false,
          maxWaitMs: 25,
          retryIntervalMs: 5,
          readSubagentOutput,
        }),
      ).resolves.toBeUndefined();

      expect(readSubagentOutput).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns partial assistant progress when the latest assistant turn is tool-only", async () => {
    const readSubagentOutput = vi
      .fn<(sessionKey: string) => Promise<string | undefined>>()
      .mockResolvedValue("Mapped the modules.");

    const result = await captureSubagentCompletionReplyUsing({
      sessionKey: "agent:main:subagent:child",
      maxWaitMs: 50,
      retryIntervalMs: 8,
      readSubagentOutput,
    });

    expect(result).toBe("Mapped the modules.");
  });
});
