import { describe, expect, it, vi } from "vitest";
import { captureSubagentCompletionReplyUsing } from "./subagent-announce-capture.js";

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
    expect(readSubagentOutput).toHaveBeenCalledTimes(8);
    vi.useRealTimers();
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
