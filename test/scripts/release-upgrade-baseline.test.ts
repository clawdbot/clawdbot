import { describe, expect, it } from "vitest";
import {
  parseArgs,
  resolveDefaultReleaseUpgradeBaseline,
} from "../../scripts/lib/release-upgrade-baseline.mts";

describe("release upgrade baseline resolver", () => {
  it("rejects short flag values before resolving baselines", () => {
    expect(() => parseArgs(["--candidate-version", "-h"])).toThrow(
      "missing value for --candidate-version",
    );
    expect(() => parseArgs(["--versions-json", "-h"])).toThrow("missing value for --versions-json");
  });

  it.each([
    { candidate: "2026.8.1", expected: "2026.7.1-2" },
    { candidate: "2026.8.1-beta.2", expected: "2026.7.1-2" },
    { candidate: "2026.8.1-alpha.2", expected: "2026.7.1-2" },
    { candidate: "2026.7.1-2", expected: "2026.7.1-1" },
    { candidate: "2026.7.1-1", expected: "2026.7.1" },
    { candidate: "2026.7.1", expected: "2026.6.34" },
  ])("selects the stable predecessor of $candidate", ({ candidate, expected }) => {
    expect(
      resolveDefaultReleaseUpgradeBaseline(candidate, [
        "2026.8.1-beta.1",
        "2026.7.1-1",
        "2026.9.1",
        "2026.8.1-alpha.1",
        "2026.7.1-2",
        "2026.6.34",
        "2026.7.1",
        "2026.8.1",
        "2026.7.1-beta.2",
        "2026.7.1-2",
      ]),
    ).toBe(`openclaw@${expected}`);
  });

  it("uses the same stable version only when no older stable exists", () => {
    expect(
      resolveDefaultReleaseUpgradeBaseline("2026.7.1", ["2026.7.1-beta.2", "2026.7.1", "2026.8.1"]),
    ).toBe("openclaw@2026.7.1");
  });

  it.each([
    ["2026.8.1-beta.2", ["2026.8.1-beta.1", "2026.8.1"]],
    ["2026.7.1", ["2026.8.1", "invalid"]],
    ["2026.7.1", []],
  ])("rejects missing stable baselines for %s", (candidate, versions) => {
    expect(() => resolveDefaultReleaseUpgradeBaseline(candidate, versions)).toThrow(
      "no published stable OpenClaw baseline",
    );
  });
});
