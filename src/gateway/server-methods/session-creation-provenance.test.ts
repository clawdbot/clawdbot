import { describe, expect, it } from "vitest";
import { resolveAgentRunSessionCreation } from "./session-creation-provenance.js";

describe("agent run session creation provenance", () => {
  it("uses a proven Gateway profile id", () => {
    expect(
      resolveAgentRunSessionCreation({
        authenticatedUserProfile: { profileId: "profile-ada" },
      }),
    ).toEqual({ via: "run", actor: { type: "human", id: "profile-ada" } });
  });

  it("does not infer an actor for a profile-less wire client", () => {
    expect(resolveAgentRunSessionCreation({})).toEqual({ via: "run" });
  });
});
