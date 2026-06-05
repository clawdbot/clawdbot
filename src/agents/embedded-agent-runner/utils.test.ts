// Embedded runner utility tests cover small mapping helpers shared by run setup
// and provider option normalization.
import { describe, expect, it } from "vitest";
import { mapThinkingLevel } from "./utils.js";

describe("mapThinkingLevel", () => {
  it("maps adaptive to the provider-owned high effort default", () => {
    expect(mapThinkingLevel("adaptive")).toBe("high");
  });
});
