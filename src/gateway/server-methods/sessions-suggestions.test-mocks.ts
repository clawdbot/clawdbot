import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendSessionAudit: vi.fn(async () => undefined),
  handleChatSend: vi.fn(),
  suggestionMutationFailure: undefined as
    | "claim"
    | "release"
    | "release-unexpected"
    | "finalize"
    | undefined,
  presence: [] as Array<{ user?: { id: string; name?: string }; watchedSessions?: string[] }>,
}));

vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));
vi.mock("./session-audit.js", () => ({ appendSessionAudit: mocks.appendSessionAudit }));
vi.mock("../../infra/system-presence.js", () => ({
  listSystemPresence: () => mocks.presence,
}));
vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  const failIfRequested = (phase: "claim" | "release" | "finalize") => {
    if (mocks.suggestionMutationFailure === phase) {
      throw new actual.SessionWorkStartInvalidatedError("session changed in test");
    }
  };
  return {
    ...actual,
    claimSessionSuggestionDispatch: (
      ...args: Parameters<typeof actual.claimSessionSuggestionDispatch>
    ) => {
      failIfRequested("claim");
      return actual.claimSessionSuggestionDispatch(...args);
    },
    finalizeSessionSuggestionClaim: (
      ...args: Parameters<typeof actual.finalizeSessionSuggestionClaim>
    ) => {
      failIfRequested("finalize");
      return actual.finalizeSessionSuggestionClaim(...args);
    },
    releaseSessionSuggestionDispatch: (
      ...args: Parameters<typeof actual.releaseSessionSuggestionDispatch>
    ) => {
      failIfRequested("release");
      if (mocks.suggestionMutationFailure === "release-unexpected") {
        throw new Error("release storage failed");
      }
      return actual.releaseSessionSuggestionDispatch(...args);
    },
  };
});

export function getSessionSuggestionTestMocks() {
  return mocks;
}
