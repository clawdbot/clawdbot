import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/index.js";
import {
  handleEmbeddedAttemptMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight,
} from "./attempt-prompt-preflight.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  estimateLlmBoundaryTokenPressure,
} from "./preemptive-compaction.js";

const attempt = {
  provider: "test-provider",
  modelId: "test-model",
  sessionFile: "/tmp/openclaw-attempt-preflight-test.jsonl",
  sessionId: "session-1",
  sessionKey: "agent:test:main",
};

const request = {
  route: "compact_only" as const,
  estimatedPromptTokens: 150,
  promptBudgetBeforeReserve: 100,
  overflowTokens: 50,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 20,
};

function makeToolResultMessage(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  } as AgentMessage;
}

function createSessionManagerWithMessage(message: AgentMessage): SessionManager {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
  return sessionManager;
}

describe("attempt prompt preflight", () => {
  it("routes a mid-turn compaction request with its measured budget", () => {
    const outcome = handleEmbeddedAttemptMidTurnPrecheck({
      attempt,
      request,
      sessionAgentId: "test",
      sessionManager: SessionManager.inMemory(),
      prePromptMessageCount: 4,
      replaceSessionMessages: vi.fn(),
    });

    expect(outcome).toEqual({
      preflightRecovery: {
        route: "compact_only",
        source: "mid-turn",
        estimatedPromptTokens: 150,
        promptBudgetBeforeReserve: 100,
        overflowTokens: 50,
      },
      promptError: expect.objectContaining({ message: PREEMPTIVE_OVERFLOW_ERROR_TEXT }),
    });
  });

  it("falls back to compaction when mid-turn tool-result truncation cannot help", () => {
    const outcome = handleEmbeddedAttemptMidTurnPrecheck({
      attempt,
      request: { ...request, route: "truncate_tool_results_only" },
      sessionAgentId: "test",
      sessionManager: SessionManager.inMemory(),
      prePromptMessageCount: 4,
      replaceSessionMessages: vi.fn(),
    });

    expect(outcome.preflightRecovery.route).toBe("compact_only");
    expect(outcome.promptError?.message).toBe(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
  });

  it("handles successful mid-turn tool-result truncation without a prompt error", () => {
    const sessionManager = createSessionManagerWithMessage(
      makeToolResultMessage("large tool output ".repeat(5_000)),
    );
    const replaceSessionMessages = vi.fn();
    const outcome = handleEmbeddedAttemptMidTurnPrecheck({
      attempt: { ...attempt, contextTokenBudget: 100 },
      request: { ...request, route: "truncate_tool_results_only" },
      sessionAgentId: "test",
      sessionManager,
      prePromptMessageCount: 4,
      replaceSessionMessages,
    });

    expect(outcome.promptError).toBeUndefined();
    expect(outcome.preflightRecovery).toEqual(
      expect.objectContaining({
        route: "truncate_tool_results_only",
        source: "mid-turn",
        handled: true,
        truncatedCount: 1,
      }),
    );
    expect(replaceSessionMessages).toHaveBeenCalledWith(
      sessionManager.buildSessionContext().messages,
    );
  });

  it("short-circuits an oversized prompt into precheck recovery", async () => {
    const result = await prepareEmbeddedAttemptPromptPreflight({
      attempt,
      contextEngineAssemblySucceeded: false,
      contextEnginePromptAuthority: "assembled",
      contextTokenBudget: 100,
      hookMessagesForCurrentPrompt: [],
      includeBoundaryTimestamp: false,
      promptForPrecheck: "x".repeat(4_000),
      reserveTokens: 20,
      sessionAgentId: "test",
      sessionManager: SessionManager.inMemory(),
      sessionMessageCount: 0,
      state: {
        contextBudgetStatus: undefined,
        preflightRecovery: undefined,
        promptError: null,
        promptErrorSource: null,
        skipPromptSubmission: false,
      },
      systemPrompt: "",
      toolResultMaxChars: 1_000,
      withOwnedSessionWriteLock: async (operation) => await operation(),
    });

    expect(result.skipPromptSubmission).toBe(true);
    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery?.route).toBe("compact_only");
    expect(result.contextBudgetStatus?.shouldCompact).toBe(true);
    expect(result.contextBudgetStatus?.overflowTokens).toBeGreaterThan(0);
  });

  it("defers overflow admission to a context engine that owns compaction", async () => {
    const state: Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0]["state"] = {
      contextBudgetStatus: undefined,
      preflightRecovery: undefined,
      promptError: null,
      promptErrorSource: null,
      skipPromptSubmission: false,
    };
    const result = await prepareEmbeddedAttemptPromptPreflight({
      attempt,
      activeContextEngine: {
        info: { id: "owner", name: "Owner", ownsCompaction: true },
      },
      contextEngineAssemblySucceeded: true,
      contextEnginePromptAuthority: "assembled",
      contextTokenBudget: 100,
      hookMessagesForCurrentPrompt: [],
      includeBoundaryTimestamp: false,
      promptForPrecheck: "x".repeat(4_000),
      reserveTokens: 20,
      sessionAgentId: "test",
      sessionManager: SessionManager.inMemory(),
      sessionMessageCount: 0,
      state,
      systemPrompt: "",
      toolResultMaxChars: 1_000,
      withOwnedSessionWriteLock: async (operation) => await operation(),
    });

    expect(result).toEqual(state);
  });

  it("runs successful pre-prompt truncation under the owned write lock", async () => {
    const toolResult = makeToolResultMessage("alpha beta gamma delta epsilon ".repeat(2_200));
    const messages = [toolResult];
    const reserveTokens = 2_000;
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const contextTokenBudget = estimatedPromptTokens - 200 + reserveTokens;
    const sessionManager = createSessionManagerWithMessage(toolResult);
    let lockCalls = 0;
    const withOwnedSessionWriteLock = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      lockCalls += 1;
      return await operation();
    };

    const result = await prepareEmbeddedAttemptPromptPreflight({
      attempt,
      contextEngineAssemblySucceeded: false,
      contextEnginePromptAuthority: "assembled",
      contextTokenBudget,
      hookMessagesForCurrentPrompt: messages,
      includeBoundaryTimestamp: true,
      promptForPrecheck: "hello",
      reserveTokens,
      sessionAgentId: "test",
      sessionManager,
      sessionMessageCount: messages.length,
      state: {
        contextBudgetStatus: undefined,
        preflightRecovery: undefined,
        promptError: null,
        promptErrorSource: null,
        skipPromptSubmission: false,
      },
      systemPrompt: "sys",
      toolResultMaxChars: 1_000,
      withOwnedSessionWriteLock,
    });

    expect(lockCalls).toBe(1);
    expect(result.skipPromptSubmission).toBe(true);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(result.preflightRecovery).toEqual(
      expect.objectContaining({
        route: "truncate_tool_results_only",
        handled: true,
        truncatedCount: 1,
      }),
    );
  });
});
