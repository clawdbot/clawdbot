// Android Version tests cover android version script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalAndroidVersionCode,
  checkAndroidVersioning,
  extractChangelogSection,
  normalizePinnedAndroidVersion,
  renderAndroidReleaseNotes,
  renderAndroidVersionProperties,
  resolveAndroidVersion,
  resolveGatewayVersionForAndroidRelease,
} from "../../scripts/lib/android-version.ts";
import {
  parseVersionQueryArgs,
  parseVersionSyncArgs,
} from "../../scripts/lib/version-script-args.ts";
import {
  installAndroidFixtureCleanup,
  writeAndroidFixture,
} from "./android-version.test-support.ts";

installAndroidFixtureCleanup();

describe("resolveAndroidVersion", () => {
  it("preserves mobile parser ordering and platform-specific revision support", () => {
    expect(
      parseVersionQueryArgs(["--shell", "--", "--json", "--field", "canonicalVersion"]),
    ).toMatchObject({ field: "canonicalVersion", format: "json" });
    expect(parseVersionSyncArgs(["--check", "--write"])).toMatchObject({ mode: "write" });
    expect(() => parseVersionQueryArgs(["--field=canonicalVersion"])).toThrow(
      "Unknown argument: --field=canonicalVersion",
    );
    expect(() => parseVersionSyncArgs(["--revision"])).toThrow("Unknown argument: --revision");
    expect(
      parseVersionSyncArgs(["--revision", "1"], { allowAppStoreRevision: true }),
    ).toMatchObject({ appStoreRevision: "1" });
  });

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
      iosChangelogPath: path.join(rootDir, "apps/ios/CHANGELOG.md"),
      legacyChangelogPath: path.join(rootDir, "apps/android/CHANGELOG.md"),
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

describe("gateway version ownership", () => {
  it("derives the default Play-compatible versionCode from the pinned version", () => {
    expect(canonicalAndroidVersionCode("2026.6.2")).toBe(2026060201);
  });

  it("rejects pinned versions that cannot derive Play-compatible version codes", () => {
    expect(() => canonicalAndroidVersionCode("2026.6.100")).toThrow(
      "Unable to derive Android versionCode from 2026.6.100",
    );
  });

  it("reads the mobile version independently of package.json", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      mobileVersion: "2026.6.5",
      packageVersion: "2026.9.9",
    });

    expect(resolveGatewayVersionForAndroidRelease(rootDir)).toEqual({
      gatewayVersion: "2026.6.5",
      pinnedAndroidVersion: "2026.6.5",
      versionCode: 2026060501,
    });
  });
});

describe("renderAndroidVersionProperties", () => {
  it("renders checked-in defaults from the pinned Android version", () => {
    const properties = renderAndroidVersionProperties({
      canonicalVersion: "2026.6.2",
      versionCode: 2026060201,
    });

    expect(properties).toContain("Generated by scripts/mobile-release-version.ts.");
    expect(properties).toContain("OPENCLAW_ANDROID_VERSION_NAME=2026.6.2");
    expect(properties).toContain("OPENCLAW_ANDROID_VERSION_CODE=2026060201");
  });
});

describe("renderAndroidReleaseNotes", () => {
  it("extracts exact pinned-version notes before Unreleased notes", () => {
    expect(
      renderAndroidReleaseNotes(
        { canonicalVersion: "2026.6.2" },
        "# OpenClaw Android Changelog\n\n## Unreleased\n\nFuture Android changes.\n\n## 2026.6.2 - 2026-06-02\n\nPinned Android release notes.\n",
      ),
    ).toBe("Pinned Android release notes.\n");
  });

  it("falls back to Unreleased notes while iterating on a release train", () => {
    expect(
      renderAndroidReleaseNotes(
        { canonicalVersion: "2026.6.2" },
        "# OpenClaw Android Changelog\n\n## Unreleased\n\nPending Android notes.\n",
      ),
    ).toBe("Pending Android notes.\n");
  });

  it("rejects changelogs without exact-version or Unreleased notes", () => {
    expect(() =>
      renderAndroidReleaseNotes(
        { canonicalVersion: "2026.6.2" },
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

describe("checkAndroidVersioning", () => {
  it("rejects stale shared mobile release outputs without changing files", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      releaseNotes: "stale notes\n",
      versionProperties: renderAndroidVersionProperties({
        canonicalVersion: "2026.6.2",
        versionCode: 2026060201,
      }),
    });

    expect(() => checkAndroidVersioning({ requireMobileRelease: true, rootDir })).toThrow(
      "Android release notes is stale",
    );
    expect(
      fs.readFileSync(
        path.join(rootDir, "apps/android/fastlane/metadata/android/en-US/release_notes.txt"),
        "utf8",
      ),
    ).toBe("stale notes\n");
  });

  it("routes Android release preparation through the shared mobile cutter", () => {
    const readme = fs.readFileSync(path.join(process.cwd(), "apps/android/README.md"), "utf8");
    const phoneBuild = fs.readFileSync(
      path.join(process.cwd(), "apps/android/app/build.gradle.kts"),
      "utf8",
    );
    const wearBuild = fs.readFileSync(
      path.join(process.cwd(), "apps/android/wear/build.gradle.kts"),
      "utf8",
    );

    expect(readme).not.toContain("pnpm android:version:pin --");
    expect(readme).toContain("scripts/mobile-release-version.ts --prepare");
    expect(readme).toContain("scripts/mobile-release-version.ts --finalize");
    expect(phoneBuild).not.toContain("pnpm android:version:sync");
    expect(phoneBuild).toContain("scripts/mobile-release-version.ts --prepare");
    expect(phoneBuild).toContain("--finalize");
    expect(wearBuild).toContain("scripts/mobile-release-version.ts --prepare");
    expect(wearBuild).toContain("--finalize");
  });

  it("rejects notes from a prior iOS revision when a later revision is selected", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.8.2",
      versionCode: 2026080201,
      iosChangelog:
        "# OpenClaw iOS Changelog\n\n" +
        "## Unreleased\n\n" +
        "## 2026.8.21\n\nCurrent revision notes.\n\n" +
        "## 2026.8.20\n\nPrior revision notes.\n",
      releaseNotes: "Prior revision notes.\n",
      versionProperties: renderAndroidVersionProperties({
        canonicalVersion: "2026.8.2",
        versionCode: 2026080201,
      }),
    });

    expect(() =>
      checkAndroidVersioning({
        appStoreRevision: "1",
        requireMobileRelease: true,
        rootDir,
      }),
    ).toThrow("Android release notes is stale");

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/android-sync-versioning.ts",
        "--check",
        "--require-mobile-release",
        "--revision",
        "1",
        "--root",
        rootDir,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Android release notes is stale");
  });

  it("accepts prepared and finalized shared mobile release notes", () => {
    const prepared = writeAndroidFixture({
      version: "2026.8.2",
      versionCode: 2026080201,
      iosChangelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\nPrepared notes.\n",
      releaseNotes: "Prepared notes.\n",
      versionProperties: renderAndroidVersionProperties({
        canonicalVersion: "2026.8.2",
        versionCode: 2026080201,
      }),
    });
    expect(checkAndroidVersioning({ requireMobileRelease: true, rootDir: prepared })).toEqual({
      checkedPaths: [
        path.join(prepared, "apps/android/Config/Version.properties"),
        path.join(prepared, "apps/android/fastlane/metadata/android/en-US/release_notes.txt"),
      ],
    });

    const finalized = writeAndroidFixture({
      version: "2026.8.2",
      versionCode: 2026080201,
      iosChangelog: "# OpenClaw iOS Changelog\n\n## Unreleased\n\n## 2026.8.20\n\nFinal notes.\n",
      releaseNotes: "Final notes.\n",
      versionProperties: renderAndroidVersionProperties({
        canonicalVersion: "2026.8.2",
        versionCode: 2026080201,
      }),
    });
    expect(() =>
      checkAndroidVersioning({ requireMobileRelease: true, rootDir: finalized }),
    ).not.toThrow();
  });

  it("keeps the pre-contract Android baseline non-release and exact", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.7.4",
      versionCode: 2026070401,
      mobileVersion: "2026.8.1",
      changelog: "# OpenClaw Android Changelog\n\n## 2026.7.4\n\nLegacy notes.\n",
      releaseNotes: "Legacy notes.\n",
      versionProperties:
        "# Shared Android version defaults.\n" +
        "# Source of truth: apps/android/version.json\n" +
        "# Generated by scripts/android-sync-versioning.ts.\n\n" +
        "OPENCLAW_ANDROID_VERSION_NAME=2026.7.4\n" +
        "OPENCLAW_ANDROID_VERSION_CODE=2026070401\n",
    });

    expect(() => checkAndroidVersioning({ rootDir })).not.toThrow();
    expect(() => checkAndroidVersioning({ requireMobileRelease: true, rootDir })).toThrow(
      "does not match mobile gateway 2026.8.1",
    );
  });

  it("retires the write-mode sync command before mutation", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      releaseNotes: "stale notes\n",
      versionProperties: "stale version\n",
    });
    const trackedPaths = [
      "apps/android/Config/Version.properties",
      "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
    ];
    const before = trackedPaths.map((relativePath) =>
      fs.readFileSync(path.join(rootDir, relativePath), "utf8"),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-sync-versioning.ts", "--write", "--root", rootDir],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Android version sync is retired");
    expect(
      trackedPaths.map((relativePath) => fs.readFileSync(path.join(rootDir, relativePath), "utf8")),
    ).toEqual(before);
  });
});
