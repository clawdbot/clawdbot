import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/test-live-media.ts";

describe("scripts/test-live-media", () => {
  it("rejects unknown global providers for the selected suites", () => {
    expect(() =>
      parseArgs(["image", "--providers", "definitely-not-a-provider", "--all-providers"]),
    ).toThrow("Unknown provider(s) for selected media suite(s): definitely-not-a-provider");
  });

  it("rejects unknown suite-specific providers", () => {
    expect(() => parseArgs(["image", "--image-providers", "runway", "--all-providers"])).toThrow(
      "Unknown image provider(s): runway",
    );
  });

  it("accepts providers supported by the wrapped live suites", () => {
    expect(
      parseArgs(["image", "--image-providers", "openrouter", "--all-providers"]).suiteProviders
        .image,
    ).toEqual(new Set(["openrouter"]));
    expect(
      parseArgs(["music", "--music-providers", "fal,openrouter", "--all-providers"]).suiteProviders
        .music,
    ).toEqual(new Set(["fal", "openrouter"]));
    expect(
      parseArgs(["video", "--video-providers", "openrouter", "--all-providers"]).suiteProviders
        .video,
    ).toEqual(new Set(["openrouter"]));
  });

  it("passes single-dash Vitest args after the option separator", () => {
    expect(
      parseArgs(["image", "--all-providers", "--project", "tooling", "--", "-t", "media-smoke"]),
    ).toMatchObject({
      suites: ["image"],
      requireAuth: false,
      passthroughArgs: ["--project", "tooling", "-t", "media-smoke"],
    });
  });
});
