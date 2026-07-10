// Ios Version tests cover ios version script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractChangelogSection,
  normalizeGatewayVersionToPinnedIosVersion,
  normalizePinnedIosVersion,
  renderIosReleaseNotes,
  resolveGatewayVersionForIosRelease,
  resolveIosVersion,
} from "../../scripts/lib/ios-version.ts";
import { installIosFixtureCleanup, writeIosFixture } from "./ios-version.test-support.ts";

installIosFixtureCleanup();

describe("resolveIosVersion", () => {
  it("writes shared full commit and UTC timestamp settings for iOS builds", () => {
    const script = fs.readFileSync("scripts/ios-write-version-xcconfig.sh", "utf8");

    expect(script).toContain('source "${ROOT_DIR}/scripts/lib/build-metadata.sh"');
    expect(script).toContain("OPENCLAW_GIT_COMMIT = ${RESOLVED_GIT_COMMIT}");
    expect(script).toContain("OPENCLAW_BUILD_TIMESTAMP = ${RESOLVED_BUILD_TIMESTAMP}");
    expect(script).toContain('openclaw_resolve_git_commit "${ROOT_DIR}"');
    expect(script).toContain("openclaw_resolve_build_timestamp");
  });

  it("rejects missing CLI option values before reading version files", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/ios-version.ts", "--field"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Missing value for --field.\n");

    const shortFlagResult = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/ios-version.ts", "--field", "-h"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(shortFlagResult.status).toBe(1);
    expect(shortFlagResult.stderr).toBe("Missing value for --field.\n");
  });

  it("prints selected fields from the CLI", () => {
    const rootDir = writeIosFixture({
      packageVersion: "2026.4.6",
      changelog: "# OpenClaw iOS Changelog\n\n## 2026.4.6\n\nStable notes.\n",
    });
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/ios-version.ts",
        "--root",
        rootDir,
        "--field",
        "canonicalVersion",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2026.4.6\n");
    expect(result.stderr).toBe("");
  });

  it("prints explicit release version fields from the CLI", () => {
    const rootDir = writeIosFixture({
      packageVersion: "2026.4.6",
      changelog: "# OpenClaw iOS Changelog\n\n## 2026.4.7\n\nStable notes.\n",
    });
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/ios-version.ts",
        "--root",
        rootDir,
        "--version",
        "2026.4.7",
        "--field",
        "canonicalVersion",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2026.4.7\n");
    expect(result.stderr).toBe("");
  });

  it("prints derived release notes from the CLI", () => {
    const rootDir = writeIosFixture({
      packageVersion: "2026.4.6",
      changelog: "# OpenClaw iOS Changelog\n\n## 2026.4.7\n\nGenerated notes.\n",
    });
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/ios-version.ts",
        "--root",
        rootDir,
        "--version",
        "2026.4.7",
        "--field",
        "releaseNotes",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Generated notes.\n");
    expect(result.stderr).toBe("");
  });

  it("rejects missing iOS sync CLI root values before reading version files", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/ios-sync-versioning.ts", "--root", "--check"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Missing value for --root.\n");

    const shortFlagResult = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/ios-sync-versioning.ts", "--root", "-h"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(shortFlagResult.status).toBe(1);
    expect(shortFlagResult.stderr).toBe("Missing value for --root.\n");
  });

  it("derives Apple marketing fields from the root package release version", () => {
    const rootDir = writeIosFixture({
      packageVersion: "2026.4.6",
      changelog: "# OpenClaw iOS Changelog\n\n## 2026.4.6\n\nStable notes.\n",
    });

    expect(resolveIosVersion(rootDir)).toEqual({
      buildVersion: "1",
      canonicalVersion: "2026.4.6",
      changelogPath: path.join(rootDir, "apps/ios/CHANGELOG.md"),
      marketingVersion: "2026.4.6",
      versionSource: "package",
      versionSourcePath: path.join(rootDir, "package.json"),
    });
  });

  it("rejects semver-only package versions", () => {
    const rootDir = writeIosFixture({
      packageVersion: "1.2.3",
      changelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\nNotes.\n",
    });

    expect(() => resolveIosVersion(rootDir)).toThrow("Expected YYYY.M.PATCH");
  });

  it("rejects prerelease suffixes in explicit release versions", () => {
    const rootDir = writeIosFixture({
      packageVersion: "2026.4.6",
      changelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\nNotes.\n",
    });

    expect(() => resolveIosVersion(rootDir, { releaseVersion: "2026.4.6-beta.1" })).toThrow(
      "Expected release version like 2026.6.5",
    );
  });

  it("rejects impossible pinned release versions", () => {
    expect(() => normalizePinnedIosVersion("2026.13.6")).toThrow(
      "Expected release version like 2026.6.5",
    );
    expect(() => normalizePinnedIosVersion("2026.4.9007199254740993")).toThrow(
      "Expected release version like 2026.6.5",
    );
  });
});

describe("gateway version normalization", () => {
  it("keeps stable gateway release values", () => {
    expect(normalizeGatewayVersionToPinnedIosVersion("2026.4.6")).toBe("2026.4.6");
  });

  it("strips beta suffixes when pinning from gateway version", () => {
    expect(normalizeGatewayVersionToPinnedIosVersion("2026.4.6-beta.2")).toBe("2026.4.6");
  });

  it("strips alpha suffixes when pinning from gateway version", () => {
    expect(normalizeGatewayVersionToPinnedIosVersion("2026.4.6-alpha.2")).toBe("2026.4.6");
  });

  it("strips fallback correction suffixes when pinning from gateway version", () => {
    expect(normalizeGatewayVersionToPinnedIosVersion("2026.4.6-3")).toBe("2026.4.6");
  });

  it("rejects impossible gateway release versions", () => {
    expect(() => normalizeGatewayVersionToPinnedIosVersion("2026.13.6-alpha.1")).toThrow(
      "Expected YYYY.M.PATCH",
    );
    expect(() =>
      normalizeGatewayVersionToPinnedIosVersion("2026.4.6-alpha.9007199254740993"),
    ).toThrow("Expected YYYY.M.PATCH");
  });

  it("reads and normalizes the root package version for iOS releases", () => {
    const rootDir = writeIosFixture({
      packageVersion: "2026.4.7-beta.5",
      changelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\nNotes.\n",
    });

    expect(resolveGatewayVersionForIosRelease(rootDir)).toEqual({
      packageVersion: "2026.4.7-beta.5",
      pinnedIosVersion: "2026.4.7",
    });
  });
});

describe("release note extraction", () => {
  it("extracts exact pinned version sections first", () => {
    const rootDir = writeIosFixture({
      packageVersion: "2026.4.6",
      changelog: `# OpenClaw iOS Changelog

## Unreleased

Draft notes.

## 2026.4.6

- Exact release notes.
`,
    });
    const version = resolveIosVersion(rootDir);
    const changelog = fs.readFileSync(path.join(rootDir, "apps", "ios", "CHANGELOG.md"), "utf8");

    expect(renderIosReleaseNotes(version, changelog)).toBe("- Exact release notes.\n");
  });

  it("falls back to Unreleased when the release section does not exist yet", () => {
    const rootDir = writeIosFixture({
      packageVersion: "2026.4.6",
      changelog: `# OpenClaw iOS Changelog

## Unreleased

### Added

- New iOS feature.
`,
    });
    const version = resolveIosVersion(rootDir);
    const changelog = fs.readFileSync(path.join(rootDir, "apps", "ios", "CHANGELOG.md"), "utf8");

    expect(renderIosReleaseNotes(version, changelog)).toContain("### Added");
    expect(renderIosReleaseNotes(version, changelog)).toContain("- New iOS feature.");
  });

  it("extracts markdown bodies without the version heading", () => {
    expect(
      extractChangelogSection(
        `# OpenClaw iOS Changelog\n\n## 2026.4.6 - 2026-04-06\n\nLine one.\n\n## 2026.4.5\n`,
        "2026.4.6",
      ),
    ).toBe("Line one.");
  });
});
