import { describe, expect, it } from "vitest";
import {
  parseArgs,
  resolveDefaultReleaseUpgradeBaseline,
  resolveFrozenExtendedStableUpgradeBaseline,
} from "../../scripts/lib/release-upgrade-baseline.mjs";

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

  it("selects an older final release from the frozen extended-stable line", () => {
    expect(
      resolveFrozenExtendedStableUpgradeBaseline(
        "2026.6.35",
        ["2026.6.34", "2026.6.33", "2026.6.35", "2026.7.1", "2026.6.34-1"],
        {
          targetContextRef: "extended-stable/2026.6.33",
        },
      ),
    ).toBe("openclaw@2026.6.34");
  });

  it("honors an explicit published predecessor from the frozen extended-stable line", () => {
    expect(
      resolveFrozenExtendedStableUpgradeBaseline(
        "2026.6.35",
        ["2026.6.33", "2026.6.34", "2026.6.35"],
        {
          previousVersion: "2026.6.33",
          targetContextRef: "extended-stable/2026.6.33",
        },
      ),
    ).toBe("openclaw@2026.6.33");
  });

  it.each(["2026.6.35", "2026.6.34-1", "2026.7.1", "2026.6.32", "2026.6.31"])(
    "rejects an incompatible explicit frozen baseline %s",
    (previousVersion) => {
      expect(() =>
        resolveFrozenExtendedStableUpgradeBaseline(
          "2026.6.35",
          ["2026.6.33", "2026.6.34", "2026.6.35"],
          {
            previousVersion,
            targetContextRef: "extended-stable/2026.6.33",
          },
        ),
      ).toThrow("previous_version");
    },
  );

  it.each([
    ["2026.7.1", "extended-stable/2026.6.33"],
    ["2026.6.35-beta.1", "extended-stable/2026.6.33"],
    ["2026.6.33", "extended-stable/2026.6.33"],
    ["2026.6.35", "extended-stable/2026.6.34"],
  ])(
    "rejects incompatible frozen extended-stable targets",
    (candidateVersion, targetContextRef) => {
      expect(() =>
        resolveFrozenExtendedStableUpgradeBaseline(candidateVersion, ["2026.6.34", "2026.6.33"], {
          targetContextRef,
        }),
      ).toThrow();
    },
  );

  it("leaves non-extended-stable contexts on their latest baseline policy", () => {
    expect(
      resolveFrozenExtendedStableUpgradeBaseline("2026.6.35", ["2026.6.34"], {
        targetContextRef: "release/2026.6.35",
      }),
    ).toBeUndefined();
  });
});
