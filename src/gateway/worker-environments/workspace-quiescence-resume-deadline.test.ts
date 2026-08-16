import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_RESUME_JS,
  WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE,
} from "./workspace-quiescence-scripts.js";
import {
  fixture,
  leasePath,
  processStart,
  terminate,
} from "./workspace-quiescence-scripts.test-support.js";

describe("remote workspace quiescence resume deadline", () => {
  it("bounds a maximum-size recovery after partial progress", async () => {
    const input = await fixture();
    const stalledProcess = spawn("sleep", ["30"], { stdio: "ignore" });
    const stalledPid = stalledProcess.pid!;
    const nonce = "a".repeat(32);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    try {
      const healthyReference = { pid: process.pid, start: await processStart(process.pid) };
      const stalledReference = { pid: stalledPid, start: await processStart(stalledPid) };
      await fs.mkdir(path.dirname(leaseFile), { recursive: true });
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          version: 1,
          nonce,
          processes: [healthyReference, ...Array.from({ length: 4_095 }, () => stalledReference)],
          watchdog: null,
          expiresAtMs: Date.now() + 60_000,
        }),
      );
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${stalledPid}\n`);

      const startedAt = Date.now();
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 10_000, baseEnv: input.env, killProcessTree: true },
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.termination).toBe("exit");
      expect(result.code).toBe(WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
      expect(result.stderr).toContain(
        "workspace quiescence recovery timed out; lease retained for operator recovery",
      );
      expect(elapsedMs).toBeGreaterThanOrEqual(4_000);
      expect(elapsedMs).toBeLessThan(8_000);
      const retained = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      expect(retained.processes).toHaveLength(4_095);
      expect(retained.processes.every((entry) => entry.pid === stalledPid)).toBe(true);
      expect(retained.recovery?.state).toBe("probe-timeout");
    } finally {
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await terminate(stalledProcess);
    }
  }, 14_000);
});
