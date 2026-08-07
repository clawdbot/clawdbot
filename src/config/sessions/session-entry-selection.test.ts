import { describe, expect, it } from "vitest";
import { inheritSessionSelection } from "./session-entry-selection.js";

describe("inheritSessionSelection", () => {
  it("inherits canonical user and automatic provenance without the old generation", () => {
    expect(
      inheritSessionSelection({
        sessionId: "legacy-user",
        updatedAt: 1,
        authProfileOverride: "openai:work",
      }),
    ).toMatchObject({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    });

    const automatic = inheritSessionSelection({
      sessionId: "legacy-auto",
      updatedAt: 1,
      authProfileOverride: "openai:fallback",
      authProfileOverrideCompactionCount: 0,
    });
    expect(automatic).toMatchObject({
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
    });
    expect(automatic.authProfileOverrideCompactionCount).toBeUndefined();
  });
});
