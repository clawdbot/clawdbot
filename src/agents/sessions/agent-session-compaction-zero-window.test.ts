import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { AgentSessionCompaction } from "./agent-session-compaction.js";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";

// Test-only subclass to expose the protected checkCompaction method.
// AgentSessionCompaction is abstract; this concrete subclass lets the test
// call checkCompaction via a public wrapper without changing production code.
class TestableAgentSessionCompaction extends AgentSessionCompaction {
  public override async checkCompaction(
    assistantMessage: AssistantMessage,
    skipAbortedCheck = true,
  ): Promise<boolean> {
    return super.checkCompaction(assistantMessage, skipAbortedCheck);
  }
}

function createAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "response" }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 65_000,
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 66_000,
      contextUsage: {
        state: "available",
        promptTokens: 65_000,
        totalTokens: 66_000,
      },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  } as AssistantMessage;
}

describe("AgentSessionCompaction.checkCompaction — zero contextWindow guard (#86684)", () => {
  it("does not trigger auto-compaction when model contextWindow is missing (sessions_yield wake path)", async () => {
    const runAutoCompactionSpy = vi.fn().mockResolvedValue(false);
    const appendCompactionSpy = vi.fn();

    // Simulate the sessions_yield wake path: this.model is undefined, so
    // `this.model?.contextWindow ?? 0` evaluates to 0 (the regression scenario).
    const mockThis = {
      model: undefined,
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 20_000,
          keepRecentTokens: 0,
        }),
      },
      sessionManager: {
        getBranch: () => [],
        appendCompaction: appendCompactionSpy,
      },
      agent: { state: { messages: [] as AgentMessage[] } },
      contextOverflowRecoveryOwner: "caller",
      overflowRecoveryAttempted: false,
      emit: vi.fn(),
      getContextUsage: () => null,
      runAutoCompaction: runAutoCompactionSpy,
    };

    const assistantMessage = createAssistantMessage({
      // Recent timestamp so the "older than latest compaction" skip path does not fire.
      timestamp: Date.now(),
      usage: {
        input: 65_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 66_000,
        contextUsage: {
          state: "available",
          promptTokens: 65_000,
          totalTokens: 66_000,
        },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    const result = await TestableAgentSessionCompaction.prototype.checkCompaction.call(
      mockThis,
      assistantMessage,
      true,
    );

    // The session should not be compacted when contextWindow is 0.
    expect(result).toBe(false);
    // runAutoCompaction must not be called — no compaction entry should be created or persisted.
    expect(runAutoCompactionSpy).not.toHaveBeenCalled();
    // appendCompaction must not be called — no compaction entry is appended to the session branch.
    expect(appendCompactionSpy).not.toHaveBeenCalled();
  });

  it("still triggers auto-compaction when contextWindow is present and threshold is exceeded", async () => {
    const runAutoCompactionSpy = vi.fn().mockResolvedValue(true);
    const appendCompactionSpy = vi.fn();

    const mockThis = {
      model: { contextWindow: 100_000, provider: "test-provider", id: "test-model" },
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 20_000,
          keepRecentTokens: 0,
        }),
      },
      sessionManager: {
        getBranch: () => [],
        appendCompaction: appendCompactionSpy,
      },
      agent: { state: { messages: [] as AgentMessage[] } },
      contextOverflowRecoveryOwner: "caller",
      overflowRecoveryAttempted: false,
      emit: vi.fn(),
      getContextUsage: () => null,
      runAutoCompaction: runAutoCompactionSpy,
    };

    // 95k tokens / 100k window with 20k reserve → 95k > 80k → compaction triggers.
    const assistantMessage = createAssistantMessage({
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 95_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 96_000,
        contextUsage: {
          state: "available",
          promptTokens: 95_000,
          totalTokens: 96_000,
        },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    const result = await TestableAgentSessionCompaction.prototype.checkCompaction.call(
      mockThis,
      assistantMessage,
      true,
    );

    expect(result).toBe(true);
    expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
    expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
  });
});
