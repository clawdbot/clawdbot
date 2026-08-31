import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mobileReleaseRefFor,
  parseArgs,
  preflightMobileReleaseRef,
  recordMobileReleaseRef,
  resolveMobileReleaseRef,
} from "../../scripts/mobile-release-ref.ts";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "mobile-release-ref.ts");

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(cwd: string, args: string[]): string {
  return run("git", args, cwd);
}

function createFixtureRepo(): { cleanup: () => void; remote: string; root: string; sha: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-mobile-release-ref-"));
  const remote = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");

  git(root, ["init", "--bare", remote]);
  git(root, ["clone", remote, checkout]);
  git(checkout, ["config", "user.email", "release@example.com"]);
  git(checkout, ["config", "user.name", "Release Test"]);
  writeFileSync(path.join(checkout, "README.md"), "release\n", "utf8");
  git(checkout, ["add", "README.md"]);
  git(checkout, ["commit", "-m", "initial"]);
  const sha = git(checkout, ["rev-parse", "HEAD"]).trim();
  git(checkout, ["push", "origin", "HEAD:main"]);

  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    remote: "origin",
    root: checkout,
    sha,
  };
}

describe("mobile-release-ref", () => {
  it("renders platform release refs from store identities", () => {
    expect(mobileReleaseRefFor({ platform: "ios", version: "2026.6.10", build: "8" })).toBe(
      "refs/openclaw/mobile-releases/ios/2026.6.10-8",
    );
    expect(
      mobileReleaseRefFor({
        platform: "android",
        version: "2026.6.10",
        versionCode: "2026061008",
      }),
    ).toBe("refs/openclaw/mobile-releases/android/2026.6.10-2026061008");
  });

  it("validates platform-specific numeric identities", () => {
    expect(() =>
      mobileReleaseRefFor({ platform: "ios", version: "2026.6.10", build: "0" }),
    ).toThrow("Invalid iOS build");
    expect(() =>
      mobileReleaseRefFor({
        platform: "android",
        version: "2026.6.10",
        versionCode: "not-a-code",
      }),
    ).toThrow("Invalid Android versionCode");
    expect(() =>
      mobileReleaseRefFor({
        platform: "android",
        version: "2026.6.10",
        versionCode: "2026061101",
      }),
    ).toThrow("Expected 2026061001 through 2026061099");
    expect(() =>
      mobileReleaseRefFor({ platform: "ios", version: "2026.06.10", build: "8" }),
    ).toThrow("Invalid mobile release version");
  });

  it("parses CLI commands and rejects missing platform-specific fields", () => {
    expect(
      parseArgs([
        "record",
        "--",
        "--platform",
        "android",
        "--version",
        "2026.6.10",
        "--version-code",
        "2026061008",
        "--sha",
        "HEAD",
      ]),
    ).toMatchObject({
      command: "record",
      platform: "android",
      version: "2026.6.10",
      versionCode: "2026061008",
    });

    expect(() =>
      mobileReleaseRefFor({
        platform: "android",
        version: "2026.6.10",
      }),
    ).toThrow("Invalid Android versionCode");
  });

  it("creates, resolves, and idempotently accepts an existing same-SHA ref", () => {
    const fixture = createFixtureRepo();
    try {
      const options = {
        build: "8",
        command: "record" as const,
        platform: "ios" as const,
        remote: fixture.remote,
        rootDir: fixture.root,
        sha: "HEAD",
        version: "2026.6.10",
        versionCode: null,
      };

      expect(preflightMobileReleaseRef(options).status).toBe("available");
      expect(recordMobileReleaseRef(options)).toMatchObject({
        ref: "refs/openclaw/mobile-releases/ios/2026.6.10-8",
        sha: fixture.sha,
        status: "created",
      });
      expect(recordMobileReleaseRef(options).status).toBe("already-recorded");
      expect(resolveMobileReleaseRef(options)).toMatchObject({
        ref: "refs/openclaw/mobile-releases/ios/2026.6.10-8",
        sha: fixture.sha,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects an existing ref at a different SHA", () => {
    const fixture = createFixtureRepo();
    try {
      const first = {
        build: null,
        command: "record" as const,
        platform: "android" as const,
        remote: fixture.remote,
        rootDir: fixture.root,
        sha: "HEAD",
        version: "2026.6.10",
        versionCode: "2026061008",
      };
      recordMobileReleaseRef(first);

      writeFileSync(path.join(fixture.root, "README.md"), "next\n", "utf8");
      git(fixture.root, ["add", "README.md"]);
      git(fixture.root, ["commit", "-m", "next"]);

      expect(() => recordMobileReleaseRef(first)).toThrow("already points at");
    } finally {
      fixture.cleanup();
    }
  });

  it("prints the resolved SHA from the CLI", () => {
    const fixture = createFixtureRepo();
    try {
      recordMobileReleaseRef({
        build: "9",
        command: "record",
        platform: "ios",
        remote: fixture.remote,
        rootDir: fixture.root,
        sha: "HEAD",
        version: "2026.6.10",
        versionCode: null,
      });

      const stdout = run(
        process.execPath,
        [
          "--import",
          "tsx",
          SCRIPT_PATH,
          "resolve",
          "--platform",
          "ios",
          "--version",
          "2026.6.10",
          "--build",
          "9",
          "--root",
          fixture.root,
        ],
        process.cwd(),
      );

      expect(stdout).toBe(`${fixture.sha}\trefs/openclaw/mobile-releases/ios/2026.6.10-9\n`);
    } finally {
      fixture.cleanup();
    }
  });

  it("runs the CLI entrypoint from a path containing spaces", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw mobile release ref-"));
    try {
      const scriptDir = path.join(root, "script dir");
      const scriptPath = path.join(scriptDir, "mobile-release-ref.ts");
      mkdirSync(scriptDir, { recursive: true });
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
      copyFileSync(SCRIPT_PATH, scriptPath);

      const stdout = run(
        process.execPath,
        ["--import", "tsx", realpathSync(scriptPath), "--help"],
        process.cwd(),
      );

      expect(stdout).toContain("scripts/mobile-release-ref.ts preflight");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
