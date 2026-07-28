import { describe, expect, it } from "vitest";
import { formatUpdateAvailableVersion } from "./update-overlay-helpers.ts";

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

  it("labels alpha and rc prereleases with their identifiers", () => {
    expect(
      formatUpdateAvailableVersion({
        latestVersion: "2026.7.2-alpha.1",
      }),
    ).toBe("v2026.7.2-alpha.1 (alpha)");
    expect(
      formatUpdateAvailableVersion({
        latestVersion: "2.0.0-rc.3",
      }),
    ).toBe("v2.0.0-rc.3 (rc)");
  });

  it("ignores build metadata when labeling prereleases", () => {
    expect(
      formatUpdateAvailableVersion({
        latestVersion: "2026.7.2+build.7",
      }),
    ).toBe("v2026.7.2+build.7");
    expect(
      formatUpdateAvailableVersion({
        latestVersion: "2026.7.2-beta.5+build.7",
      }),
    ).toBe("v2026.7.2-beta.5+build.7 (beta)");
  });
});
