import { describe, expect, it } from "vitest";
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
      prePromptMessageCount: 4,
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

  it("routes obsolete truncate-only signals through compaction without changing history", () => {
    const outcome = handleEmbeddedAttemptMidTurnPrecheck({
      attempt,
      request: { ...request, route: "truncate_tool_results_only" },
      prePromptMessageCount: 4,
    });

    expect(outcome.preflightRecovery.route).toBe("compact_then_truncate");
    expect(outcome.promptError.message).toBe(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
  });

  it("records heuristic pressure without short-circuiting the provider attempt", async () => {
    const result = await prepareEmbeddedAttemptPromptPreflight({
      attempt,
      contextEngineAssemblySucceeded: false,
      contextEnginePromptAuthority: "assembled",
      contextTokenBudget: 100,
      hookMessagesForCurrentPrompt: [],
      includeBoundaryTimestamp: false,
      promptForPrecheck: "x".repeat(4_000),
      reserveTokens: 20,
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
    });

    expect(result.skipPromptSubmission).toBe(false);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(result.preflightRecovery).toBeUndefined();
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
      sessionMessageCount: 0,
      state,
      systemPrompt: "",
      toolResultMaxChars: 1_000,
    });

    expect(result).toEqual(state);
  });

  it("does not persist heuristic pre-prompt tool-result truncation", async () => {
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

    const result = await prepareEmbeddedAttemptPromptPreflight({
      attempt,
      contextEngineAssemblySucceeded: false,
      contextEnginePromptAuthority: "assembled",
      contextTokenBudget,
      hookMessagesForCurrentPrompt: messages,
      includeBoundaryTimestamp: true,
      promptForPrecheck: "hello",
      reserveTokens,
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
    });

    expect(result.skipPromptSubmission).toBe(false);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(result.preflightRecovery).toBeUndefined();
    expect(sessionManager.buildSessionContext().messages).toEqual([toolResult]);
  });
});
