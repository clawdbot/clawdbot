import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import {
  androidBuildMetadataGradleArgs,
  resolveAndroidBuildMetadata,
  verifyAndroidReleaseSource,
} from "../../apps/android/scripts/build-release-artifacts.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "apps/android/scripts/build-release-artifacts.ts";
const APK_CERTIFICATE_SHA256 = "80dbc62315ea216dd6e8a7060735a866ddc464a48ed50fef29ff0550468b9a63";
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const processEnv = { ...process.env };
  delete processEnv.GIT_COMMIT;
  delete processEnv.GIT_SHA;
  delete processEnv.GITHUB_SHA;
  delete processEnv.OPENCLAW_BUILD_TIMESTAMP;
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...processEnv, ...env },
  });
}

function fakeApkSigner(certificateSha256: string, signerCount = 1) {
  const tempRoot = tempRoots.make("openclaw-apksigner-");
  const buildToolsDir = path.join(tempRoot, "build-tools", "36.0.0");
  fs.mkdirSync(buildToolsDir, { recursive: true });
  const apkSignerPath = path.join(buildToolsDir, "apksigner");
  const signerLines = Array.from(
    { length: signerCount },
    (_, index) => `Signer #${index + 1} certificate SHA-256 digest: ${certificateSha256}`,
  );
  fs.writeFileSync(
    apkSignerPath,
    `#!/bin/sh\nprintf '%s\\n' ${signerLines.map((line) => `'${line}'`).join(" ")}\n`,
  );
  fs.chmodSync(apkSignerPath, 0o755);
  const apkPath = path.join(tempRoot, "OpenClaw-Android.apk");
  fs.writeFileSync(apkPath, "fake apk bytes");
  return { apkPath, sdkRoot: tempRoot };
}

describe("Android release artifacts", () => {
  it("resolves release metadata from explicit environment values first", () => {
    const metadata = resolveAndroidBuildMetadata({
      env: {
        GIT_COMMIT: "A".repeat(40),
        GIT_SHA: "d".repeat(40),
        GITHUB_SHA: "b".repeat(40),
        OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03Z",
      },
      now: () => new Date("2026-07-11T00:00:00Z"),
      readGitCommit: () => "c".repeat(40),
    });

    expect(metadata).toEqual({
      commit: "a".repeat(40),
      timestamp: "2026-07-10T01:02:03.000Z",
    });
  });

  it("prefers explicit metadata, then the checkout, then a git-less GitHub fallback", () => {
    const gitShaMetadata = resolveAndroidBuildMetadata({
      env: { GIT_SHA: "a".repeat(40), GITHUB_SHA: "b".repeat(40) },
      now: () => new Date("2026-07-10T04:05:06Z"),
      readGitCommit: () => "c".repeat(40),
    });
    const repositoryMetadata = resolveAndroidBuildMetadata({
      env: { GITHUB_SHA: "b".repeat(40) },
      now: () => new Date("2026-07-10T04:05:06Z"),
      readGitCommit: () => "c".repeat(40),
    });
    const githubMetadata = resolveAndroidBuildMetadata({
      env: { GITHUB_SHA: "b".repeat(40) },
      now: () => new Date("2026-07-10T04:05:06Z"),
      readGitCommit: () => {
        throw new Error("git unavailable");
      },
    });

    expect(gitShaMetadata.commit).toBe("a".repeat(40));
    expect(githubMetadata.commit).toBe("b".repeat(40));
    expect(repositoryMetadata).toEqual({
      commit: "c".repeat(40),
      timestamp: "2026-07-10T04:05:06.000Z",
    });
  });

  it("rejects missing commit metadata when neither Git nor GitHub is available", () => {
    expect(() =>
      resolveAndroidBuildMetadata({
        env: {},
        readGitCommit: () => {
          throw new Error("git unavailable");
        },
      }),
    ).toThrow("Unable to resolve the Android release Git commit");
  });

  it("rejects partial commits and non-UTC build timestamps", () => {
    expect(() =>
      resolveAndroidBuildMetadata({
        env: { GIT_COMMIT: "abc1234", GITHUB_SHA: "b".repeat(40) },
      }),
    ).toThrow("full 40-character hexadecimal Git commit");
    expect(() =>
      resolveAndroidBuildMetadata({
        env: {
          GIT_COMMIT: "a".repeat(40),
          OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03+01:00",
        },
      }),
    ).toThrow("ISO-8601 UTC timestamp");
  });

  it("passes build metadata as named Gradle project properties", () => {
    expect(
      androidBuildMetadataGradleArgs({
        commit: "a".repeat(40),
        timestamp: "2026-07-10T01:02:03.000Z",
      }),
    ).toEqual([
      `-PopenclawBuildCommit=${"a".repeat(40)}`,
      "-PopenclawBuildTimestamp=2026-07-10T01:02:03.000Z",
    ]);
  });

  it("requires release metadata to match a clean checkout", () => {
    const commit = "a".repeat(40);
    const cleanGit = (args: string[]) => (args[0] === "rev-parse" ? `${commit}\n` : "");

    expect(() => verifyAndroidReleaseSource(commit, { runGit: cleanGit })).not.toThrow();
    expect(() => verifyAndroidReleaseSource("b".repeat(40), { runGit: cleanGit })).toThrow(
      "Android release commit mismatch",
    );
    expect(() =>
      verifyAndroidReleaseSource(commit, {
        runGit: (args) => (args[0] === "rev-parse" ? `${commit}\n` : " M app/src/main.kt\n"),
      }),
    ).toThrow("Android release builds require a clean Git checkout");
  });

  it("selects only the signed third-party APK for GitHub distribution", () => {
    const result = run(["--artifact", "third-party", "--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Release artifact: third-party apk");
    expect(result.stdout).toContain("Gradle task: :app:assembleThirdPartyRelease");
    expect(result.stdout).not.toContain("Release artifact: play aab");
  });

  it("rejects unknown artifact selectors", () => {
    const result = run(["--artifact", "debug", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--artifact must be one of: all, play, third-party");
  });

  it("accepts the pinned standalone APK signing certificate", () => {
    const { apkPath, sdkRoot } = fakeApkSigner(APK_CERTIFICATE_SHA256);

    const result = run(["--verify-apk", apkPath], {
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verified pinned APK signing certificate");
  });

  it("rejects an APK signed by another certificate", () => {
    const { apkPath, sdkRoot } = fakeApkSigner("a".repeat(64));

    const result = run(["--verify-apk", apkPath], {
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("APK signing certificate mismatch");
  });

  it("rejects APKs with multiple signers", () => {
    const { apkPath, sdkRoot } = fakeApkSigner(APK_CERTIFICATE_SHA256, 2);

    const result = run(["--verify-apk", apkPath], {
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected exactly one SHA-256 signing certificate");
  });
});
