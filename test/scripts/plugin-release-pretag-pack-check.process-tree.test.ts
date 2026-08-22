// Routing tests cover the pretag caller; this exact-head proof exercises the canonical runner
// against a real process tree without mocking its timeout or signal handling.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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

function createProofCommand(): {
  commandPath: string;
  descendantPidFile: string;
  directPidFile: string;
  repoDir: string;
} {
  const repoDir = tempDirs.make("openclaw-plugin-pretag-proof-");
  mkdirSync(repoDir, { recursive: true });
  const directPidFile = join(repoDir, "proof-pack.pid");
  const descendantPidFile = join(repoDir, "proof-descendant.pid");
  const commandPath = join(repoDir, "hang.mjs");
  writeFileSync(
    commandPath,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const directPidFile = process.env.PROOF_DIRECT_PID_FILE;
const descendantPidFile = process.env.PROOF_DESCENDANT_PID_FILE;
if (!directPidFile || !descendantPidFile) {
  throw new Error("proof PID paths are required");
}
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
writeFileSync(directPidFile, String(process.pid));
writeFileSync(descendantPidFile, String(descendant.pid));
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  return { commandPath, descendantPidFile, directPidFile, repoDir };
}

describe("scripts/plugin-release-pretag-pack-check.ts process-tree proof", () => {
  posixIt(
    "times out a real release command and leaves no descendant alive",
    async () => {
      const { commandPath, descendantPidFile, directPidFile, repoDir } = createProofCommand();
      let proofSucceeded = false;
      try {
        const startedAt = Date.now();
        let thrown: unknown;
        try {
          await runManagedCommand({
            args: [commandPath],
            bin: process.execPath,
            cwd: repoDir,
            env: {
              ...process.env,
              PROOF_DIRECT_PID_FILE: directPidFile,
              PROOF_DESCENDANT_PID_FILE: descendantPidFile,
            },
            shell: false,
            stdio: "ignore",
            timeoutMs: 2_000,
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toMatchObject({ code: "ETIMEDOUT" });
        await waitFor(() => existsSync(directPidFile) && existsSync(descendantPidFile));
        const directPid = Number(readFileSync(directPidFile, "utf8"));
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
        if (!proofSucceeded) {
          for (const pidFile of [directPidFile, descendantPidFile]) {
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
