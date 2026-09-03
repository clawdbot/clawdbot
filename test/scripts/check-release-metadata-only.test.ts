import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-release-metadata-only.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../scripts/check-release-metadata-only.mts",
);
const tsxLoaderPath = path.resolve(import.meta.dirname, "../../scripts/tsx.mjs");
const tsconfigPath = path.resolve(import.meta.dirname, "../../tsconfig.json");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itUnix = process.platform === "win32" ? it.skip : it;

describe("check-release-metadata-only", () => {
  it("parses refs and explicit paths", () => {
    expect(
      parseArgs([
        "--base",
        "origin/release",
        "--head",
        "HEAD",
        "./package.json",
        "apps\\ios\\CHANGELOG.md",
      ]),
    ).toEqual({
      staged: false,
      base: "origin/release",
      head: "HEAD",
      paths: ["package.json", "apps/ios/CHANGELOG.md"],
    });
  });

  it("rejects missing ref option values", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("Expected --base <ref>.");
    expect(() => parseArgs(["--base", "-h"])).toThrow("Expected --base <ref>.");
    expect(() => parseArgs(["--head"])).toThrow("Expected --head <ref>.");
    expect(() => parseArgs(["--head", "-h"])).toThrow("Expected --head <ref>.");
    expect(() => parseArgs(["--base", ""])).toThrow("Expected --base <ref>.");
  });

  it("rejects unknown options before treating args as paths", () => {
    expect(() => parseArgs(["--stgaed"])).toThrow("Unknown option: --stgaed");
  });

  it("preserves option-shaped paths after the separator", () => {
    expect(parseArgs(["--staged", "--", "--head"])).toEqual({
      staged: true,
      base: "origin/main",
      head: "HEAD",
      paths: ["--head"],
    });
  });

  it("accepts only version-literal changes in the mobile manifest", () => {
    const root = tempDirs.make("openclaw-release-metadata-mobile-");
    const manifestPath = path.join(root, "apps/mobile/version.json");
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, '{\n  "version": "2026.8.1"\n}\n');
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=test@openclaw.invalid",
        "commit",
        "-qm",
        "baseline",
      ],
      { cwd: root },
    );

    writeFileSync(manifestPath, '{\n  "version": "2026.8.2"\n}\n');
    const accepted = spawnSync(
      process.execPath,
      [
        "--import",
        tsxLoaderPath,
        scriptPath,
        "--base",
        "HEAD",
        "--head",
        "HEAD",
        "--",
        "apps/mobile/version.json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
      },
    );
    expect(accepted.status).toBe(0);
    expect(accepted.stderr).toContain("[release-metadata] ok (1 files)");

    writeFileSync(manifestPath, '{\n  "version": "2026.8.2",\n  "channel": "stable"\n}\n');
    const rejected = spawnSync(
      process.execPath,
      [
        "--import",
        tsxLoaderPath,
        scriptPath,
        "--base",
        "HEAD",
        "--head",
        "HEAD",
        "--",
        "apps/mobile/version.json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
      },
    );
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      "apps/mobile/version.json: changed outside recognized version/build literals",
    );
  });

  itUnix("fails with an actionable timeout when git diff hangs", () => {
    const tempDir = tempDirs.make("openclaw-release-metadata-git-");
    const gitPath = path.join(tempDir, "git");
    writeFileSync(
      gitPath,
      `#!/usr/bin/env node
if (process.argv.includes("diff")) {
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
`,
      "utf8",
    );
    chmodSync(gitPath, 0o755);

    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        OPENCLAW_RELEASE_METADATA_GIT_TIMEOUT_MS: "500",
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "release metadata guard: git diff --name-only --diff-filter=ACMR origin/main...HEAD timed out after 500ms.",
    );

    const fractionalResult = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        OPENCLAW_RELEASE_METADATA_GIT_TIMEOUT_MS: "0.5",
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(fractionalResult.status).toBe(1);
    expect(fractionalResult.stderr).toContain("timed out after 1ms.");
  });
});
