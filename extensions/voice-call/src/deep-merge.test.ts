import { describe, expect, it } from "vitest";
import { deepMergeDefined } from "./deep-merge.js";

describe("deepMergeDefined", () => {
  it("deep merges nested plain objects and preserves base values for undefined overrides", () => {
    expect(
      deepMergeDefined(
        {
          provider: { voice: "alloy", language: "en" },
          enabled: true,
        },
        {
          provider: { voice: "echo", language: undefined },
          enabled: undefined,
        },
      ),
    ).toEqual({
      provider: { voice: "echo", language: "en" },
      enabled: true,
    });
  });

  it("replaces non-objects directly and blocks dangerous prototype keys", () => {
    expect(deepMergeDefined(["a"], ["b"])).toEqual(["b"]);
    expect(deepMergeDefined("base", undefined)).toBe("base");
    expect(
      deepMergeDefined(
        { safe: { keep: true } },
        {
          safe: { next: true },
          __proto__: { polluted: true },
          constructor: { polluted: true },
          prototype: { polluted: true },
        },
      ),
    ).toEqual({
      safe: { keep: true, next: true },
    });
  });
});
