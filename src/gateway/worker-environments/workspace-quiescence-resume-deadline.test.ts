import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_RESUME_JS,
  WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE,
} from "./workspace-quiescence-scripts.js";
import { fixture, leasePath } from "./workspace-quiescence-scripts.test-support.js";

describe("remote workspace quiescence resume deadline", () => {
  it("bounds a stalled pass while allowing healthy high-cardinality progress", async () => {
    const input = await fixture();
    const nonce = "a".repeat(32);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const processReference = { pid: process.pid, start: "stalled process" };
    await fs.mkdir(path.dirname(leaseFile), { recursive: true });
    await fs.writeFile(
      leaseFile,
      JSON.stringify({
        version: 1,
        nonce,
        processes: Array.from({ length: 4_096 }, () => processReference),
        watchdog: null,
        expiresAtMs: Date.now() + 60_000,
      }),
    );
    await fs.writeFile(input.stalledAllProcessProbePath, "stall all identity probes\n");

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
    expect(retained.processes).toHaveLength(4_096);
    expect(retained.recovery?.state).toBe("probe-timeout");

    await fs.rm(input.stalledAllProcessProbePath, { force: true });
    const healthyNonce = "b".repeat(32);
    const healthyLeaseFile = leasePath(input.home, input.workspace, healthyNonce);
    const preloadPath = path.join(input.home, "healthy-process-probe.cjs");
    await fs.writeFile(
      healthyLeaseFile,
      JSON.stringify({
        version: 1,
        nonce: healthyNonce,
        processes: Array.from({ length: 64 }, () => ({
          pid: process.pid,
          start: "healthy process",
        })),
        watchdog: null,
        expiresAtMs: Date.now() + 60_000,
      }),
    );
    await fs.writeFile(
      preloadPath,
      `const childProcess = require("node:child_process");
const originalExecFile = childProcess.execFile;
childProcess.execFile = function (file, args, options, callback) {
  if (file === "ps" && args[0] === "-o" && args[1] === "stat=,lstart=") {
    const timer = setTimeout(() => callback(null, "T healthy process\\n", ""), 700);
    return { stdout: null, stderr: null, kill: () => { clearTimeout(timer); return true; }, unref: () => {} };
  }
  return originalExecFile.call(this, file, args, options, callback);
};
`,
    );

    const healthyStartedAt = Date.now();
    const healthyResult = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, healthyNonce],
      {
        timeoutMs: 10_000,
        baseEnv: {
          ...input.env,
          NODE_OPTIONS: `${input.env.NODE_OPTIONS ?? ""} --require=${preloadPath}`.trim(),
        },
        killProcessTree: true,
      },
    );
    const healthyElapsedMs = Date.now() - healthyStartedAt;

    expect(healthyResult.termination).toBe("exit");
    expect(healthyResult.code, healthyResult.stderr).toBe(0);
    expect(healthyElapsedMs).toBeGreaterThan(5_000);
    expect(healthyElapsedMs).toBeLessThan(8_000);
    await expect(fs.access(healthyLeaseFile)).rejects.toThrow();
  }, 22_000);
});
