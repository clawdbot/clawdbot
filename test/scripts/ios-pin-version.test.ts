import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pinIosVersion, parseArgs } from "../../scripts/ios-pin-version.ts";
import { resolveIosVersion } from "../../scripts/lib/ios-version.ts";
import { installIosFixtureCleanup, writeIosFixture } from "./ios-version.test-support.ts";

installIosFixtureCleanup();

describe("parseArgs", () => {
  it("requires exactly one pin source", () => {
    expect(() => parseArgs([])).toThrow(
      "Choose exactly one of --from-gateway or --version <YYYY.M.D>",
    );
    expect(() => parseArgs(["--from-gateway", "--version", "2026.4.7"])).toThrow(
      "Choose exactly one of --from-gateway or --version <YYYY.M.D>",
    );
  });
});

describe("pinIosVersion", () => {
  it("pins an explicit iOS release version and syncs generated artifacts", () => {
    const rootDir = writeIosFixture({
      version: "2026.4.6",
      changelog: `# OpenClaw iOS Changelog

## Unreleased

- Draft release notes.
`,
      prefix: "openclaw-ios-pin-",
    });

    const result = pinIosVersion({
      explicitVersion: "2026.4.7",
      fromGateway: false,
      rootDir,
      sync: true,
    });

    expect(result.previousVersion).toBe("2026.4.6");
    expect(result.nextVersion).toBe("2026.4.7");
    expect(result.packageVersion).toBeNull();
    expect(resolveIosVersion(rootDir).canonicalVersion).toBe("2026.4.7");
    expect(fs.readFileSync(path.join(rootDir, "apps", "ios", "version.json"), "utf8")).toContain(
      '"version": "2026.4.7"',
    );
    expect(
      fs.readFileSync(path.join(rootDir, "apps", "ios", "Config", "Version.xcconfig"), "utf8"),
    ).toContain("OPENCLAW_MARKETING_VERSION = 2026.4.7");
    expect(
      fs.readFileSync(
        path.join(rootDir, "apps", "ios", "fastlane", "metadata", "en-US", "release_notes.txt"),
        "utf8",
      ),
    ).toContain("- Draft release notes.");
    expect(result.syncedPaths).toHaveLength(2);
  });

  it("pins from the current gateway version without carrying prerelease suffixes", () => {
    const rootDir = writeIosFixture({
      version: "2026.4.6",
      packageVersion: "2026.4.10-beta.3",
      changelog: `# OpenClaw iOS Changelog

## Unreleased

- Candidate release notes.
`,
      prefix: "openclaw-ios-pin-",
    });

    const result = pinIosVersion({
      explicitVersion: null,
      fromGateway: true,
      rootDir,
      sync: true,
    });

    expect(result.previousVersion).toBe("2026.4.6");
    expect(result.nextVersion).toBe("2026.4.10");
    expect(result.packageVersion).toBe("2026.4.10-beta.3");
    expect(resolveIosVersion(rootDir).marketingVersion).toBe("2026.4.10");
  });

  it("can skip syncing checked-in artifacts when requested", () => {
    const rootDir = writeIosFixture({
      version: "2026.4.6",
      changelog: `# OpenClaw iOS Changelog

## Unreleased

- Candidate release notes.
`,
      versionXcconfig: "stale\n",
      releaseNotes: "stale\n",
      prefix: "openclaw-ios-pin-",
    });

    const result = pinIosVersion({
      explicitVersion: "2026.4.8",
      fromGateway: false,
      rootDir,
      sync: false,
    });

    expect(result.syncedPaths).toHaveLength(0);
    expect(
      fs.readFileSync(path.join(rootDir, "apps", "ios", "Config", "Version.xcconfig"), "utf8"),
    ).toBe("stale\n");
  });
});
