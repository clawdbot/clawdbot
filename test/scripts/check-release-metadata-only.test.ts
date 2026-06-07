import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-release-metadata-only.mjs";

describe("check-release-metadata-only", () => {
  it("parses refs and explicit paths", () => {
    expect(
      parseArgs([
        "--base",
        "origin/release",
        "--head",
        "HEAD",
        "./package.json",
        "apps\\ios\\version.json",
      ]),
    ).toEqual({
      staged: false,
      base: "origin/release",
      head: "HEAD",
      paths: ["package.json", "apps/ios/version.json"],
    });
  });

  it("rejects missing ref option values", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("Expected --base <ref>.");
    expect(() => parseArgs(["--head"])).toThrow("Expected --head <ref>.");
    expect(() => parseArgs(["--base", ""])).toThrow("Expected --base <ref>.");
  });
});
