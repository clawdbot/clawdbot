// Android Pin Version tests cover android pin version script behavior.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, pinAndroidVersion } from "../../scripts/android-pin-version.ts";
import { resolveAndroidVersion } from "../../scripts/lib/android-version.ts";
import {
  installAndroidFixtureCleanup,
  writeAndroidFixture,
} from "./android-version.test-support.ts";

installAndroidFixtureCleanup();

describe("parseArgs", () => {
  it("requires exactly one pin source", () => {
    expect(() => parseArgs([])).toThrow(
      "Choose exactly one of --from-gateway or --version <YYYY.M.PATCH>",
    );
    expect(() => parseArgs(["--from-gateway", "--version", "2026.6.5"])).toThrow(
      "Choose exactly one of --from-gateway or --version <YYYY.M.PATCH>",
    );
  });

  it("parses explicit version codes strictly", () => {
    expect(parseArgs(["--version", "2026.6.5", "--version-code", "2026060502"])).toMatchObject({
      explicitVersion: "2026.6.5",
      explicitVersionCode: 2026060502,
      fromGateway: false,
    });

    for (const value of ["2026060502abc", "2026060502.5", "2e9", "0"]) {
      expect(() => parseArgs(["--version", "2026.6.5", "--version-code", value])).toThrow(
        `Invalid value for --version-code: ${value}. Expected a positive integer.`,
      );
    }
  });

  it("rejects flags where option values are required", () => {
    for (const { args, message } of [
      { args: ["--version", "--no-sync"], message: "Missing value for --version." },
      {
        args: ["--version", "2026.6.5", "--version-code", "--no-sync"],
        message: "Missing value for --version-code.",
      },
      {
        args: ["--version", "2026.6.5", "--root", "--no-sync"],
        message: "Missing value for --root.",
      },
    ]) {
      expect(() => parseArgs(args)).toThrow(message);
    }
  });
});

describe("pinAndroidVersion", () => {
  it("pins an explicit Android release version and syncs generated artifacts", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      prefix: "openclaw-android-pin-",
    });

    const result = pinAndroidVersion({
      explicitVersion: "2026.6.5",
      explicitVersionCode: null,
      fromGateway: false,
      rootDir,
      sync: true,
    });

    expect(result.previousVersion).toBe("2026.6.2");
    expect(result.previousVersionCode).toBe(2026060201);
    expect(result.nextVersion).toBe("2026.6.5");
    expect(result.nextVersionCode).toBe(2026060501);
    expect(result.packageVersion).toBeNull();
    expect(resolveAndroidVersion(rootDir).canonicalVersion).toBe("2026.6.5");
    expect(
      fs.readFileSync(path.join(rootDir, "apps", "android", "version.json"), "utf8"),
    ).toContain('"versionCode": 2026060501');
    expect(
      fs.readFileSync(
        path.join(rootDir, "apps", "android", "Config", "Version.properties"),
        "utf8",
      ),
    ).toContain("OPENCLAW_ANDROID_VERSION_NAME=2026.6.5");
    expect(result.syncedPaths).toHaveLength(1);
  });

  it("pins from the current gateway version without carrying prerelease suffixes", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      packageVersion: "2026.6.5-beta.3",
      prefix: "openclaw-android-pin-",
    });

    const result = pinAndroidVersion({
      explicitVersion: null,
      explicitVersionCode: null,
      fromGateway: true,
      rootDir,
      sync: true,
    });

    expect(result.nextVersion).toBe("2026.6.5");
    expect(result.nextVersionCode).toBe(2026060501);
    expect(result.packageVersion).toBe("2026.6.5-beta.3");
    expect(resolveAndroidVersion(rootDir).canonicalVersion).toBe("2026.6.5");
  });

  it("allows explicit versionCode increments for another build on the same train", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      prefix: "openclaw-android-pin-",
    });

    const result = pinAndroidVersion({
      explicitVersion: "2026.6.2",
      explicitVersionCode: 2026060202,
      fromGateway: false,
      rootDir,
      sync: true,
    });

    expect(result.nextVersion).toBe("2026.6.2");
    expect(result.nextVersionCode).toBe(2026060202);
    expect(resolveAndroidVersion(rootDir).versionCode).toBe(2026060202);
  });

  it("can skip syncing checked-in artifacts when requested", () => {
    const rootDir = writeAndroidFixture({
      version: "2026.6.2",
      versionCode: 2026060201,
      versionProperties: "stale\n",
      prefix: "openclaw-android-pin-",
    });

    const result = pinAndroidVersion({
      explicitVersion: "2026.6.5",
      explicitVersionCode: null,
      fromGateway: false,
      rootDir,
      sync: false,
    });

    expect(result.syncedPaths).toHaveLength(0);
    expect(
      fs.readFileSync(
        path.join(rootDir, "apps", "android", "Config", "Version.properties"),
        "utf8",
      ),
    ).toBe("stale\n");
  });
});
