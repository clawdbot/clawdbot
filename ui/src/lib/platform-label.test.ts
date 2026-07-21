// @vitest-environment node
import { describe, expect, it } from "vitest";
import { prettifyPlatform } from "./platform-label.ts";

describe("prettifyPlatform", () => {
  it.each([
    ["darwin", "macOS"],
    ["iOS 26.4", "iOS 26.4"],
    ["freebsd", "Freebsd"],
    ["Haiku", "Haiku"],
    ["win32 11", "Windows 11"],
  ])("formats %s as %s", (platform, expected) => {
    expect(prettifyPlatform(platform)).toBe(expected);
  });
});
