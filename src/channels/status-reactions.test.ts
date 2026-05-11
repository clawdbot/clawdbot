import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveToolEmoji,
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  CODING_TOOL_TOKENS,
  WEB_TOOL_TOKENS,
  type StatusReactionAdapter,
} from "./status-reactions.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock Adapter
// ─────────────────────────────────────────────────────────────────────────────

const createMockAdapter = () => {
  const calls: { method: string; emoji: string }[] = [];
  return {
    adapter: {
      setReaction: vi.fn(async (emoji: string) => {
        calls.push({ method: "set", emoji });
      }),
      removeReaction: vi.fn(async (emoji: string) => {
        calls.push({ method: "remove", emoji });
      }),
    } as StatusReactionAdapter,
    calls,
  };
};

const createEnabledController = (
  overrides: Partial<Parameters<typeof createStatusReactionController>[0]> = {},
) => {
  const { adapter, calls } = createMockAdapter();
  const controller = createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: "👀",
    ...overrides,
  });
  return { adapter, calls, controller };
};

const createSetOnlyController = () => {
  const calls: { method: string; emoji: string }[] = [];
  const adapter: StatusReactionAdapter = {
    setReaction: vi.fn(async (emoji: string) => {
      calls.push({ method: "set", emoji });
    }),
  };
  const controller = createStatusReactionController({
    enabled: true,
    adapter,
    initialEmoji: "👀",
  });
  return { calls, controller };
};

function expectSetEmojiCall(calls: Array<{ method: string; emoji: string }>, emoji: string) {
  expect(calls).toContainEqual({ method: "set", emoji });
}

function collectEmojisForMethod(
  calls: Array<{ method: string; emoji: string }>,
  method: string,
): string[] {
  const emojis: string[] = [];
  for (const call of calls) {
    if (call.method === method) {
      emojis.push(call.emoji);
    }
  }
  return emojis;
}

function countCallsForMethod(calls: Array<{ method: string; emoji: string }>, method: string) {
  let count = 0;
  for (const call of calls) {
    if (call.method === method) {
      count += 1;
    }
  }
  return count;
}

function countCallsForEmoji(calls: Array<{ method: string; emoji: string }>, emoji: string) {
  let count = 0;
  for (const call of calls) {
    if (call.emoji === emoji) {
      count += 1;
    }
  }
  return count;
}

function countCallsForMethodAndEmoji(
  calls: Array<{ method: string; emoji: string }>,
  method: string,
  emoji: string,
) {
  let count = 0;
  for (const call of calls) {
    if (call.method === method && call.emoji === emoji) {
      count += 1;
    }
  }
  return count;
}

function expectArrayContainsAll(values: readonly string[], expected: readonly string[]) {
  expected.forEach((value) => {
    expect(values).toContain(value);
  });
}

function expectObjectHasKeys(value: Record<string, unknown>, keys: readonly string[]) {
  keys.forEach((key) => {
    expect(value).toHaveProperty(key);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveToolEmoji", () => {
  it.each([
    { name: "returns display emoji for exec tool", tool: "exec", expected: "🛠️" },
    {
      name: "returns display emoji for process tool",
      tool: "process",
      expected: "🧰",
    },
    {
      name: "returns display emoji for web_search tool",
      tool: "web_search",
      expected: "🔎",
    },
    { name: "returns display emoji for browser tool", tool: "browser", expected: "🌐" },
    { name: "returns display emoji for message tool", tool: "message", expected: "✉️" },
    {
      name: "returns tool emoji for unknown tool",
      tool: "unknown_tool",
      expected: DEFAULT_EMOJIS.tool,
    },
    { name: "returns tool emoji for empty string", tool: "", expected: DEFAULT_EMOJIS.tool },
    { name: "returns tool emoji for undefined", tool: undefined, expected: DEFAULT_EMOJIS.tool },
    { name: "is case-insensitive", tool: "EXEC", expected: "🛠️" },
    {
      name: "matches tokens within tool names",
      tool: "my_exec_wrapper",
      expected: DEFAULT_EMOJIS.coding,
    },
  ] satisfies Array<{ name: string; tool: string | undefined; expected: string }>)(
    "should $name",
    ({ tool, expected }) => {
      expect(resolveToolEmoji(tool, DEFAULT_EMOJIS)).toBe(expected);
    },
  );

  it("preserves explicit status emoji overrides before exact tool display emojis", () => {
    const emojis = {
      ...DEFAULT_EMOJIS,
      coding: "🧪",
      web: "🛰️",
      tool: "🔧",
    };
    const overrides = {
      coding: "🧪",
      web: "🛰️",
      tool: "🔧",
    };

    expect(resolveToolEmoji("exec", emojis, overrides)).toBe("🧪");
    expect(resolveToolEmoji("web_search", emojis, overrides)).toBe("🛰️");
    expect(resolveToolEmoji("message", emojis, overrides)).toBe("🔧");
  });
});

describe("createStatusReactionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should not call adapter when disabled", async () => {
    const { adapter, calls } = createMockAdapter();
    const controller = createStatusReactionController({
      enabled: false,
      adapter,
      initialEmoji: "👀",
    });

    void controller.setQueued();
    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toHaveLength(0);
  });

  it("should call setReaction with initialEmoji for setQueued immediately", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setQueued();
    await vi.runAllTimersAsync();

    expectSetEmojiCall(calls, "👀");
  });

  it("should debounce setThinking and eventually call adapter", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();

    // Before debounce period
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(0);

    // After debounce period
    await vi.advanceTimersByTimeAsync(300);
    expectSetEmojiCall(calls, DEFAULT_EMOJIS.thinking);
  });

  it("should debounce setCompacting and eventually call adapter", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setCompacting();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    expectSetEmojiCall(calls, DEFAULT_EMOJIS.compacting);
  });

  it("should classify tool name and debounce", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    expectSetEmojiCall(calls, "🛠️");
  });

  const immediateTerminalCases = [
    {
      name: "setDone",
      run: (controller: ReturnType<typeof createStatusReactionController>) => controller.setDone(),
      expected: DEFAULT_EMOJIS.done,
    },
    {
      name: "setError",
      run: (controller: ReturnType<typeof createStatusReactionController>) => controller.setError(),
      expected: DEFAULT_EMOJIS.error,
    },
  ] as const;

  it.each(immediateTerminalCases)(
    "should execute $name immediately without debounce",
    async ({ run, expected }) => {
      const { calls, controller } = createEnabledController();

      await run(controller);
      await vi.runAllTimersAsync();

      expectSetEmojiCall(calls, expected);
    },
  );

  const terminalIgnoreCases = [
    {
      name: "ignore setThinking after setDone (terminal state)",
      terminal: (controller: ReturnType<typeof createStatusReactionController>) =>
        controller.setDone(),
      followup: (controller: ReturnType<typeof createStatusReactionController>) => {
        void controller.setThinking();
      },
    },
    {
      name: "ignore setTool after setError (terminal state)",
      terminal: (controller: ReturnType<typeof createStatusReactionController>) =>
        controller.setError(),
      followup: (controller: ReturnType<typeof createStatusReactionController>) => {
        void controller.setTool("exec");
      },
    },
  ] as const;

  it.each(terminalIgnoreCases)("should $name", async ({ terminal, followup }) => {
    const { calls, controller } = createEnabledController();

    await terminal(controller);
    const callsAfterTerminal = calls.length;
    followup(controller);
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls.length).toBe(callsAfterTerminal);
  });

  it("should only fire last state when rapidly changing (debounce)", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(100);

    void controller.setTool("web_search");
    await vi.advanceTimersByTimeAsync(100);

    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should only have the last one (exec → display emoji)
    const setEmojis = collectEmojisForMethod(calls, "set");
    expect(setEmojis).toEqual(["🛠️"]);
  });

  it("should deduplicate same emoji calls", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    const callsAfterFirst = calls.length;

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should not add another call
    expect(calls.length).toBe(callsAfterFirst);
  });

  it("should cancel a pending compacting emoji before resuming thinking", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setCompacting();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs - 1);
    controller.cancelPending();
    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    const setEmojis = collectEmojisForMethod(calls, "set");
    expect(setEmojis).toEqual([DEFAULT_EMOJIS.thinking]);
  });

  it("should defer removing previous emojis until clear", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setQueued();
    await vi.runAllTimersAsync();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    expectSetEmojiCall(calls, DEFAULT_EMOJIS.thinking);
    expect(calls).not.toContainEqual({ method: "remove", emoji: "👀" });

    await controller.clear();
    expect(calls).toContainEqual({ method: "remove", emoji: "👀" });
    expect(calls).toContainEqual({ method: "remove", emoji: DEFAULT_EMOJIS.thinking });
  });

  it("should remove tracked non-terminal emojis when setting done", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setQueued();
    await vi.runAllTimersAsync();
    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
    void controller.setTool("exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    await controller.setDone();

    const removeEmojis = collectEmojisForMethod(calls, "remove");
    expect(removeEmojis).toEqual([
      "👀",
      DEFAULT_EMOJIS.stallSoft,
      DEFAULT_EMOJIS.stallHard,
      DEFAULT_EMOJIS.thinking,
      "🛠️",
    ]);
  });

  it("should not remove reactions on terminal state when adapter lacks removeReaction", async () => {
    const { calls, controller } = createSetOnlyController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    await controller.setDone();

    expect(calls).toEqual([
      { method: "set", emoji: DEFAULT_EMOJIS.thinking },
      { method: "set", emoji: DEFAULT_EMOJIS.done },
    ]);
  });

  it("should not re-add an already active reaction when returning to it", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
    void controller.setTool("web_search");
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    expect(countCallsForMethodAndEmoji(calls, "set", DEFAULT_EMOJIS.thinking)).toBe(1);
    expect(calls).not.toContainEqual({ method: "remove", emoji: DEFAULT_EMOJIS.thinking });
  });

  it("should only call setReaction when adapter lacks removeReaction", async () => {
    const { calls, controller } = createSetOnlyController();

    void controller.setQueued();
    await vi.runAllTimersAsync();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    // Should only have set calls, no remove
    expect(countCallsForMethod(calls, "remove")).toBe(0);
    expect(calls.some((c) => c.method === "set")).toBe(true);
  });

  it("should clear all known emojis when adapter supports removeReaction", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setQueued();
    await vi.runAllTimersAsync();

    await controller.clear();

    // Should have removed multiple emojis
    expect(countCallsForMethod(calls, "remove")).toBeGreaterThan(0);
  });

  it("should handle clear gracefully when adapter lacks removeReaction", async () => {
    const { calls, controller } = createSetOnlyController();

    await controller.clear();

    // Should not throw, no remove calls
    expect(countCallsForMethod(calls, "remove")).toBe(0);
  });

  it("should restore initial emoji", async () => {
    const { calls, controller } = createEnabledController();

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    await controller.restoreInitial();

    expectSetEmojiCall(calls, "👀");
  });

  it("should use custom emojis when provided", async () => {
    const { calls, controller } = createEnabledController({
      emojis: {
        thinking: "🤔",
        done: "🎉",
      },
    });

    void controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);

    expectSetEmojiCall(calls, "🤔");

    await controller.setDone();
    await vi.runAllTimersAsync();
    expectSetEmojiCall(calls, "🎉");
  });

  it("should use custom timing when provided", async () => {
    const { calls, controller } = createEnabledController({
      timing: {
        debounceMs: 100,
      },
    });

    void controller.setThinking();

    // Should not fire at 50ms
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(0);

    // Should fire at 100ms
    await vi.advanceTimersByTimeAsync(60);
    expectSetEmojiCall(calls, DEFAULT_EMOJIS.thinking);
  });

  const stallCases = [
    {
      name: "soft stall timer after stallSoftMs",
      delayMs: DEFAULT_TIMING.stallSoftMs,
      expected: DEFAULT_EMOJIS.stallSoft,
    },
    {
      name: "hard stall timer after stallHardMs",
      delayMs: DEFAULT_TIMING.stallHardMs,
      expected: DEFAULT_EMOJIS.stallHard,
    },
  ] as const;

  const createControllerAfterThinking = async () => {
    const state = createEnabledController();
    void state.controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
    return state;
  };

  it.each(stallCases)("should trigger $name", async ({ delayMs, expected }) => {
    const { calls } = await createControllerAfterThinking();
    await vi.advanceTimersByTimeAsync(delayMs);

    expectSetEmojiCall(calls, expected);
  });

  const stallResetCases = [
    {
      name: "phase change",
      runUpdate: (controller: ReturnType<typeof createStatusReactionController>) => {
        void controller.setTool("exec");
        return vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      },
    },
    {
      name: "repeated same-phase updates",
      runUpdate: (controller: ReturnType<typeof createStatusReactionController>) => {
        void controller.setThinking();
        return Promise.resolve();
      },
    },
  ] as const;

  it.each(stallResetCases)("should reset stall timers on $name", async ({ runUpdate }) => {
    const { calls, controller } = await createControllerAfterThinking();

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);
    await runUpdate(controller);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallSoftMs / 2);

    expect(countCallsForEmoji(calls, DEFAULT_EMOJIS.stallSoft)).toBe(0);
  });

  it("should call onError callback when adapter throws", async () => {
    const onError = vi.fn();
    const adapter: StatusReactionAdapter = {
      setReaction: vi.fn(async () => {
        throw new Error("Network error");
      }),
    };

    const controller = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "👀",
      onError,
    });

    void controller.setQueued();
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalled();
  });
});

describe("constants", () => {
  it("should export CODING_TOOL_TOKENS", () => {
    expectArrayContainsAll(CODING_TOOL_TOKENS, ["exec", "read", "write"]);
  });

  it("should export WEB_TOOL_TOKENS", () => {
    expectArrayContainsAll(WEB_TOOL_TOKENS, ["web_search", "browser"]);
  });

  it("should export DEFAULT_EMOJIS with all required keys", () => {
    expectObjectHasKeys(DEFAULT_EMOJIS, [
      "queued",
      "thinking",
      "compacting",
      "tool",
      "coding",
      "web",
      "done",
      "error",
      "stallSoft",
      "stallHard",
    ]);
  });

  it("should export DEFAULT_TIMING with all required keys", () => {
    expectObjectHasKeys(DEFAULT_TIMING, [
      "debounceMs",
      "stallSoftMs",
      "stallHardMs",
      "doneHoldMs",
      "errorHoldMs",
    ]);
  });
});
