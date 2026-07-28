import { describe, expect, it } from "vitest";
import {
  formatUpdateAvailableVersion,
  resolveUpdatePrereleaseLabel,
} from "./update-overlay-helpers.ts";

describe("resolveUpdatePrereleaseLabel", () => {
  it("returns null for stable releases", () => {
    expect(resolveUpdatePrereleaseLabel("2026.7.2")).toBeNull();
  });

  it("returns null for numeric-only stable corrections", () => {
    expect(resolveUpdatePrereleaseLabel("2026.7.1-2")).toBeNull();
  });

  it("extracts the named prerelease identifier", () => {
    expect(resolveUpdatePrereleaseLabel("2026.7.2-beta.5")).toBe("beta");
    expect(resolveUpdatePrereleaseLabel("2026.7.2-alpha.1")).toBe("alpha");
    expect(resolveUpdatePrereleaseLabel("2.0.0-rc.3")).toBe("rc");
  });

  it("ignores build metadata", () => {
    expect(resolveUpdatePrereleaseLabel("2026.7.2+build.7")).toBeNull();
    expect(resolveUpdatePrereleaseLabel("2026.7.2-beta.5+build.7")).toBe("beta");
  });
});

describe("formatUpdateAvailableVersion", () => {
  it("renders a newer stable release without a label", () => {
    expect(
      formatUpdateAvailableVersion({
        latestVersion: "2026.7.2",
      }),
    ).toBe("v2026.7.2");
  });

  it("renders a stable correction without a prerelease label", () => {
    expect(
      formatUpdateAvailableVersion({
        latestVersion: "2026.7.1-2",
      }),
    ).toBe("v2026.7.1-2");
  });

  it("labels a newer beta prerelease with its full version", () => {
    expect(
      formatUpdateAvailableVersion({
        latestVersion: "2026.7.2-beta.5",
      }),
    ).toBe("v2026.7.2-beta.5 (beta)");
  });
});
