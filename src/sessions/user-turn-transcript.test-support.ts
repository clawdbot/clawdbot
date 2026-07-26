import "./user-turn-transcript.js";
import type {
  PersistUserTurnTranscriptParams,
  UserTurnTranscriptPersistResult,
  UserTurnTranscriptTarget,
} from "./user-turn-transcript.types.js";

type UserTurnTranscriptTestApi = {
  persistUserTurnTranscript(
    params: PersistUserTurnTranscriptParams,
  ): Promise<UserTurnTranscriptPersistResult | undefined>;
};

function getTestApi(): UserTurnTranscriptTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.userTurnTranscriptTestApi")
  ] as UserTurnTranscriptTestApi;
}

export async function persistUserTurnTranscript(
  params: PersistUserTurnTranscriptParams,
): Promise<UserTurnTranscriptPersistResult | undefined> {
  return await getTestApi().persistUserTurnTranscript(params);
}

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
