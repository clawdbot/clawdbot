import { describe, expect, it, vi } from "vitest";
import { resolveCurrentDirectiveLevels } from "./directive-handling.levels.js";

describe("resolveCurrentDirectiveLevels", () => {
  it("prefers resolved model default over agent thinkingDefault", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("high");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {
        thinkingDefault: "low",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentThinkLevel).toBe("high");
    expect(resolveDefaultThinkingLevel).toHaveBeenCalledTimes(1);
  });

  it("keeps session thinking override without consulting defaults", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("high");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        thinkingLevel: "minimal",
      },
      agentCfg: {
        thinkingDefault: "low",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentThinkLevel).toBe("minimal");
    expect(resolveDefaultThinkingLevel).not.toHaveBeenCalled();
  });

  it("prefers session fastMode over agent default", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        fastMode: true,
      },
      agentEntry: {
        fastModeDefault: false,
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentFastMode).toBe(true);
  });

  it("falls back to agent fastModeDefault when session override is absent", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentEntry: {
        fastModeDefault: true,
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentFastMode).toBe(true);
  });

  it("prefers session reasoningLevel over agent default", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {
        reasoningLevel: "on",
      },
      agentEntry: {
        reasoningDefault: "off",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("on");
  });

  it("falls back to agent reasoningDefault when session override is absent", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("off");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentEntry: {
        reasoningDefault: "stream",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("stream");
  });

  it("falls back to agentCfg reasoningDefault when agent entry is absent", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("off");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {
        reasoningDefault: "stream",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("stream");
  });

  it("applies agent reasoningDefault even when thinking is active", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("high");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentEntry: {
        reasoningDefault: "stream",
      },
      resolveDefaultThinkingLevel,
    });

    // reasoningDefault should work independently of thinking level
    expect(result.currentThinkLevel).toBe("high");
    expect(result.currentReasoningLevel).toBe("stream");
  });

  it("defaults reasoning to off when no agent default is set", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("low");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentEntry: {},
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("off");
  });

  it("respects agent reasoningDefault: off as explicit override", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("off");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentEntry: {
        reasoningDefault: "off",
      },
      resolveDefaultThinkingLevel,
    });

    // Agent explicitly setting "off" should be respected, not overridden by model default
    expect(result.currentReasoningLevel).toBe("off");
  });

  it("respects agentCfg reasoningDefault: off as explicit override", async () => {
    const resolveDefaultThinkingLevel = vi.fn().mockResolvedValue("off");

    const result = await resolveCurrentDirectiveLevels({
      sessionEntry: {},
      agentCfg: {
        reasoningDefault: "off",
      },
      resolveDefaultThinkingLevel,
    });

    expect(result.currentReasoningLevel).toBe("off");
  });
});
