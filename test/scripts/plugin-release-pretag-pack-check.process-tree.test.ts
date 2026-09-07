// This proof exercises the pretag caller against a real stalled runtime-build process tree.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginReleasePretagPackCheck } from "../../scripts/plugin-release-pretag-pack-check.ts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
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
  } catch {
    return false;
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // kill(pid, 0) also succeeds for a terminated process awaiting reaping.
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}

function killProcessIfAlive(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The managed runner may have reaped the fixture between the liveness check and signal.
  }
}

function readPid(pidFile: string): number {
  return existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for proof fixture");
    }
    await delay(25);
  }
}

function createProofRepo(): {
  descendantPidFile: string;
  directPidFile: string;
  repoDir: string;
} {
  const repoDir = tempDirs.make("openclaw-plugin-pretag-proof-");
  const scriptsDir = join(repoDir, "scripts");
  const directPidFile = join(repoDir, "runtime-build.pid");
  const descendantPidFile = join(repoDir, "runtime-build-descendant.pid");
  mkdirSync(scriptsDir, { recursive: true });
  writeJsonFile(join(repoDir, "package.json"), { name: "openclaw-test-root", type: "module" });
  writePublishablePluginFixture(repoDir, {
    version: "2026.8.26",
    publishTo: "npm",
  });

  // The production caller resolves the tsx loader from its cwd before launching this fixture.
  const nodeModulesDir = join(repoDir, "node_modules");
  mkdirSync(nodeModulesDir);
  symlinkSync(realpathSync(resolve("node_modules/tsx")), join(nodeModulesDir, "tsx"), "dir");
  writeFileSync(
    join(scriptsDir, "check-plugin-npm-runtime-builds.mts"),
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
writeFileSync(${JSON.stringify(directPidFile)}, String(process.pid));
writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  return { descendantPidFile, directPidFile, repoDir };
}

describe("scripts/plugin-release-pretag-pack-check.ts process-tree proof", () => {
  posixIt(
    "bounds a stalled runtime build and leaves no process-tree descendant alive",
    async () => {
      const { descendantPidFile, directPidFile, repoDir } = createProofRepo();
      const timeoutMs = 2_000;
      let descendantPid = 0;
      let directPid = 0;
      try {
        const startedAt = Date.now();
        let thrown: unknown;
        try {
          await runPluginReleasePretagPackCheck(repoDir, { timeoutMs });
        } catch (error) {
          thrown = error;
        }
        const elapsedMs = Date.now() - startedAt;

        expect(thrown).toMatchObject({
          code: "ETIMEDOUT",
          message:
            "plugin runtime build for @openclaw/demo-plugin timed out after 2000ms: node --import tsx scripts/check-plugin-npm-runtime-builds.mts --package extensions/demo-plugin",
        });
        expect(elapsedMs).toBeGreaterThanOrEqual(1_500);
        expect(elapsedMs).toBeLessThan(7_500);
        await waitFor(() => existsSync(directPidFile) && existsSync(descendantPidFile));
        directPid = readPid(directPidFile);
        descendantPid = readPid(descendantPidFile);
        expect(Number.isInteger(directPid) && directPid > 1).toBe(true);
        expect(Number.isInteger(descendantPid) && descendantPid > 1).toBe(true);
        await waitFor(() => !isProcessAlive(directPid) && !isProcessAlive(descendantPid));
        await delay(50);

        const proof = {
          timeoutCode: (thrown as { code?: string }).code,
          elapsedMs,
          completionBounded: elapsedMs < 7_500,
          directExited: !isProcessAlive(directPid),
          descendantExited: !isProcessAlive(descendantPid),
        };
        console.log(`pretag-caller-process-tree-proof ${JSON.stringify(proof)}`);
        expect(proof).toMatchObject({
          timeoutCode: "ETIMEDOUT",
          completionBounded: true,
          directExited: true,
          descendantExited: true,
        });
      } finally {
        directPid ||= readPid(directPidFile);
        descendantPid ||= readPid(descendantPidFile);
        killProcessIfAlive(directPid);
        killProcessIfAlive(descendantPid);
      }
    },
    30_000,
  );
});
