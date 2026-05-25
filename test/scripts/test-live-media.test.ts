import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/test-live-media.ts";

describe("scripts/test-live-media", () => {
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
