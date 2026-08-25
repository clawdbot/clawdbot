import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCuaDriverArtifacts } from "./driver-artifact-verification.js";

const temporaryDirectories: string[] = [];

function writeJson(pathname: string, value: unknown): void {
  fs.writeFileSync(pathname, `${JSON.stringify(value)}\n`, "utf8");
}

function createArtifactFixture(
  options: {
    platformKey?: "linux-x64-gnu" | "win32-x64-msvc";
    sdkVersion?: string;
    platformVersion?: string;
    omitPlatformPackage?: boolean;
    expectedDigest?: string;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cua-artifacts-"));
  temporaryDirectories.push(root);
  const platformKey = options.platformKey ?? "linux-x64-gnu";
  const acceptedVersion = "0.20.0";
  const nativeFile = platformKey.startsWith("linux")
    ? "libcua_driver_sdk.so"
    : "cua_driver_sdk.dll";
  const nativeContents = "accepted native artifact";
  const expectedDigest =
    options.expectedDigest ?? createHash("sha256").update(nativeContents).digest("hex");
  const sdkManifestPath = path.join(root, "sdk-package.json");
  const platformPackageName = `@trycua/cua-driver-${platformKey}`;
  const platformDir = path.join(root, "platform");
  const platformManifestPath = path.join(platformDir, "package.json");

  fs.mkdirSync(platformDir);
  const pluginManifest = {
    dependencies: { "@trycua/cua-driver": acceptedVersion },
    cuaDriverArtifacts: { [platformKey]: { files: { [nativeFile]: expectedDigest } } },
  };
  writeJson(sdkManifestPath, {
    name: "@trycua/cua-driver",
    version: options.sdkVersion ?? acceptedVersion,
  });
  writeJson(platformManifestPath, {
    name: platformPackageName,
    version: options.platformVersion ?? acceptedVersion,
  });
  fs.writeFileSync(path.join(platformDir, nativeFile), nativeContents);

  const packages = new Map<string, string>([["@trycua/cua-driver", sdkManifestPath]]);
  if (!options.omitPlatformPackage) {
    packages.set(platformPackageName, platformManifestPath);
  }
  return {
    pluginManifest,
    resolvePackageJson: (packageName: string) => packages.get(packageName),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("CUA Driver artifact verification", () => {
  it("accepts the pinned SDK and native file digest", () => {
    const fixture = createArtifactFixture();

    expect(
      inspectCuaDriverArtifacts({
        platform: "linux",
        arch: "x64",
        linuxLibc: "gnu",
        ...fixture,
      }),
    ).toEqual({
      ok: true,
      applicable: true,
      version: "0.20.0",
      platformPackage: "@trycua/cua-driver-linux-x64-gnu",
    });
  });

  it("reports an actionable typed diagnostic when the native package is absent", () => {
    const fixture = createArtifactFixture({ omitPlatformPackage: true });

    const result = inspectCuaDriverArtifacts({
      platform: "linux",
      arch: "x64",
      linuxLibc: "gnu",
      ...fixture,
    });

    expect(result).toMatchObject({ ok: false, code: "COMPUTER_DRIVER_PACKAGE_MISSING" });
    expect(result.ok ? "" : result.diagnostic).toContain("Reinstall OpenClaw on this node host");
  });

  it("refuses SDK and platform package version skew", () => {
    const fixture = createArtifactFixture({ platformVersion: "0.19.3" });

    const result = inspectCuaDriverArtifacts({
      platform: "linux",
      arch: "x64",
      linuxLibc: "gnu",
      ...fixture,
    });

    expect(result).toMatchObject({ ok: false, code: "COMPUTER_DRIVER_VERSION_MISMATCH" });
    expect(result.ok ? "" : result.diagnostic).toContain("resolved @trycua/cua-driver@0.20.0");
  });

  it("refuses a native file that does not match the accepted digest", () => {
    const fixture = createArtifactFixture({ expectedDigest: "0".repeat(64) });

    const result = inspectCuaDriverArtifacts({
      platform: "linux",
      arch: "x64",
      linuxLibc: "gnu",
      ...fixture,
    });

    expect(result).toMatchObject({ ok: false, code: "COMPUTER_DRIVER_DIGEST_MISMATCH" });
    expect(result.ok ? "" : result.diagnostic).toContain("do not run or replace");
  });

  it("rejects Linux hosts without a published glibc package", () => {
    const fixture = createArtifactFixture();

    const result = inspectCuaDriverArtifacts({
      platform: "linux",
      arch: "x64",
      linuxLibc: "musl",
      ...fixture,
    });

    expect(result).toMatchObject({ ok: false, code: "COMPUTER_DRIVER_PLATFORM_UNSUPPORTED" });
    expect(result.ok ? "" : result.diagnostic).toContain("glibc-based Linux");
  });
});

describe("verifyInstalledCuaDriverArtifacts (real resolution)", () => {
  // Regression: the CUA Driver SDK is ESM-only, so require-condition resolution
  // threw PATH_NOT_EXPORTED and every real install reported
  // COMPUTER_DRIVER_PACKAGE_MISSING even with the packages present.
  it("resolves the installed SDK package through import conditions", async () => {
    const { verifyInstalledCuaDriverArtifacts } = await import("./driver-artifacts.js");
    const result = verifyInstalledCuaDriverArtifacts();
    if (process.platform === "linux" || process.platform === "win32") {
      expect(result).toMatchObject({ ok: true, applicable: true });
    } else if (!result.ok) {
      // Other hosts are out of the fulfiller's scope but must never report a
      // missing package for an installed SDK.
      expect(result.code).not.toBe("COMPUTER_DRIVER_PACKAGE_MISSING");
    }
  });
});
