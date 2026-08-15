// Verifies config version handling and future-version guards.
import { describe, expect, it } from "vitest";
import { compareOpenClawVersions, shouldWarnOnTouchedVersion } from "./version.js";

describe("compareOpenClawVersions", () => {
  it("treats correction publishes as newer than the base stable release", () => {
    expect(compareOpenClawVersions("2026.3.23", "2026.3.23-1")).toBe(-1);
    expect(compareOpenClawVersions("2026.3.23-1", "2026.3.23")).toBe(1);
    expect(compareOpenClawVersions("2026.3.23-2", "2026.3.23-1")).toBe(1);
  });

  it("preserves numeric correction and build-metadata edge cases", () => {
    expect(compareOpenClawVersions("2026.3.23", "2026.3.23-0")).toBe(-1);
    expect(compareOpenClawVersions("2026.3.23", "2026.3.23-1.2")).toBe(1);
    expect(compareOpenClawVersions("2026.3.23+first", "2026.3.23+second")).toBe(0);
    expect(compareOpenClawVersions("2026.3.23-1+first", "2026.3.23-1+second")).toBe(0);
  });

  it("treats stable as newer than beta and compares beta identifiers", () => {
    expect(compareOpenClawVersions("2026.6.5", "2026.6.6-beta.1")).toBe(-1);
    expect(compareOpenClawVersions("2026.3.23", "2026.3.23-beta.1")).toBe(1);
    expect(compareOpenClawVersions("2026.3.23-beta.2", "2026.3.23-beta.1")).toBe(1);
    expect(compareOpenClawVersions("2026.3.23.beta.1", "2026.3.23-beta.2")).toBe(-1);
  });
});

describe("shouldWarnOnTouchedVersion", () => {
  it("skips same-base stable families", () => {
    expect(shouldWarnOnTouchedVersion("2026.3.23", "2026.3.23-1")).toBe(false);
    expect(shouldWarnOnTouchedVersion("2026.3.23-1", "2026.3.23-2")).toBe(false);
  });

  it("skips same-base correction publishes even when current is a prerelease", () => {
    expect(shouldWarnOnTouchedVersion("2026.3.23-beta.1", "2026.3.23-1")).toBe(false);
  });

  it("skips same-base stable configs when current is a beta", () => {
    expect(shouldWarnOnTouchedVersion("2026.5.2-beta.3", "2026.5.2")).toBe(false);
  });

  it("skips same-base prerelease configs when current is newer", () => {
    expect(shouldWarnOnTouchedVersion("2026.3.23", "2026.3.23-beta.1")).toBe(false);
  });

  it("still warns when the touched prerelease is newer", () => {
    expect(shouldWarnOnTouchedVersion("2026.5.2-beta.2", "2026.5.2-beta.3")).toBe(true);
  });

  it("warns when the touched config is newer", () => {
    expect(shouldWarnOnTouchedVersion("2026.3.23", "2026.3.24")).toBe(true);
    expect(shouldWarnOnTouchedVersion("2026.3.23", "2027.1.1")).toBe(true);
  });
});
