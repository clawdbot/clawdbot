import { describe, expect, it } from "vitest";
import { normalizePluginIdScope } from "./plugin-scope.js";

describe("normalizePluginIdScope", () => {
  it("normalizes logical duplicates into a stable scope", () => {
    expect(normalizePluginIdScope([" beta ", "alpha", "beta", ""])).toEqual(["alpha", "beta"]);
  });

  it("ignores non-string scope values instead of throwing", () => {
    expect(
      normalizePluginIdScope(["alpha", null, 42, { id: "beta" }, " beta "] as unknown[]),
    ).toEqual(["alpha", "beta"]);
  });
});
