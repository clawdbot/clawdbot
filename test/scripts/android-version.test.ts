// Android Version tests cover android version script behavior.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalAndroidVersionCode,
  extractChangelogSection,
  normalizeGatewayVersionToPinnedAndroidVersion,
  normalizePinnedAndroidVersion,
  renderAndroidReleaseNotes,
  renderAndroidVersionProperties,
  resolveAndroidVersion,
  resolveGatewayVersionForAndroidRelease,
  syncAndroidVersioning,
} from "../../scripts/lib/android-version.ts";
import {
  installAndroidFixtureCleanup,
  writeAndroidFixture,
} from "./android-version.test-support.ts";

installAndroidFixtureCleanup();

describe("resolveAndroidVersion", () => {
  it("rejects missing CLI option values before reading version files", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-version.ts", "--field"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Missing value for --field.\n");

    const shortFlagResult = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-version.ts", "--field", "-h"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(shortFlagResult.status).toBe(1);
    expect(shortFlagResult.stderr).toBe("Missing value for --field.\n");
  });

  it("prints selected fields from the CLI", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
    });
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/android-version.ts",
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
    expect(result.stdout).toBe("2026.6.2\n");
    expect(result.stderr).toBe("");
  });

  it("rejects missing Android sync CLI root values before reading version files", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-sync-versioning.ts", "--root", "--check"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Missing value for --root.\n");

    const shortFlagResult = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-sync-versioning.ts", "--root", "-h"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(shortFlagResult.status).toBe(1);
    expect(shortFlagResult.stderr).toBe("Missing value for --root.\n");
  });

  it("parses pinned release versions and Android version codes", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
    });

    expect(resolveAndroidVersion(rootDir)).toEqual({
      canonicalVersion: "2026.6.2",
      changelogPath: path.join(rootDir, "apps/android/CHANGELOG.md"),
      releaseNotesPath: path.join(
        rootDir,
        "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
      ),
      versionCode: 2026060201,
      versionFilePath: path.join(rootDir, "apps/android/version.json"),
      versionPropertiesPath: path.join(rootDir, "apps/android/Config/Version.properties"),
    });
  });

  it("rejects semver-only versions", () => {
    const rootDir = writeAndroidFixture({
      version: "1.2.3",
      versionCode: 2026060201,
    });

    expect(() => resolveAndroidVersion(rootDir)).toThrow(
      "Expected pinned release version like 2026.6.5",
    );
  });

  it("rejects prerelease suffixes in the pinned Android version file", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2-beta.1",
      versionCode: 2026060201,
    });

    expect(() => resolveAndroidVersion(rootDir)).toThrow(
      "Expected pinned release version like 2026.6.5",
    );
  });

  it("rejects impossible pinned release versions", () => {
    expect(() => normalizePinnedAndroidVersion("2026.13.2")).toThrow(
      "Expected pinned release version like 2026.6.5",
    );
    expect(() => normalizePinnedAndroidVersion("2026.6.9007199254740993")).toThrow(
      "Expected pinned release version like 2026.6.5",
    );
  });

  it("rejects version codes that do not match the pinned version date", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060301,
    });

    expect(() => resolveAndroidVersion(rootDir)).toThrow(
      "Expected 2026060201 through 2026060299 for version 2026.6.2",
    );
  });
});

describe("gateway version normalization", () => {
  it("keeps stable gateway release values", () => {
    expect(normalizeGatewayVersionToPinnedAndroidVersion("2026.6.2")).toBe("2026.6.2");
  });

  it("strips prerelease suffixes when pinning from gateway version", () => {
    expect(normalizeGatewayVersionToPinnedAndroidVersion("2026.6.2-beta.3")).toBe("2026.6.2");
    expect(normalizeGatewayVersionToPinnedAndroidVersion("2026.6.2-alpha.1")).toBe("2026.6.2");
  });

  it("derives the default Play-compatible versionCode from the pinned version", () => {
    expect(canonicalAndroidVersionCode("2026.6.2")).toBe(2026060201);
  });

  it("rejects pinned versions that cannot derive Play-compatible version codes", () => {
    expect(() => canonicalAndroidVersionCode("2026.6.100")).toThrow(
      "Unable to derive Android versionCode from 2026.6.100",
    );
  });

  it("rejects impossible gateway release versions", () => {
    expect(() => normalizeGatewayVersionToPinnedAndroidVersion("2026.13.2-beta.1")).toThrow(
      "Expected YYYY.M.PATCH",
    );
    expect(() =>
      normalizeGatewayVersionToPinnedAndroidVersion("2026.6.2-beta.9007199254740993"),
    ).toThrow("Expected YYYY.M.PATCH");
  });

  it("reads and normalizes the root package version for Android releases", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      packageVersion: "2026.6.5-beta.3",
    });

    expect(resolveGatewayVersionForAndroidRelease(rootDir)).toEqual({
      packageVersion: "2026.6.5-beta.3",
      pinnedAndroidVersion: "2026.6.5",
      versionCode: 2026060501,
    });
  });
});

describe("renderAndroidVersionProperties", () => {
  it("renders checked-in defaults from the pinned Android version", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
    });
    const version = resolveAndroidVersion(rootDir);

    expect(renderAndroidVersionProperties(version)).toContain(
      "OPENCLAW_ANDROID_VERSION_NAME=2026.6.2",
    );
    expect(renderAndroidVersionProperties(version)).toContain(
      "OPENCLAW_ANDROID_VERSION_CODE=2026060201",
    );
  });
});

describe("renderAndroidReleaseNotes", () => {
  it("extracts exact pinned-version notes before Unreleased notes", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      changelog: [
        "# OpenClaw Android Changelog",
        "",
        "## Unreleased",
        "",
        "Future Android changes.",
        "",
        "## 2026.6.2 - 2026-06-02",
        "",
        "Pinned Android release notes.",
        "",
      ].join("\n"),
    });
    const version = resolveAndroidVersion(rootDir);

    expect(
      renderAndroidReleaseNotes(
        version,
        "# OpenClaw Android Changelog\n\n## Unreleased\n\nFuture Android changes.\n\n## 2026.6.2 - 2026-06-02\n\nPinned Android release notes.\n",
      ),
    ).toBe("Pinned Android release notes.\n");
  });

  it("falls back to Unreleased notes while iterating on a release train", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
    });
    const version = resolveAndroidVersion(rootDir);

    expect(
      renderAndroidReleaseNotes(
        version,
        "# OpenClaw Android Changelog\n\n## Unreleased\n\nPending Android notes.\n",
      ),
    ).toBe("Pending Android notes.\n");
  });

  it("rejects changelogs without exact-version or Unreleased notes", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
    });
    const version = resolveAndroidVersion(rootDir);

    expect(() =>
      renderAndroidReleaseNotes(
        version,
        "# OpenClaw Android Changelog\n\n## 2026.6.1\n\nOld notes.\n",
      ),
    ).toThrow("Unable to find Android changelog notes for 2026.6.2");
  });

  it("treats empty changelog sections as absent", () => {
    expect(
      extractChangelogSection("## Unreleased\n\n\n## 2026.6.2\n\nNotes.\n", "Unreleased"),
    ).toBeNull();
  });
});

describe("syncAndroidVersioning", () => {
  it("syncs generated Gradle version properties and Fastlane release notes", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      releaseNotes: "stale notes\n",
      versionProperties: "stale version\n",
    });

    expect(syncAndroidVersioning({ mode: "write", rootDir }).updatedPaths).toEqual([
      path.join(rootDir, "apps/android/Config/Version.properties"),
      path.join(rootDir, "apps/android/fastlane/metadata/android/en-US/release_notes.txt"),
    ]);
  });
});
