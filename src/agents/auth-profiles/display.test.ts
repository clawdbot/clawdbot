import { describe, expect, it } from "vitest";
import { resolveAuthProfileDisplayLabel } from "./display.js";

describe("resolveAuthProfileDisplayLabel", () => {
  it("prefers displayName over email metadata", () => {
    const label = resolveAuthProfileDisplayLabel({
      cfg: {
        auth: {
          profiles: {
            "openai:id-abc": {
              provider: "openai",
              mode: "oauth",
              displayName: "Work account",
              email: "work@example.com",
            },
          },
        },
      },
      store: { version: 1, profiles: {} },
      profileId: "openai:id-abc",
    });

    expect(label).toBe("openai:id-abc (Work account)");
  });

  it("does not synthesize bogus labels when no human metadata exists", () => {
    const label = resolveAuthProfileDisplayLabel({
      store: {
        version: 1,
        profiles: {
          "openai:id-abc": {
            type: "oauth",
            provider: "openai",
            access: "token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      profileId: "openai:id-abc",
    });

    expect(label).toBe("openai:id-abc");
  });
});
