import { describe, expect, it } from "vitest";
import {
  classifyReleaseTrain,
  collectReleaseVersionFloorErrors,
  compareReleaseVersions,
  parsePinnedReleaseVersion,
  parseReleaseVersion,
} from "../scripts/lib/release-version.mjs";

describe("release version policy", () => {
  it.each([
    ["2026.7.2-alpha.1", "alpha"],
    ["2026.7.2-beta.1", "beta"],
    ["2026.7.32", "stable"],
    ["2026.6.33", "extended-stable"],
    ["2026.6.34", "extended-stable"],
    ["2026.6.33-1", "unsupported-extended-stable-correction"],
  ] as const)("classifies %s as %s", (version, expected) => {
    const parsed = parseReleaseVersion(version);
    if (!parsed) {
      throw new Error(`test version did not parse: ${version}`);
    }
    expect(classifyReleaseTrain(parsed)).toBe(expected);
  });

  it("blocks June 2026 stable and beta release trains below the published beta floor", () => {
    expect(collectReleaseVersionFloorErrors("2026.6.4")).toEqual([
      'June 2026 stable and beta release trains must use patch 5 or higher because 2026.6.5-beta.1 is already published; found "2026.6.4".',
    ]);
    expect(collectReleaseVersionFloorErrors("2026.6.4-beta.1")).toEqual([
      'June 2026 stable and beta release trains must use patch 5 or higher because 2026.6.5-beta.1 is already published; found "2026.6.4-beta.1".',
    ]);
  });

  it("keeps alpha compatibility and patch-floor release trains valid during the transition", () => {
    expect(collectReleaseVersionFloorErrors("2026.6.4-alpha.1")).toEqual([]);
    expect(collectReleaseVersionFloorErrors("2026.6.5-beta.2")).toEqual([]);
    expect(collectReleaseVersionFloorErrors("2026.7.1")).toEqual([]);
  });

  it("orders prereleases, finals, and corrections", () => {
    expect(compareReleaseVersions("2026.3.29-alpha.2", "2026.3.29-beta.1")).toBe(-1);
    expect(compareReleaseVersions("2026.3.29-beta.1", "2026.3.29")).toBe(-1);
    expect(compareReleaseVersions("2026.3.29-2", "2026.3.29")).toBe(1);
  });

  it.each([
    ["2026.1.1", "2026.1.1"],
    [" 2026.12.33 ", "2026.12.33"],
    ["9999.12.9007199254740991", "9999.12.9007199254740991"],
  ])("accepts stable release pin %j", (version, expected) => {
    expect(parsePinnedReleaseVersion(version)).toBe(expected);
  });

  it.each([
    "v2026.8.1",
    "V2026.8.1",
    "2026.8.1-alpha.1",
    "2026.8.1-beta.1",
    "2026.8.1-1",
    "2026.8.1+build.1",
    "latest",
    "^2026.8.1",
    "2026.8.x",
    "https://example.com/2026.8.1",
    "workspace:*",
    "file:../package",
    "git+https://example.com/repo.git",
    "2026. 8.1",
    "2026.08.1",
    "2026.8.01",
    "2026.13.1",
    "2026.8.9007199254740992",
  ])("rejects non-pin release form %j", (version) => {
    expect(parsePinnedReleaseVersion(version)).toBeNull();
  });
});
