import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractChangelogSection,
  normalizeGatewayVersionToPinnedIosVersion,
  renderIosReleaseNotes,
  renderIosVersionXcconfig,
  resolveGatewayVersionForIosRelease,
  resolveIosVersion,
} from "../../scripts/lib/ios-version.ts";
import { installIosFixtureCleanup, writeIosFixture } from "./ios-version.test-support.ts";

installIosFixtureCleanup();

describe("resolveIosVersion", () => {
  it("parses pinned CalVer versions and derives Apple marketing fields", () => {
    const rootDir = writeIosFixture({
      version: "2026.4.6",
      changelog: "# OpenClaw iOS Changelog\n\n## 2026.4.6\n\nStable notes.\n",
    });

    expect(resolveIosVersion(rootDir)).toMatchObject({
      canonicalVersion: "2026.4.6",
      marketingVersion: "2026.4.6",
      buildVersion: "1",
    });
  });

  it("rejects semver-only versions", () => {
    const rootDir = writeIosFixture({
      version: "1.2.3",
      changelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\nNotes.\n",
    });

    expect(() => resolveIosVersion(rootDir)).toThrow("Expected pinned CalVer like 2026.4.6");
  });

  it("rejects prerelease suffixes in the pinned iOS version file", () => {
    const rootDir = writeIosFixture({
      version: "2026.4.6-beta.1",
      changelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\nNotes.\n",
    });

    expect(() => resolveIosVersion(rootDir)).toThrow("Expected pinned CalVer like 2026.4.6");
  });
});

describe("gateway version normalization", () => {
  it("keeps stable gateway CalVer values", () => {
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

  it("reads and normalizes the root package version for iOS releases", () => {
    const rootDir = writeIosFixture({
      version: "2026.4.6",
      packageVersion: "2026.4.7-beta.5",
      changelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\nNotes.\n",
    });

    expect(resolveGatewayVersionForIosRelease(rootDir)).toEqual({
      packageVersion: "2026.4.7-beta.5",
      pinnedIosVersion: "2026.4.7",
    });
  });
});

describe("renderIosVersionXcconfig", () => {
  it("renders checked-in defaults from the pinned iOS version", () => {
    const rootDir = writeIosFixture({
      version: "2026.4.8",
      changelog: "# OpenClaw iOS Changelog\n\n## 2026.4.8\n\nNotes.\n",
    });
    const version = resolveIosVersion(rootDir);

    expect(renderIosVersionXcconfig(version)).toContain("OPENCLAW_IOS_VERSION = 2026.4.8");
    expect(renderIosVersionXcconfig(version)).toContain("OPENCLAW_MARKETING_VERSION = 2026.4.8");
    expect(renderIosVersionXcconfig(version)).toContain("OPENCLAW_BUILD_VERSION = 1");
  });
});

describe("release note extraction", () => {
  it("extracts exact pinned version sections first", () => {
    const rootDir = writeIosFixture({
      version: "2026.4.6",
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
      version: "2026.4.6",
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
