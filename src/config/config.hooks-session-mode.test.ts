import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

describe("config hook session mode", () => {
  it.each(["isolated", "persistent"] as const)("accepts %s hook mappings", (sessionMode) => {
    const result = validateConfigObjectWithPlugins({
      hooks: {
        mappings: [
          {
            action: "agent",
            messageTemplate: "card update",
            sessionMode,
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects unknown hook mapping session modes", () => {
    const result = validateConfigObjectWithPlugins({
      hooks: {
        mappings: [
          {
            action: "agent",
            messageTemplate: "card update",
            sessionMode: "shared",
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain("hooks.mappings.0.sessionMode");
    }
  });
});
