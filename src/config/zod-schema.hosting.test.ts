import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("hosting config schema", () => {
  it("accepts built-in hosting profiles", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profile: "container",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.hosting?.profile).toBe("container");
    }
  });

  it("rejects unknown hosting profiles", () => {
    const result = validateConfigObjectRaw({
      hosting: {
        profile: "custom-host",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("hosting.profile");
    }
  });
});
