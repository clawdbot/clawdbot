// Package update utility tests cover version ordering used by update reporting.
import { describe, expect, it } from "vitest";
import { comparePackageUpdateVersions, isPackageVersionDowngrade } from "./package-update-utils.js";

describe("comparePackageUpdateVersions", () => {
  it("orders OpenClaw release versions ahead of their prereleases", () => {
    expect(comparePackageUpdateVersions("2026.7.2-beta.5", "2026.7.1-1")).toBeGreaterThan(0);
    expect(comparePackageUpdateVersions("2026.7.1-1", "2026.7.2-beta.5")).toBeLessThan(0);
  });

  it("falls back to semver ordering for plain package versions", () => {
    expect(comparePackageUpdateVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(comparePackageUpdateVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("treats unparseable versions as equal instead of guessing a direction", () => {
    expect(comparePackageUpdateVersions("not-a-version", "1.2.3")).toBe(0);
  });
});

describe("isPackageVersionDowngrade", () => {
  it("detects an install that moved the version backwards", () => {
    expect(isPackageVersionDowngrade("2026.7.2-beta.5", "2026.7.1-1")).toBe(true);
    expect(isPackageVersionDowngrade("1.2.3", "1.2.2")).toBe(true);
  });

  it("does not flag forward or identical moves", () => {
    expect(isPackageVersionDowngrade("1.2.3", "1.2.4")).toBe(false);
    expect(isPackageVersionDowngrade("1.2.3", "1.2.3")).toBe(false);
  });

  it("does not flag a downgrade when either version is unknown", () => {
    expect(isPackageVersionDowngrade(undefined, "1.2.3")).toBe(false);
    expect(isPackageVersionDowngrade("1.2.3", undefined)).toBe(false);
  });

  it("does not flag a downgrade when a version cannot be parsed", () => {
    expect(isPackageVersionDowngrade("git-abcdef", "1.2.3")).toBe(false);
  });
});
