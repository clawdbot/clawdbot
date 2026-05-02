import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("session parent fork config keys", () => {
  it("rejects legacy session.parentForkMaxTokens with doctor guidance", () => {
    const result = validateConfigObjectRaw({
      session: {
        parentForkMaxTokens: 200_000,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "session",
        message: expect.stringContaining("session.parentForkMaxTokens was removed"),
      }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('Run "openclaw doctor --fix"'),
      }),
    );
  });
});
