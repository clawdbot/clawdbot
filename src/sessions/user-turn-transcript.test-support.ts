import type { UserTurnTranscriptTarget } from "./user-turn-transcript.types.js";

/** Creates a store-backed transcript target for tests that do not own runtime session setup. */
export function createTestUserTurnTranscriptTarget(
  overrides: Partial<UserTurnTranscriptTarget> = {},
): UserTurnTranscriptTarget {
  return {
    agentId: "main",
    sessionEntry: undefined,
    sessionId: "test-session",
    sessionKey: "agent:main:test",
    ...overrides,
  };
}
