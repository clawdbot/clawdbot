import { describe, expect, it } from "vitest";
import { opencodeGoMediaUnderstandingProvider } from "./media-understanding-provider.js";

describe("opencode-go media understanding provider", () => {
  it("declares image understanding support", () => {
    expect(opencodeGoMediaUnderstandingProvider).toEqual(
      expect.objectContaining({
        id: "opencode-go",
        capabilities: ["image"],
        defaultModels: { image: "kimi-k2.6" },
        describeImage: expect.any(Function),
        describeImages: expect.any(Function),
      }),
    );
  });
});
