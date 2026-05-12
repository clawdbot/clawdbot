import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("session parent fork config keys", () => {
  it("rejects legacy session.parentForkMaxTokens as an unknown session key", () => {
    const result = validateConfigObjectRaw({
      session: {
        parentForkMaxTokens: 200_000,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const issue = result.issues.find(
      (candidate) =>
        candidate.path === "session" &&
        candidate.message.includes('Unrecognized key: "parentForkMaxTokens"'),
    );
    if (!issue) {
      throw new Error("Expected legacy session.parentForkMaxTokens validation issue");
    }
  });
});
