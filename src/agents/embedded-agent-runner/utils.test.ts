// Embedded runner utility tests cover small mapping helpers shared by run setup
// and provider option normalization.
import { describe, expect, it } from "vitest";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "./utils.js";

describe("mapThinkingLevel", () => {
  it("maps adaptive to the provider-owned high effort default", () => {
    expect(mapThinkingLevel("adaptive")).toBe("high");
  });

  it("maps logical Ultra to provider max effort", () => {
    expect(mapThinkingLevel("ultra")).toBe("max");
    expect(mapThinkingLevelForProvider("ultra")).toBe("max");
  });

  it("preserves provider-native adaptive outside agent-core", () => {
    expect(mapThinkingLevelForProvider("adaptive")).toBe("adaptive");
  });
});
