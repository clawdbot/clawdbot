// iOS release wrapper tests keep release args fail-closed before Fastlane work.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WrapperCase = readonly [scriptPath: string, args: readonly string[], option: string];

function runScript(
  scriptPath: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { ok: boolean; stdout: string; stderr: string } {
  const scriptArgs =
    process.platform === "win32" ? [scriptPath] : ["--noprofile", "--norc", scriptPath];
  try {
    const stdout = execFileSync(BASH_BIN, [...scriptArgs, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf8") : String(e.stdout ?? "");
    const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : String(e.stderr ?? "");
    return { ok: false, stdout, stderr };
  }
}

describe("iOS release shell wrapper arguments", () => {
  const missingValueCases: readonly WrapperCase[] = [
    ["scripts/ios-release-upload.sh", ["--build-number", "--bogus"], "--build-number"],
    ["scripts/ios-release-upload.sh", ["--version", "--bogus"], "--version"],
    ["scripts/ios-release-upload.sh", ["--revision", "--bogus"], "--revision"],
    ["scripts/ios-release-plan.sh", ["--build-number", "--bogus"], "--build-number"],
    ["scripts/ios-release-plan.sh", ["--version", "--bogus"], "--version"],
    ["scripts/ios-release-plan.sh", ["--revision", "--bogus"], "--revision"],
    ["scripts/ios-release-archive.sh", ["--build-number", "--bogus"], "--build-number"],
    ["scripts/ios-release-archive.sh", ["--version", "--bogus"], "--version"],
    ["scripts/ios-release-archive.sh", ["--revision", "--bogus"], "--revision"],
    ["scripts/ios-release-prepare.sh", ["--build-number", "--team-id"], "--build-number"],
    [
      "scripts/ios-release-prepare.sh",
      ["--build-number", "3", "--version", "--bogus"],
      "--version",
    ],
    [
      "scripts/ios-release-prepare.sh",
      ["--version", "2026.7.2", "--revision", "1", "--build-number", "3", "--team-id", "--bogus"],
      "--team-id",
    ],
  ];

  it.each(missingValueCases)(
    "rejects missing %s option values before release work",
    (scriptPath, args, option) => {
      const result = runScript(path.join(process.cwd(), scriptPath), args);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain(`Missing value for ${option}.`);
      expect(result.stderr).not.toContain("No such file or directory");
      expect(result.stderr).not.toContain("fastlane");
      expect(result.stdout).toBe("");
    },
  );

  it.each(["scripts/ios-release-archive.sh", "scripts/ios-release-prepare.sh"])(
    "requires an explicit gateway version before release work in %s",
    (scriptPath) => {
      const args = scriptPath.endsWith("prepare.sh") ? ["--build-number", "3"] : [];
      const result = runScript(path.join(process.cwd(), scriptPath), args, {
        IOS_RELEASE_VERSION: "2026.6.10",
      });

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Missing required --version.");
      expect(result.stderr).not.toContain("No such file or directory");
      expect(result.stderr).not.toContain("fastlane");
      expect(result.stdout).toBe("");
    },
  );

  it.each(["scripts/ios-release-archive.sh", "scripts/ios-release-prepare.sh"])(
    "requires an explicit App Store revision before release work in %s",
    (scriptPath) => {
      const args = ["--version", "2026.7.2"];
      if (scriptPath.endsWith("prepare.sh")) {
        args.push("--build-number", "3");
      }
      const result = runScript(path.join(process.cwd(), scriptPath), args);

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Missing required --revision.");
      expect(result.stderr).not.toContain("fastlane");
      expect(result.stdout).toBe("");
    },
  );

  it.each(["scripts/ios-release-upload.sh", "scripts/ios-release-archive.sh"])(
    "does not accept ambient release build numbers in %s",
    (scriptPath) => {
      const script = readFileSync(path.join(process.cwd(), scriptPath), "utf8");

      expect(script).toContain('BUILD_NUMBER=""');
      expect(script).not.toContain('BUILD_NUMBER="${IOS_RELEASE_BUILD_NUMBER:-}"');
    },
  );

  it("lets the guarded upload lane resolve omitted release arguments", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts/ios-release-upload.sh"), "utf8");

    expect(script).not.toContain("Missing required --version.");
    expect(script).not.toContain("Missing required --revision.");
    expect(script).toContain('[[ -n "${RELEASE_VERSION}" ]]');
    expect(script).toContain('[[ -n "${APP_STORE_REVISION}" ]]');
  });

  it("rejects App Store release relay URL overrides before release work", () => {
    const result = runScript(
      path.join(process.cwd(), "scripts/ios-release-prepare.sh"),
      ["--version", "2026.7.2", "--revision", "1", "--build-number", "3"],
      {
        IOS_DEVELOPMENT_TEAM: "FWJYW4S8P8",
        OPENCLAW_PUSH_RELAY_BASE_URL: "https://relay.example.com",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("custom relay URL overrides are not allowed");
    expect(result.stderr).not.toContain("fastlane");
    expect(result.stdout).toBe("");
  });

  it("requires stamped build metadata for App Store release preparation", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts/ios-release-prepare.sh"), "utf8");

    expect(script).toContain("OPENCLAW_REQUIRE_BUILD_METADATA=1");
    expect(script).toContain(
      'RELEASE_SOURCE_HELPER="${ROOT_DIR}/scripts/apple-release-source-check.sh"',
    );
    expect(script).toContain('--expected-commit "${RELEASE_GIT_COMMIT}"');
    expect(script.indexOf('bash "${RELEASE_SOURCE_HELPER}"')).toBeLessThan(
      script.lastIndexOf("prepare_build_dir"),
    );
    expect(script).toContain('export GIT_COMMIT="${RELEASE_GIT_COMMIT}"');
  });

  it("preserves Fastlane failures through the shared runner", () => {
    const binDir = tempDirs.make("openclaw-fastlane-test-");
    const fastlane = path.join(binDir, "fastlane");
    writeFileSync(
      fastlane,
      '#!/usr/bin/env bash\n[[ "${1:-}" == "--version" ]] && exit 0\nexit 37\n',
    );
    chmodSync(fastlane, 0o755);
    const result = spawnSync(
      BASH_BIN,
      ["-c", "source scripts/lib/ios-fastlane.sh; run_ios_fastlane ios release_plan"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(37);
  });
});
