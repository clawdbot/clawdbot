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
        "apps\\ios\\CHANGELOG.md",
      ]),
    ).toEqual({
      staged: false,
      base: "origin/release",
      head: "HEAD",
      paths: ["package.json", "apps/ios/CHANGELOG.md"],
    });
  });

  it("rejects missing ref option values", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("Expected --base <ref>.");
    expect(() => parseArgs(["--base", "-h"])).toThrow("Expected --base <ref>.");
    expect(() => parseArgs(["--head"])).toThrow("Expected --head <ref>.");
    expect(() => parseArgs(["--head", "-h"])).toThrow("Expected --head <ref>.");
    expect(() => parseArgs(["--base", ""])).toThrow("Expected --base <ref>.");
  });

  it("rejects unknown options before treating args as paths", () => {
    expect(() => parseArgs(["--stgaed"])).toThrow("Unknown option: --stgaed");
  });

  it("preserves option-shaped paths after the separator", () => {
    expect(parseArgs(["--staged", "--", "--head"])).toEqual({
      staged: true,
      base: "origin/main",
      head: "HEAD",
      paths: ["--head"],
    });
  });
});
