import { describe, expect, it, vi } from "vitest";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

describe("attempt transcript cleanup", () => {
  it("keeps live messages unchanged when the durable suffix fence rejects cleanup", () => {
    const user = { role: "user", content: "question" };
    const signal = new MidTurnPrecheckSignal({
      route: "compact_only",
      estimatedPromptTokens: 1,
      promptBudgetBeforeReserve: 1,
      overflowTokens: 1,
      toolResultReducibleChars: 0,
      effectiveReserveTokens: 0,
    });
    const precheckError = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: signal.message,
    };
    const messages = [user, precheckError];
    const fenceError = new Error("concurrent transcript append");
    const removeTrailingEntries = vi.fn(() => {
      throw fenceError;
    });
    const activeSession = { agent: { state: { messages } } };
    const getEntries = vi.fn(() => [{ type: "message", message: precheckError }]);

    expect(() =>
      removeTrailingMidTurnPrecheckAssistantError({
        activeSession: activeSession as never,
        sessionManager: { getEntries, removeTrailingEntries } as never,
      }),
    ).toThrow(fenceError);

    expect(activeSession.agent.state.messages).toBe(messages);
    expect(activeSession.agent.state.messages).toEqual([user, precheckError]);
  });
});
