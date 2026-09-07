import type { SessionContextBudgetStatus } from "./types.js";

export function contextBudgetStatusFixture(
  overrides: Partial<SessionContextBudgetStatus> = {},
): SessionContextBudgetStatus {
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: 2,
    provider: "ollama",
    model: "qwen3:8b",
    sessionId: "session-1",
    route: "fits",
    shouldCompact: false,
    estimatedPromptTokens: 160_000,
    contextTokenBudget: 200_000,
    promptBudgetBeforeReserve: 180_000,
    reserveTokens: 20_000,
    effectiveReserveTokens: 20_000,
    remainingPromptBudgetTokens: 20_000,
    overflowTokens: 0,
    toolResultReducibleChars: 0,
    messageCount: 2,
    unwindowedMessageCount: 2,
    ...overrides,
  };
}
