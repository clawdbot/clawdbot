import { describe, expect, it } from "vitest";
import {
  extractStableChangelogSection,
  parseStableReleaseTag,
  verifyStableMainCloseout,
} from "../scripts/lib/stable-release-closeout.mjs";

const release = {
  tagName: "v2026.6.8",
  isDraft: false,
  isPrerelease: false,
  assets: [
    { name: "OpenClaw-2026.6.8.zip", digest: `sha256:${"a".repeat(64)}` },
    { name: "OpenClaw-2026.6.8.dmg", digest: `sha256:${"b".repeat(64)}` },
    { name: "OpenClaw-2026.6.8.dSYM.zip", digest: `sha256:${"c".repeat(64)}` },
  ],
};
const changelog =
  "# Changelog\n\n## 2026.6.8\n\n### Fixes\n\n- Shipped fix.\n\n## 2026.6.7\n\n- Old.\n";
const validCloseoutParams = {
  tag: "v2026.6.8",
  mainPackageJson: { version: "2026.6.8" },
  tagPackageJson: { version: "2026.6.8" },
  mainChangelog: changelog,
  tagChangelog: changelog,
  mainAppcast:
    "https://github.com/openclaw/openclaw/releases/download/v2026.6.8/OpenClaw-2026.6.8.zip\n",
  release,
  releaseTagSha: "tag-sha",
  mainSha: "main-sha",
  fullReleaseValidationRunId: "11",
  fullReleaseValidationRunAttempt: "2",
  releasePublishRunId: "12",
  rollbackDrillId: "rollback-drill-2026-q2",
  rollbackDrillDate: "2026-06-01",
};

describe("stable release closeout", () => {
  it("parses stable and correction tags", () => {
    expect(parseStableReleaseTag("v2026.6.8")).toBe("2026.6.8");
    expect(parseStableReleaseTag("v2026.6.8-2")).toBe("2026.6.8");
    expect(() => parseStableReleaseTag("v2026.6.8-0")).toThrow("expected a stable release tag");
    expect(() => parseStableReleaseTag("v2026.6.8-beta.1")).toThrow(
      "expected a stable release tag",
    );
  });

  it("extracts only the requested stable changelog section", () => {
    expect(extractStableChangelogSection(changelog, "2026.6.8")).toBe(
      "## 2026.6.8\n\n### Fixes\n\n- Shipped fix.",
    );
  });

  it("accepts an exact stable closeout with a current rollback drill", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({
      version: 2,
      releaseTag: "v2026.6.8",
      releaseVersion: "2026.6.8",
      fullReleaseValidationRunAttempt: "2",
      rollbackDrill: { id: "rollback-drill-2026-q2", date: "2026-06-01" },
    });
    expect(result.manifest).not.toHaveProperty("verifiedAt");
  });

  it("accepts closeout after main advances to a later stable CalVer", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      mainPackageJson: { version: "2026.7.1" },
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({
      releaseVersion: "2026.6.8",
      mainPackageVersion: "2026.7.1",
      releaseTagPackageVersion: "2026.6.8",
    });
  });

  it("requires an exact Full Release Validation run attempt", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      fullReleaseValidationRunAttempt: "",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toContain("full release validation run attempt is invalid: <missing>.");
    expect(result.manifest).toBeNull();
  });

  it("writes identical closeout evidence when replayed", () => {
    const first = verifyStableMainCloseout({
      ...validCloseoutParams,
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });
    const replay = verifyStableMainCloseout({
      ...validCloseoutParams,
      release: {
        ...release,
        assets: [
          ...release.assets,
          {
            name: "openclaw-2026.6.8-stable-main-closeout.json",
            digest: `sha256:${"d".repeat(64)}`,
          },
          {
            name: "openclaw-2026.6.8-stable-main-closeout.json.sha256",
            digest: `sha256:${"e".repeat(64)}`,
          },
        ],
      },
      nowMs: Date.parse("2026-06-18T00:00:00Z"),
    });

    expect(replay.manifest).toEqual(first.manifest);
  });

  it("replays an existing partial closeout using its recorded rollback drill", () => {
    const first = verifyStableMainCloseout({
      ...validCloseoutParams,
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });
    const replay = verifyStableMainCloseout({
      ...validCloseoutParams,
      allowStaleRollbackDrill: true,
      nowMs: Date.parse("2026-10-01T00:00:00Z"),
    });

    expect(replay.errors).toEqual([]);
    expect(replay.manifest).toEqual(first.manifest);
  });

  it("requires the canonical macOS zip, dmg, and dSYM assets", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      release: {
        ...release,
        assets: [{ name: "openclaw-2026.6.8-dependency-evidence.zip" }],
      },
      mainAppcast:
        "https://github.com/openclaw/openclaw/releases/download/v2026.6.8/openclaw-2026.6.8-dependency-evidence.zip\n",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toContain(
      "GitHub release v2026.6.8 is missing required macOS asset(s): OpenClaw-2026.6.8.zip, OpenClaw-2026.6.8.dmg, OpenClaw-2026.6.8.dSYM.zip.",
    );
  });

  it("uses exact correction versions for correction-release state and assets", () => {
    const correctionRelease = {
      ...release,
      tagName: "v2026.6.8-2",
      assets: release.assets.map((asset) => ({
        ...asset,
        name: asset.name.replaceAll("2026.6.8", "2026.6.8-2"),
      })),
    };
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      tag: "v2026.6.8-2",
      mainPackageJson: { version: "2026.6.8-2" },
      tagPackageJson: { version: "2026.6.8-2" },
      mainChangelog: changelog.replaceAll("2026.6.8", "2026.6.8-2"),
      tagChangelog: changelog.replaceAll("2026.6.8", "2026.6.8-2"),
      release: correctionRelease,
      mainAppcast:
        "https://github.com/openclaw/openclaw/releases/download/v2026.6.8-2/OpenClaw-2026.6.8-2.zip\n",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({
      releaseVersion: "2026.6.8-2",
      mainPackageVersion: "2026.6.8-2",
      releaseTagPackageVersion: "2026.6.8-2",
    });
  });

  it("allows a fallback correction tag for an existing base stable package", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      tag: "v2026.6.8-2",
      mainPackageJson: { version: "2026.6.9" },
      release: {
        ...release,
        tagName: "v2026.6.8-2",
      },
      mainAppcast:
        "https://github.com/openclaw/openclaw/releases/download/v2026.6.8-2/OpenClaw-2026.6.8.zip\n",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({
      releaseVersion: "2026.6.8",
      mainPackageVersion: "2026.6.9",
      releaseTagPackageVersion: "2026.6.8",
    });
  });

  it("requires complete platform assets for failed-publish recovery", () => {
    const missing = verifyStableMainCloseout({
      ...validCloseoutParams,
      requireCompletePlatformAssets: true,
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(missing.errors).toContain(
      "GitHub release v2026.6.8 Android asset names do not match the recovery contract: expected OpenClaw-Android-SHA256SUMS.txt, OpenClaw-Android.apk; got <none>.",
    );
    expect(missing.errors).toContain(
      "GitHub release v2026.6.8 Windows asset names do not match the recovery contract: expected OpenClawCompanion-SHA256SUMS.txt, OpenClawCompanion-Setup-arm64.exe, OpenClawCompanion-Setup-x64.exe; got <none>.",
    );
    expect(missing.errors).toContain(
      "GitHub release v2026.6.8 Android recovery asset(s) lack GitHub SHA-256 digests: OpenClaw-Android-SHA256SUMS.txt, OpenClaw-Android.apk.",
    );
    expect(missing.errors).toContain(
      "failed-publish recovery is missing the exact candidate-approved Windows installer digests.",
    );
    expect(missing.errors).toContain(
      "failed-publish recovery is missing a trusted Windows Node Release run id.",
    );

    const complete = verifyStableMainCloseout({
      ...validCloseoutParams,
      requireCompletePlatformAssets: true,
      windowsNodeReleaseRunId: "42",
      windowsNodeInstallerDigests: {
        "OpenClawCompanion-Setup-arm64.exe": `sha256:${"1".repeat(64)}`,
        "OpenClawCompanion-Setup-x64.exe": `sha256:${"2".repeat(64)}`,
      },
      release: {
        ...release,
        assets: [
          ...release.assets,
          { name: "OpenClaw-Android-SHA256SUMS.txt", digest: `sha256:${"d".repeat(64)}` },
          { name: "OpenClaw-Android.apk", digest: `sha256:${"e".repeat(64)}` },
          {
            name: "OpenClawCompanion-SHA256SUMS.txt",
            digest: `sha256:${"f".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-arm64.exe",
            digest: `sha256:${"1".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"2".repeat(64)}`,
          },
        ],
      },
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(complete.errors).toEqual([]);
    expect(complete.manifest).toMatchObject({
      releasePublishRecovery: {
        completePlatformAssetsRequired: true,
        windowsNodeReleaseRunId: "42",
        windowsNodeInstallerDigests: {
          "OpenClawCompanion-Setup-arm64.exe": `sha256:${"1".repeat(64)}`,
          "OpenClawCompanion-Setup-x64.exe": `sha256:${"2".repeat(64)}`,
        },
      },
    });
  });

  it("rejects calendar-normalized rollback drill dates", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      rollbackDrillDate: "2026-02-31",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toContain("rollback drill date is invalid: 2026-02-31.");
  });

  it("rejects older main state, appcast drift, and stale rollback drills", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      mainPackageJson: { version: "2026.6.7" },
      mainChangelog: changelog.replace("Shipped fix.", "Different fix."),
      mainAppcast: "https://example.test/old.zip\n",
      rollbackDrillId: "rollback-drill-2026-q1",
      rollbackDrillDate: "2026-03-01",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toContain(
      "main package.json version is 2026.6.7, expected shipped version 2026.6.8 or a later stable OpenClaw CalVer.",
    );
    expect(result.errors).toContain(
      "main CHANGELOG.md ## 2026.6.8 does not exactly match the shipped release section.",
    );
    expect(result.errors).toContain(
      "main appcast.xml does not point at OpenClaw-2026.6.8.zip from v2026.6.8.",
    );
    expect(result.errors).toContain(
      "rollback drill is older than 90 days: 2026-03-01. Run the private rollback drill before stable closeout.",
    );
  });

  it("rejects prerelease main state", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      mainPackageJson: { version: "2026.6.9-beta.1" },
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toContain(
      "main package.json version is 2026.6.9-beta.1, expected shipped version 2026.6.8 or a later stable OpenClaw CalVer.",
    );
  });
});
