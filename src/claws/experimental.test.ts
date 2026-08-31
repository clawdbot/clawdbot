import { describe, expect, it } from "vitest";
import { assertExperimentalClawsEnabled, isExperimentalClawsEnabled } from "./experimental.js";

describe("experimental Claws gate", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(isExperimentalClawsEnabled({})).toBe(false);
    expect(isExperimentalClawsEnabled({ OPENCLAW_EXPERIMENTAL_CLAWS: "0" })).toBe(false);
    expect(isExperimentalClawsEnabled({ OPENCLAW_EXPERIMENTAL_CLAWS: "false" })).toBe(false);
  });

  it("accepts explicit process opt-ins", () => {
    expect(isExperimentalClawsEnabled({ OPENCLAW_EXPERIMENTAL_CLAWS: "1" })).toBe(true);
    expect(isExperimentalClawsEnabled({ OPENCLAW_EXPERIMENTAL_CLAWS: "TRUE" })).toBe(true);
  });

  it("rejects direct handler access when disabled", () => {
    expect(() => assertExperimentalClawsEnabled({})).toThrow("OPENCLAW_EXPERIMENTAL_CLAWS=1");
  });
});
