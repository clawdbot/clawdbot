import { describe, expect, it } from "vitest";
import { opencodeGoMediaUnderstandingProvider } from "./media-understanding-provider.js";

describe("opencode-go media understanding provider", () => {
  it("declares image understanding support", () => {
    expect(opencodeGoMediaUnderstandingProvider.id).toBe("opencode-go");
    expect(opencodeGoMediaUnderstandingProvider.capabilities).toEqual(["image"]);
    expect(opencodeGoMediaUnderstandingProvider.defaultModels).toEqual({ image: "kimi-k2.6" });
    expect(typeof opencodeGoMediaUnderstandingProvider.describeImage).toBe("function");
    expect(typeof opencodeGoMediaUnderstandingProvider.describeImages).toBe("function");
  });
});
