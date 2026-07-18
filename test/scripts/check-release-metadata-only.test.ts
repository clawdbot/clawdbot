import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-release-metadata-only.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../scripts/check-release-metadata-only.mjs",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

  it("fails with an actionable timeout when git diff hangs", () => {
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

    const result = spawnSync(process.execPath, [scriptPath], {
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
  });
});
