// Real pretag proof verifies timeout cleanup without mocking the managed runner.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginReleasePretagPackCheck } from "../../scripts/plugin-release-pretag-pack-check.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const posixIt = process.platform === "win32" ? it.skip : it;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessIfAlive(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The managed runner may have already reaped the fixture process.
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for proof fixture");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function createProofRepo(): {
  repoDir: string;
  npmPidFile: string;
  descendantPidFile: string;
  shimDir: string;
} {
  const repoDir = tempDirs.make("openclaw-plugin-pretag-proof-");
  mkdirSync(join(repoDir, "extensions"), { recursive: true });
  symlinkSync(join(process.cwd(), "scripts"), join(repoDir, "scripts"), "dir");
  symlinkSync(join(process.cwd(), "packages"), join(repoDir, "packages"), "dir");
  symlinkSync(join(process.cwd(), "node_modules"), join(repoDir, "node_modules"), "dir");
  writeJsonFile(join(repoDir, "package.json"), {
    name: "openclaw-proof-root",
    version: "2026.8.22",
    private: true,
    type: "module",
  });
  writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - extensions/*\n");
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");

  const packageDir = join(repoDir, "extensions", "proof-plugin");
  mkdirSync(packageDir, { recursive: true });
  writeJsonFile(join(packageDir, "package.json"), {
    name: "@openclaw/proof-plugin",
    version: "2026.8.22",
    type: "module",
    repository: { type: "git", url: "https://github.com/openclaw/openclaw" },
    openclaw: {
      extensions: ["./index.ts"],
      compat: { pluginApi: ">=2026.8.22" },
      build: { openclawVersion: "2026.8.22" },
      install: { npmSpec: "@openclaw/proof-plugin" },
      release: { publishToClawHub: true },
    },
  });
  writeFileSync(join(packageDir, "README.md"), "# Proof plugin\n");
  writeFileSync(join(packageDir, "index.ts"), "export const proof = 1;\n");
  mkdirSync(join(packageDir, "dist"));
  writeFileSync(join(packageDir, "dist", "index.js"), "export const proof = 1;\n");

  const npmPidFile = join(repoDir, "proof-npm.pid");
  const descendantPidFile = join(repoDir, "proof-descendant.pid");
  const shimDir = join(repoDir, "bin");
  mkdirSync(shimDir);
  writeFileSync(
    join(shimDir, "npm"),
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "view") {
  process.exit(0);
}
if (args[0] === "pack" || args[0] === "exec") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const npmPidFile = process.env.PROOF_NPM_PID_FILE;
  const descendantPidFile = process.env.PROOF_DESCENDANT_PID_FILE;
  if (!npmPidFile || !descendantPidFile) {
    throw new Error("proof PID paths are required");
  }
  writeFileSync(npmPidFile, String(process.pid));
  writeFileSync(descendantPidFile, String(descendant.pid));
  setInterval(() => {}, 1000);
}
process.exitCode = 2;
`,
    "utf8",
  );
  chmodSync(join(shimDir, "npm"), 0o755);
  return { repoDir, npmPidFile, descendantPidFile, shimDir };
}

describe("scripts/plugin-release-pretag-pack-check.ts real behavior", () => {
  posixIt(
    "times out a real pretag pack and leaves no descendant alive",
    async () => {
      const { repoDir, npmPidFile, descendantPidFile, shimDir } = createProofRepo();
      const originalPath = process.env.PATH;
      const originalNpmPidFile = process.env.PROOF_NPM_PID_FILE;
      const originalDescendantPidFile = process.env.PROOF_DESCENDANT_PID_FILE;
      const originalSourceCommit = process.env.SOURCE_COMMIT;
      const originalSourceRef = process.env.SOURCE_REF;
      process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
      process.env.PROOF_NPM_PID_FILE = npmPidFile;
      process.env.PROOF_DESCENDANT_PID_FILE = descendantPidFile;
      process.env.SOURCE_COMMIT = "0000000000000000000000000000000000000000";
      process.env.SOURCE_REF = "refs/heads/proof";
      let proofSucceeded = false;
      try {
        const startedAt = Date.now();
        let thrown: unknown;
        try {
          await runPluginReleasePretagPackCheck(repoDir, { timeoutMs: 2_000 });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toMatchObject({ code: "ETIMEDOUT" });
        await waitFor(() => existsSync(npmPidFile) && existsSync(descendantPidFile));
        const directPid = Number(readFileSync(npmPidFile, "utf8"));
        const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
        await waitFor(() => !isProcessAlive(directPid) && !isProcessAlive(descendantPid));
        const proof = {
          timeoutCode: (thrown as { code?: string }).code,
          message: (thrown as Error).message,
          elapsedWithinBound: Date.now() - startedAt < 15_000,
          directExited: !isProcessAlive(directPid),
          descendantExited: !isProcessAlive(descendantPid),
        };
        console.log(`pretag-process-tree-proof ${JSON.stringify(proof)}`);
        expect(proof).toMatchObject({
          timeoutCode: "ETIMEDOUT",
          elapsedWithinBound: true,
          directExited: true,
          descendantExited: true,
        });
        proofSucceeded = true;
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (originalNpmPidFile === undefined) delete process.env.PROOF_NPM_PID_FILE;
        else process.env.PROOF_NPM_PID_FILE = originalNpmPidFile;
        if (originalDescendantPidFile === undefined) delete process.env.PROOF_DESCENDANT_PID_FILE;
        else process.env.PROOF_DESCENDANT_PID_FILE = originalDescendantPidFile;
        if (originalSourceCommit === undefined) delete process.env.SOURCE_COMMIT;
        else process.env.SOURCE_COMMIT = originalSourceCommit;
        if (originalSourceRef === undefined) delete process.env.SOURCE_REF;
        else process.env.SOURCE_REF = originalSourceRef;
        if (!proofSucceeded) {
          for (const pidFile of [npmPidFile, descendantPidFile]) {
            if (existsSync(pidFile)) {
              killProcessIfAlive(Number(readFileSync(pidFile, "utf8")));
            }
          }
        }
      }
    },
    30_000,
  );
});
