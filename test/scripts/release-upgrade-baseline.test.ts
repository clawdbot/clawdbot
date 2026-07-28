import { describe, expect, it } from "vitest";
import {
  compareOpenClawVersions,
  parseArgs,
  resolveDefaultReleaseUpgradeBaseline,
} from "../../scripts/lib/release-upgrade-baseline.mjs";

describe("release upgrade baseline resolver", () => {
  it("rejects short flag values before resolving baselines", () => {
    expect(() => parseArgs(["--candidate-version", "-h"])).toThrow(
      "missing value for --candidate-version",
    );
    expect(() => parseArgs(["--versions-json", "-h"])).toThrow("missing value for --versions-json");
  });

  it("prefers the newest published baseline older than the candidate across channels", () => {
    expect(
      resolveDefaultReleaseUpgradeBaseline("2026.6.2", [
        "2026.5.30",
        "2026.6.2",
        "2026.6.6",
        "2026.6.2-beta.1",
        "2026.6.1",
      ]),
    ).toBe("openclaw@2026.6.2-beta.1");
    expect(resolveDefaultReleaseUpgradeBaseline("2026.6.7", ["2026.6.6", "2026.6.7-beta.2"])).toBe(
      "openclaw@2026.6.7-beta.2",
    );
  });

  it("uses prerelease baselines only when no stable baseline can satisfy the candidate", () => {
    expect(
      resolveDefaultReleaseUpgradeBaseline("2026.6.2-beta.2", ["2026.6.2", "2026.6.2-beta.1"]),
    ).toBe("openclaw@2026.6.2-beta.1");
  });

  it("prefers older prerelease baselines over same-version stable baselines", () => {
    expect(resolveDefaultReleaseUpgradeBaseline("2026.6.2", ["2026.6.2", "2026.6.1-beta.1"])).toBe(
      "openclaw@2026.6.1-beta.1",
    );
  });

  it("treats numeric correction releases as stable baselines", () => {
    expect(resolveDefaultReleaseUpgradeBaseline("2026.5.3-1", ["2026.5.2", "2026.5.3"])).toBe(
      "openclaw@2026.5.3",
    );
    expect(
      resolveDefaultReleaseUpgradeBaseline("2026.5.3-2", ["2026.5.2", "2026.5.3", "2026.5.3-1"]),
    ).toBe("openclaw@2026.5.3-1");
  });

  it("falls back to the candidate version when no older baseline exists", () => {
    expect(resolveDefaultReleaseUpgradeBaseline("2026.6.2", ["2026.6.2", "2026.6.6"])).toBe(
      "openclaw@2026.6.2",
    );
  });

  it("does not pick a newer stable release for a prerelease candidate", () => {
    expect(
      resolveDefaultReleaseUpgradeBaseline("2026.6.7-beta.1", [
        "2026.6.6",
        "2026.6.7",
        "2026.6.7-beta.2",
      ]),
    ).toBe("openclaw@2026.6.6");
  });

  it("compares prerelease versions with semver ordering", () => {
    expect(compareOpenClawVersions("2026.6.7-beta.2", "2026.6.7-beta.10")).toBeLessThan(0);
    expect(compareOpenClawVersions("2026.6.7", "2026.6.7-beta.10")).toBeGreaterThan(0);
  });
});
