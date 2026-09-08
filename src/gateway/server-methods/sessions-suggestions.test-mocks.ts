import { vi } from "vitest";
import type { PresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";

const mocks = vi.hoisted(() => ({
  handleChatSend: vi.fn(),
  suggestionMutationFailure: undefined as
    | "claim"
    | "release"
    | "release-unexpected"
    | "finalize"
    | undefined,
  presence: [] as Array<Pick<PresenceEntry, "user" | "watchedSessions">>,
}));

vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));
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
