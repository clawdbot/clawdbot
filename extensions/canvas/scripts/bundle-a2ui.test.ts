// Canvas tests cover bundle a2ui plugin behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import {
  compareNormalizedPaths,
  getBundleHashRepoInputPaths,
  getLocalRolldownCliCandidates,
  isBundleHashInputPath,
  listTrackedInputFiles,
} from "./bundle-a2ui.mjs";

describe("scripts/bundle-a2ui.mjs", () => {
  it("uses package metadata and plugin-owned A2UI sources as bundle hash inputs", () => {
    const repoRoot = path.resolve("repo-root");
    const inputPaths = getBundleHashRepoInputPaths(repoRoot);

    expect(inputPaths).toContain(path.join(repoRoot, "package.json"));
    expect(inputPaths).toContain(path.join(repoRoot, "pnpm-lock.yaml"));
    expect(inputPaths).toContain(
      path.join(repoRoot, "extensions", "canvas", "src", "host", "a2ui-app"),
    );
    expect(inputPaths).not.toContain(path.join(repoRoot, "vendor", "a2ui", "renderers", "lit"));
    expect(isBundleHashInputPath(path.join(repoRoot, "package.json"), repoRoot)).toBe(true);
  });

  it("prefers the installed rolldown CLI over a network dlx fallback", () => {
    const repoRoot = path.resolve("repo-root");

    expect(getLocalRolldownCliCandidates(repoRoot)[0]).toBe(
      path.join(repoRoot, "node_modules", "rolldown", "bin", "cli.mjs"),
    );
  });

  it("sorts hash inputs without locale-dependent collation", () => {
    const paths = ["repo/Z.ts", "repo/a.ts", "repo/ä.ts", "repo/A.ts"];

    expect([...paths].toSorted(compareNormalizedPaths)).toEqual([
      "repo/A.ts",
      "repo/Z.ts",
      "repo/a.ts",
      "repo/ä.ts",
    ]);
  });

  it("keeps unrelated package metadata out of bundle hash inputs", () => {
    const repoRoot = path.resolve("repo-root");
    const inputPaths = getBundleHashRepoInputPaths(repoRoot);

    expect(inputPaths).not.toContain(path.join(repoRoot, "ui", "package.json"));
    expect(inputPaths).not.toContain(path.join(repoRoot, "packages", "plugin-sdk", "package.json"));
  });

  it("keeps local node_modules state out of bundle hash inputs", () => {
    const repoRoot = process.cwd();
    const inputPaths = getBundleHashRepoInputPaths(repoRoot);

    expect(inputPaths).not.toContain(path.join(repoRoot, "node_modules", "lit", "package.json"));
    expect(inputPaths).not.toContain(
      path.join(repoRoot, "ui", "node_modules", "lit", "package.json"),
    );
  });

  it("bounds tracked-input discovery and treats a timeout as a fallback", () => {
    const repoRoot = path.resolve("repo-root");
    const runGit = vi.fn(() => ({ status: null, stdout: "" }));

    expect(listTrackedInputFiles(runGit, repoRoot)).toBeNull();
    expect(runGit).toHaveBeenCalledWith(
      "git",
      ["ls-files", "--", "package.json", "pnpm-lock.yaml", "extensions/canvas/src/host/a2ui-app"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      },
    );
  });

  it.skipIf(process.platform === "win32")(
    "matches the tracked-input hash when Git discovery fails",
    async () => {
      await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-a2ui-git-fallback-" },
        async ({ dir }) => {
          const fakeBinDir = path.join(dir, "bin");
          const fakeGitPath = path.join(fakeBinDir, "git");
          const outputFile = path.join(dir, "a2ui.bundle.js");
          const hashFile = path.join(dir, "a2ui.bundle.hash");
          const scriptPath = path.resolve("extensions/canvas/scripts/bundle-a2ui.mjs");
          const baseEnv = {
            ...process.env,
            OPENCLAW_A2UI_BUNDLE_HASH_FILE: hashFile,
            OPENCLAW_A2UI_BUNDLE_OUT: outputFile,
          };
          await fs.mkdir(fakeBinDir, { recursive: true });
          await fs.writeFile(fakeGitPath, `#!${process.execPath}\nprocess.exit(1);\n`, "utf8");
          await fs.chmod(fakeGitPath, 0o755);

          execFileSync(process.execPath, [scriptPath], {
            cwd: process.cwd(),
            encoding: "utf8",
            env: baseEnv,
            killSignal: "SIGKILL",
            timeout: 12_000,
          });
          const trackedHash = await fs.readFile(hashFile, "utf8");

          execFileSync(process.execPath, [scriptPath], {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              ...baseEnv,
              PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
            },
            killSignal: "SIGKILL",
            timeout: 12_000,
          });

          await expect(fs.readFile(hashFile, "utf8")).resolves.toBe(trackedHash);
          await expect(fs.stat(outputFile)).resolves.toBeDefined();
        },
      );
    },
  );
});
