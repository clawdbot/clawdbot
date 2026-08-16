import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
  WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE,
} from "./workspace-quiescence-scripts.js";
import {
  expectProcessExited,
  expectProcessState,
  fixture,
  leasePath,
  processStart,
  quiesce,
  renew,
  resume,
  runQuiesce,
  terminate,
  useBatchedDelayedProcessFixture,
} from "./workspace-quiescence-scripts.test-support.js";

describe("remote workspace quiescence scripts", () => {
  it("keeps unrelated same-uid processes running on a declared shared host", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let nonce: string | undefined;

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      nonce = await quiesce(input, 10_000, 10_000, true);
      await renew(input, nonce, 10_000, true);
      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { processes: Array<{ pid: number }>; sharedHost: boolean };
      expect(lease).toMatchObject({ processes: [], sharedHost: true });
      await expectProcessState(childPid, false);
    } finally {
      if (nonce) {
        await resume(input, nonce);
      }
      await terminate(child);
      await fs.rm(input.extraProcessPath, { force: true });
    }
  });

  it("rejects a quiescence isolation-mode change during renewal", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 10_000, 10_000, true);

    try {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "20000",
          "final",
          "dedicated",
        ],
        { timeoutMs: 10_000, baseEnv: input.env },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence isolation mode changed");
    } finally {
      await resume(input, nonce);
    }
  });

  it("excludes its ps scanner and terminates its watchdog on resume", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const lease = JSON.parse(
      await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
    ) as {
      watchdog: { pid: number; start: string };
    };

    await resume(input, nonce);

    await expect(fs.access(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    await expectProcessExited(lease.watchdog.pid);
  });

  it("bounds watchdog startup across persistently stalled identity probes", async () => {
    const input = await fixture();
    await fs.writeFile(input.stalledAllProcessProbePath, "stall all identity probes\n");

    try {
      const startedAt = Date.now();
      const result = await runQuiesce(input, 1_000, 4_000);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence watchdog identity was not observable");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await fs.rm(input.stalledAllProcessProbePath, { force: true });
      try {
        const stalledPids = (await fs.readFile(input.stalledProcessProbePidPath, "utf8"))
          .trim()
          .split("\n")
          .map(Number);
        for (const pid of stalledPids) {
          if (pid > 0) {
            process.kill(pid, "SIGKILL");
          }
        }
      } catch {}
    }
  });

  it("recovers a prior nonce without letting its watchdog own the next lease", async () => {
    const input = await fixture();
    const firstNonce = await quiesce(input);
    const firstLease = JSON.parse(
      await fs.readFile(leasePath(input.home, input.workspace, firstNonce), "utf8"),
    ) as { watchdog: { pid: number; start: string } };

    const secondNonce = await quiesce(input);

    expect(secondNonce).not.toBe(firstNonce);
    await expect(fs.access(leasePath(input.home, input.workspace, firstNonce))).rejects.toThrow();
    await expect(
      fs.access(leasePath(input.home, input.workspace, secondNonce)),
    ).resolves.toBeUndefined();
    await expectProcessExited(firstLease.watchdog.pid);
    await resume(input, secondNonce);
  });

  it("recovers healthy later orphan leases before reporting an earlier failure", async () => {
    const input = await fixture();
    const failedChild = spawn("sleep", ["30"], { stdio: "ignore" });
    const healthyChild = spawn("sleep", ["30"], { stdio: "ignore" });
    const failedPid = failedChild.pid!;
    const healthyPid = healthyChild.pid!;
    const leaseDirectory = path.dirname(leasePath(input.home, input.workspace, "0".repeat(32)));
    let failedNonce = "";

    try {
      process.kill(failedPid, "SIGSTOP");
      process.kill(healthyPid, "SIGSTOP");
      await Promise.all([
        expectProcessState(failedPid, true),
        expectProcessState(healthyPid, true),
      ]);
      await fs.mkdir(leaseDirectory, { recursive: true });
      const nonces = ["0".repeat(32), "f".repeat(32)];
      for (const nonce of nonces) {
        await fs.writeFile(
          leasePath(input.home, input.workspace, nonce),
          `${JSON.stringify({
            version: 1,
            nonce,
            processes: [],
            watchdog: null,
            expiresAtMs: Date.now() + 30_000,
          })}\n`,
        );
      }
      const orphanNames = (await fs.readdir(leaseDirectory)).filter((name) =>
        name.endsWith(".json"),
      );
      const firstNonce = orphanNames[0]!.split(".")[1]!;
      const secondNonce = orphanNames[1]!.split(".")[1]!;
      failedNonce = firstNonce;
      const leases = [
        { nonce: firstNonce, pid: failedPid, start: await processStart(failedPid) },
        { nonce: secondNonce, pid: healthyPid, start: await processStart(healthyPid) },
      ];
      for (const lease of leases) {
        await fs.writeFile(
          leasePath(input.home, input.workspace, lease.nonce),
          `${JSON.stringify({
            version: 1,
            nonce: lease.nonce,
            processes: [{ pid: lease.pid, start: lease.start }],
            watchdog: null,
            expiresAtMs: Date.now() + 30_000,
          })}\n`,
        );
      }
      await fs.writeFile(input.failedProcessProbeTargetPath, `${failedPid}\n`);

      const result = await runQuiesce(input);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence orphan recovery failed");
      await expectProcessState(healthyPid, false);
      await expect(
        fs.access(leasePath(input.home, input.workspace, secondNonce)),
      ).rejects.toThrow();
      const retained = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, failedNonce), "utf8"),
      ) as { processes: Array<{ pid: number }>; recovery?: { state: string } };
      expect(retained.processes.map((entry) => entry.pid)).toEqual([failedPid]);
      expect(retained.recovery?.state).toBe("recovery-failed");

      await fs.rm(input.failedProcessProbeTargetPath, { force: true });
      await resume(input, failedNonce, WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
      await expectProcessState(failedPid, true);
    } finally {
      await fs.rm(input.failedProcessProbeTargetPath, { force: true });
      if (failedNonce) {
        try {
          await resume(input, failedNonce);
        } catch {}
      }
      await Promise.all([terminate(failedChild), terminate(healthyChild)]);
    }
  }, 20_000);

  it("uses bounded recovery when quiescence fails after stopping a process", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      await fs.writeFile(input.failedProcessScanPath, "fail after first scan\n");

      const result = await runQuiesce(input);

      expect(result.code).not.toBe(0);
      expect(
        (await fs.readFile(input.failedProcessScanStatePath, "utf8")).trim().startsWith("T"),
      ).toBe(true);
      await expectProcessState(childPid, false);
      const leaseDirectory = path.join(input.home, ".openclaw-worker", "quiescence");
      const leases = (await fs.readdir(leaseDirectory)).filter((name) => name.endsWith(".json"));
      expect(leases).toEqual([]);
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.failedProcessScanPath, { force: true });
      await fs.rm(`${input.failedProcessScanPath}.seen`, { force: true });
      await terminate(child);
    }
  }, 15_000);

  it("reaches terminal recovery within one global deadline across persistent probe batches", async () => {
    const input = await fixture();
    const children = Array.from({ length: 24 }, () => spawn("sleep", ["30"], { stdio: "ignore" }));
    const childPids = children.map((child) => child.pid!);
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPids.join("\n")}\n`);
      nonce = await quiesce(input, 30_000, 20_000);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${childPids.join("\n")}\n`);

      const startedAt = Date.now();
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      const terminal = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as {
        watchdog: unknown;
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      expect(terminal.watchdog).toBeNull();
      expect(terminal.processes.map((entry) => entry.pid)).toEqual(childPids);
      expect(terminal.recovery?.state).toBe("probe-timeout");

      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await resume(input, nonce, WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await Promise.all(children.map(async (child) => await terminate(child)));
    }
  }, 35_000);

  it("keeps failed quiescence recovery terminal across automatic retries", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      await fs.writeFile(input.failedProcessScanPath, "fail after first scan\n");
      await fs.writeFile(input.failedProcessProbeTargetPath, `${childPid}\n`);

      const result = await runQuiesce(input);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "workspace quiescence recovery failed; lease retained for operator recovery",
      );
      const leaseDirectory = path.join(input.home, ".openclaw-worker", "quiescence");
      const leases = (await fs.readdir(leaseDirectory)).filter((name) => name.endsWith(".json"));
      expect(leases).toHaveLength(1);
      const terminalLeasePath = path.join(leaseDirectory, leases[0]!);
      const terminal = JSON.parse(await fs.readFile(terminalLeasePath, "utf8")) as {
        nonce: string;
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      nonce = terminal.nonce;
      expect(terminal.processes.map((entry) => entry.pid)).toEqual([childPid]);
      expect(terminal.recovery?.state).toBe("recovery-failed");

      await fs.rm(input.failedProcessProbeTargetPath, { force: true });
      process.kill(childPid, "SIGSTOP");
      await expectProcessState(childPid, true);
      const retry = await runQuiesce(input);
      expect(retry.code).toBe(WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
      await resume(input, nonce, WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
      await expectProcessState(childPid, true);
      await expect(fs.access(terminalLeasePath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.failedProcessProbeTargetPath, { force: true });
      await fs.rm(input.failedProcessScanPath, { force: true });
      await fs.rm(`${input.failedProcessScanPath}.seen`, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await terminate(child);
    }
  }, 15_000);

  it("proves the lease is active and renews its watchdog deadline", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number; start: string };
    };

    await fs.writeFile(input.stalledProcessProbeOnceTargetPath, `${before.watchdog.pid}\n`);
    await renew(input, nonce);
    await expect(fs.access(input.stalledProcessProbeOnceTargetPath)).rejects.toThrow();

    const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
    };
    expect(after.expiresAtMs).toBeGreaterThan(before.expiresAtMs);
    await resume(input, nonce);
  });

  it("rejects renewal when the watchdog identity is a zombie", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 30_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number };
    };

    try {
      await fs.writeFile(input.zombieProcessProbeTargetPath, `${before.watchdog.pid}\n`);
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "60000",
        ],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence watchdog is not active");
      const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
      };
      expect(after.expiresAtMs).toBe(before.expiresAtMs);
    } finally {
      await fs.rm(input.zombieProcessProbeTargetPath, { force: true });
      await resume(input, nonce);
    }
  });

  it("rejects renewal when the watchdog is stopped", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 30_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number };
    };

    try {
      process.kill(before.watchdog.pid, "SIGSTOP");
      await expectProcessState(before.watchdog.pid, true);
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "60000",
        ],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence watchdog is not active");
      const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
      };
      expect(after.expiresAtMs).toBe(before.expiresAtMs);
    } finally {
      try {
        await resume(input, nonce);
        await expectProcessExited(before.watchdog.pid);
      } finally {
        try {
          process.kill(before.watchdog.pid, "SIGKILL");
        } catch {}
      }
    }
  });

  it("renews the maximum process set with the first-heartbeat lifetime", async () => {
    const input = await fixture();
    const child = spawn("sleep", ["120"], { stdio: "ignore" });
    const childPid = child.pid!;
    let nonce = "";

    try {
      nonce = await quiesce(input, 12 * 60_000);
      process.kill(childPid, "SIGSTOP");
      await expectProcessState(childPid, true);
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
        processes: Array<{ pid: number; start: string }>;
      };
      const reference = { pid: childPid, start: await processStart(childPid) };
      lease.expiresAtMs = Date.now() + (12 * 60_000 - 3 * 60_000);
      lease.processes = Array.from({ length: 4096 }, () => reference);
      await fs.writeFile(leaseFile, `${JSON.stringify(lease)}\n`);
      const fastProbeScript = `
const childProcessModule = require("node:child_process");
const originalExecFile = childProcessModule.execFile;
childProcessModule.execFile = function (file, args, options, callback) {
  if (args.at(-1) === ${JSON.stringify(String(childPid))}) {
    queueMicrotask(() => callback(null, ${JSON.stringify(`T ${reference.start}\n`)}, ""));
    return { stdout: null, stderr: null, kill: () => true, unref: () => {} };
  }
  return originalExecFile.call(this, file, args, options, callback);
};
${REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS}`;

      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          fastProbeScript,
          input.workspace,
          nonce,
          String(12 * 60_000),
          "heartbeat",
        ],
        { timeoutMs: 60_000, baseEnv: input.env },
      );

      expect(result.code, result.stderr).toBe(0);
      const renewed = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
      };
      expect(renewed.expiresAtMs).toBeGreaterThan(lease.expiresAtMs);
      await expectProcessState(childPid, true);
    } finally {
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await terminate(child);
    }
  }, 75_000);

  it("renews a zero-process lease using only the watchdog validation budget", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 30_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);

    try {
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
        processes: Array<{ pid: number; start: string }>;
      };
      expect(lease.processes).toEqual([]);
      lease.expiresAtMs = Date.now() + 7_000;
      await fs.writeFile(leaseFile, `${JSON.stringify(lease)}\n`);

      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "30000",
        ],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code, result.stderr).toBe(0);
      const renewed = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
      };
      expect(renewed.expiresAtMs).toBeGreaterThan(lease.expiresAtMs);
    } finally {
      await resume(input, nonce);
    }
  });

  it("caps watchdog validation after fast high-cardinality process validation", async () => {
    const input = await fixture();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const childPid = child.pid!;
    let nonce = "";

    try {
      nonce = await quiesce(input, 60_000);
      process.kill(childPid, "SIGSTOP");
      await expectProcessState(childPid, true);
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
        watchdog: { pid: number };
        processes: Array<{ pid: number; start: string }>;
      };
      const reference = { pid: childPid, start: await processStart(childPid) };
      before.expiresAtMs = Date.now() + 30_000;
      before.processes = Array.from({ length: 64 }, () => reference);
      await fs.writeFile(leaseFile, `${JSON.stringify(before)}\n`);
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${before.watchdog.pid}\n`);
      const fastProcessProbeScript = `
const childProcessModule = require("node:child_process");
const originalExecFile = childProcessModule.execFile;
childProcessModule.execFile = function (file, args, options, callback) {
  if (args.at(-1) === ${JSON.stringify(String(childPid))}) {
    queueMicrotask(() => callback(null, ${JSON.stringify(`T ${reference.start}\n`)}, ""));
    return { stdout: null, stderr: null, kill: () => true, unref: () => {} };
  }
  return originalExecFile.call(this, file, args, options, callback);
};
${REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS}`;

      const startedAt = Date.now();
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          fastProcessProbeScript,
          input.workspace,
          nonce,
          "60000",
          "heartbeat",
        ],
        { timeoutMs: 20_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence watchdog identity probe timed out");
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
      };
      expect(after.expiresAtMs).toBe(before.expiresAtMs);
      await expectProcessState(childPid, true);
    } finally {
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await terminate(child);
    }
  }, 35_000);

  it("uses a bounded count-aware deadline to quiesce and resume many processes", async () => {
    const input = await fixture();
    await useBatchedDelayedProcessFixture(input);
    const children = Array.from({ length: 64 }, () => spawn("sleep", ["30"], { stdio: "ignore" }));
    const childPids = children.map((child) => child.pid!);
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPids.join("\n")}\n`);
      await fs.writeFile(input.delayedProcessProbeTargetPath, `${childPids.join("\n")}\n`);

      nonce = await quiesce(input, 30_000, 30_000);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
      await renew(input, nonce, 30_000);
      await resume(input, nonce);
      nonce = "";
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, false)));
    } finally {
      await fs.rm(input.delayedProcessProbeTargetPath, { force: true });
      await fs.rm(input.extraProcessPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await Promise.all(children.map(async (child) => await terminate(child)));
    }
  }, 60_000);

  it("rejects renewal before high-cardinality validation can outlive the lease", async () => {
    const input = await fixture();
    await useBatchedDelayedProcessFixture(input);
    const children = Array.from({ length: 64 }, () => spawn("sleep", ["30"], { stdio: "ignore" }));
    const childPids = children.map((child) => child.pid!);
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPids.join("\n")}\n`);
      nonce = await quiesce(input, 20_000, 30_000);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
        watchdog: { pid: number };
      };
      const waitMs = before.expiresAtMs - Date.now() - 11_000;
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, waitMs);
        });
      }
      await fs.writeFile(input.delayedProcessProbeTargetPath, `${childPids.join("\n")}\n`);
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${before.watchdog.pid}\n`);

      const startedAt = Date.now();
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          input.workspace,
          nonce,
          "20000",
        ],
        { timeoutMs: 20_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence lease is no longer active");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        expiresAtMs: number;
      };
      expect(after.expiresAtMs).toBe(before.expiresAtMs);
      await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
    } finally {
      await fs.rm(input.delayedProcessProbeTargetPath, { force: true });
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await fs.rm(input.extraProcessPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await Promise.all(children.map(async (child) => await terminate(child)));
    }
  }, 60_000);

  it("stops a writable process that appeared after the workspace was quiesced", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    const heartbeat = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
        input.workspace,
        nonce,
        "20000",
        "heartbeat",
      ],
      { timeoutMs: 10_000, baseEnv: input.env },
    );
    expect(heartbeat.code).toBe(0);

    try {
      await fs.writeFile(input.stalledProcessProbeOnceTargetPath, `${child.pid}\n`);
      await renew(input, nonce);

      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { processes: Array<{ pid: number }> };
      expect(lease.processes.some((entry) => entry.pid === child.pid)).toBe(true);
      await fs.writeFile(input.stalledProcessProbeOnceTargetPath, `${child.pid}\n`);
      await renew(input, nonce);
      await expect(fs.access(input.stalledProcessProbeOnceTargetPath)).rejects.toThrow();
    } finally {
      await resume(input, nonce);
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.stalledProcessProbeOnceTargetPath, { force: true });
    }
  });

  it("fails closed when the watchdog lease no longer exists", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    await resume(input, nonce);

    const result = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce],
      { timeoutMs: 10_000, baseEnv: input.env },
    );
    expect(result.code).not.toBe(0);
  });

  it("retries a transient stalled process probe during explicit resume", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      nonce = await quiesce(input);
      await expectProcessState(childPid, true);
      await fs.writeFile(input.stalledProcessProbeOnceTargetPath, `${childPid}\n`);

      await resume(input, nonce);

      await expectProcessState(childPid, false);
      await expect(fs.access(input.stalledProcessProbeOnceTargetPath)).rejects.toThrow();
      await expect(fs.access(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.stalledProcessProbeOnceTargetPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await terminate(child);
    }
  }, 15_000);

  it("records a watchdog probe timeout while resuming healthy processes", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let nonce = "";

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      nonce = await quiesce(input, 30_000, 20_000);
      await expectProcessState(childPid, true);
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: { pid: number; start: string };
      };
      await fs.writeFile(input.stalledProcessProbeTargetPath, `${lease.watchdog.pid}\n`);

      const startedAt = Date.now();
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("workspace quiescence recovery timed out");
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      await expectProcessState(childPid, false);
      const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: { pid: number; start: string };
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      expect(terminal.watchdog).toEqual(lease.watchdog);
      expect(terminal.processes).toEqual([]);
      expect(terminal.recovery?.state).toBe("probe-timeout");

      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await resume(input, nonce, WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
      process.kill(lease.watchdog.pid, "SIGKILL");
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      if (nonce) {
        try {
          await resume(input, nonce);
        } catch {}
      }
      await terminate(child);
    }
  }, 15_000);

  it("retries a signal-resistant stalled watchdog process probe before releasing the lease", async () => {
    const input = await fixture();
    const nonce = await quiesce(input, 1_000);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      watchdog: { pid: number; start: string };
    };
    await fs.writeFile(
      leaseFile,
      JSON.stringify({
        ...lease,
        expiresAtMs: Date.now() + 1_000,
        processes: [{ pid: process.pid, start: await processStart(process.pid) }],
      }),
    );
    await fs.writeFile(input.stalledProcessProbePath, "stall\n");

    let stalledPid = 0;
    try {
      await vi.waitFor(
        async () => {
          stalledPid = Number((await fs.readFile(input.stalledProcessProbePidPath, "utf8")).trim());
          expect(stalledPid).toBeGreaterThan(0);
        },
        { interval: 50, timeout: 2_500 },
      );
      await vi.waitFor(
        async () => {
          await expect(fs.access(leaseFile)).rejects.toThrow();
        },
        { interval: 50, timeout: 4_000 },
      );
    } finally {
      try {
        process.kill(lease.watchdog.pid, "SIGKILL");
      } catch {}
      if (stalledPid > 0) {
        try {
          process.kill(stalledPid, "SIGKILL");
        } catch {}
      }
    }
  }, 6_000);

  it.each([
    {
      probePath: "stalledProcessProbeTargetPath" as const,
      recoveryState: "probe-timeout",
      message: "workspace quiescence recovery timed out",
      healthyCount: 1,
    },
    {
      probePath: "failedProcessProbeTargetPath" as const,
      recoveryState: "recovery-failed",
      message: "workspace quiescence recovery failed",
      healthyCount: 9,
    },
  ])(
    "records $recoveryState without blocking identity-matched processes",
    async ({ probePath, recoveryState, message, healthyCount }) => {
      const input = await fixture();
      const nonce = await quiesce(input, 30_000);
      const leaseFile = leasePath(input.home, input.workspace, nonce);
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: { pid: number; start: string };
      };
      const children = Array.from({ length: healthyCount + 1 }, () =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
      );
      const childPids = children.map((child) => child.pid!);
      const stalledPid = childPids[0]!;
      const healthyPids = childPids.slice(1);
      const targetPath = input[probePath];

      try {
        const entries = await Promise.all(
          childPids.map(async (pid) => ({ pid, start: await processStart(pid) })),
        );
        childPids.forEach((pid) => process.kill(pid, "SIGSTOP"));
        await Promise.all(childPids.map(async (pid) => await expectProcessState(pid, true)));
        await fs.writeFile(
          leaseFile,
          JSON.stringify({
            ...lease,
            expiresAtMs: Date.now() + 1_000,
            processes: entries,
          }),
        );
        await fs.writeFile(targetPath, `${stalledPid}\n`);

        const recoveryResult = await runCommandWithTimeout(
          [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
          { timeoutMs: 10_000, baseEnv: input.env },
        );
        expect(recoveryResult.code).toBe(WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
        expect(recoveryResult.stderr).toContain(message);
        await Promise.all(
          healthyPids.map(async (pid) => await expectProcessState(pid, false, 8_000)),
        );
        await vi.waitFor(
          async () => {
            const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
              watchdog: unknown;
              processes: Array<{ pid: number }>;
              recovery?: { state: string; failedAtMs: number };
            };
            expect(terminal.watchdog).toBeNull();
            expect(terminal.processes.map((entry) => entry.pid)).toEqual([stalledPid]);
            expect(terminal.recovery).toMatchObject({
              state: recoveryState,
              failedAtMs: expect.any(Number),
            });
          },
          { interval: 50, timeout: 8_000 },
        );
        await expectProcessState(stalledPid, true);

        const renewResult = await runCommandWithTimeout(
          [
            process.execPath,
            "-e",
            REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
            input.workspace,
            nonce,
            "20000",
          ],
          { timeoutMs: 10_000, baseEnv: input.env },
        );
        expect(renewResult.code).toBe(WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
        expect(renewResult.stderr).toContain(message);

        const failedResume = await runCommandWithTimeout(
          [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
          { timeoutMs: 8_000, baseEnv: input.env },
        );
        expect(failedResume.code).toBe(WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
        expect(failedResume.stderr).toContain(message);
        await expect(fs.access(leaseFile)).resolves.toBeUndefined();

        await fs.rm(targetPath, { force: true });
        await resume(input, nonce, WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
        await expectProcessState(stalledPid, true);
        await expect(fs.access(leaseFile)).resolves.toBeUndefined();
      } finally {
        await fs.rm(targetPath, { force: true });
        try {
          await resume(input, nonce);
        } catch {}
        try {
          process.kill(lease.watchdog.pid, "SIGKILL");
        } catch {}
        await Promise.all(children.map(async (child) => await terminate(child)));
      }
    },
    20_000,
  );
});
