// Android Pin Version tests cover the retired standalone release entry point.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installAndroidFixtureCleanup,
  writeAndroidFixture,
} from "./android-version.test-support.ts";

installAndroidFixtureCleanup();

describe("android-pin-version", () => {
  it("fails before mutating committed release metadata", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      prefix: "openclaw-android-pin-",
    });
    const trackedPaths = [
      "apps/android/version.json",
      "apps/android/Config/Version.properties",
      "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
    ];
    const before = trackedPaths.map((relativePath) =>
      fs.readFileSync(path.join(rootDir, relativePath), "utf8"),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-pin-version.ts", "--from-gateway", "--root", rootDir],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Android version pinning is retired");
    expect(
      trackedPaths.map((relativePath) => fs.readFileSync(path.join(rootDir, relativePath), "utf8")),
    ).toEqual(before);
  });

  it("documents the shared mobile cutter replacement", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/android-pin-version.ts", "--help"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("scripts/mobile-release-version.ts");
    expect(result.stderr).toBe("");
  });
});
