import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const actualSpawn = vi.hoisted(
  () =>
    ({
      value: undefined,
    }) as {
      value: typeof import("node:child_process").spawn | undefined;
    },
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  actualSpawn.value = actual.spawn;
  return {
    ...actual,
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
  };
});

import {
  resetQaScenarioCommandCleanupTimings,
  runQaScenarioCommandLifecycle,
  setQaScenarioCommandCleanupTimings,
} from "./test-file-scenario-command-lifecycle.js";

type ParentSignal = "SIGINT" | "SIGTERM";
type ParentHandler = (() => void) | ((signal: ParentSignal) => void);

function spyOnProcessKill() {
  return vi.spyOn(process, "kill");
}

function createChild(pid = 42) {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: pid });
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as never;
  child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as never;
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  spawnMock.mockReturnValue(child);
  return child;
}

function runCommand(timeoutMs?: number) {
  return runQaScenarioCommandLifecycle({
    command: "/usr/local/bin/scenario-command",
    args: ["--run"],
    cwd: "/tmp/qa",
    env: { OPENCLAW_QA_REF: "test" },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidFile(filePath: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(filePath, "utf8").catch(() => "");
    if (/^[1-9]\d*$/u.test(value.trim())) {
      return Number(value.trim());
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for pid file ${filePath}`);
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

describe.skipIf(process.platform === "win32")("qa scenario command real POSIX lifecycle", () => {
  afterEach(() => {
    resetQaScenarioCommandCleanupTimings();
    spawnMock.mockReset();
  });

  it("settles within a bound after the leader writes its final result with inherited stdio open", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qa-command-settlement-"));
    const descendantPidPath = path.join(root, "descendant.pid");
    let descendantPid: number | undefined;
    spawnMock.mockImplementation((...args: Parameters<NonNullable<typeof actualSpawn.value>>) => {
      if (!actualSpawn.value) {
        throw new Error("real spawn unavailable");
      }
      return actualSpawn.value(...args);
    });
    setQaScenarioCommandCleanupTimings({ killGraceMs: 100, forceSettleMs: 100 });
    try {
      const descendantScript = [
        "const { writeFileSync } = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        "setTimeout(() => process.stdout.write('delayed descendant output\\n'), 40);",
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const leaderScript = [
        "const { spawn } = require('node:child_process');",
        "const { existsSync } = require('node:fs');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();`,
        `const ready = setInterval(() => { if (!existsSync(${JSON.stringify(descendantPidPath)})) return; clearInterval(ready); process.stdout.write('Docker scheduling finished\\n', () => process.exit(7)); }, 5);`,
      ].join("\n");

      const pending = runQaScenarioCommandLifecycle({
        command: process.execPath,
        args: ["-e", leaderScript],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
      });
      descendantPid = await waitForPidFile(descendantPidPath);
      const startedAt = Date.now();
      const deadline = new AbortController();
      const result = await Promise.race([
        pending,
        sleep(1_500, undefined, { signal: deadline.signal }).then(() => {
          throw new Error("command did not settle after process-group cleanup");
        }),
      ]).finally(() => deadline.abort());

      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(result).toEqual({
        exitCode: 7,
        signal: null,
        stdout: "Docker scheduling finished\ndelayed descendant output\n",
        stderr: "",
      });
      if (descendantPid === undefined) {
        throw new Error("scenario command descendant did not expose its pid");
      }
      expect(isProcessRunning(descendantPid)).toBe(false);
    } finally {
      if (descendantPid && isProcessRunning(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports that a self-detached descendant escaped and cleans it explicitly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qa-command-setsid-escape-"));
    const descendantPidPath = path.join(root, "descendant.pid");
    let descendantPid: number | undefined;
    spawnMock.mockImplementation((...args: Parameters<NonNullable<typeof actualSpawn.value>>) => {
      if (!actualSpawn.value) {
        throw new Error("real spawn unavailable");
      }
      return actualSpawn.value(...args);
    });
    try {
      const descendantScript = [
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        "process.stdout.write('escaped descendant output\\n');",
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const leaderScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();`,
        "process.exit(0);",
      ].join("\n");

      const result = await runQaScenarioCommandLifecycle({
        command: process.execPath,
        args: ["-e", leaderScript],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
      });

      descendantPid = await waitForPidFile(descendantPidPath);
      expect(result.exitCode).toBe(1);
      expect(result.failureMessage).toBe("stdio-drain-timeout");
      expect(result.stdout).toContain("escaped descendant output");
      expect(isProcessRunning(descendantPid)).toBe(true);
    } finally {
      // A true setsid descendant is outside the original PGID by design.
      if (descendantPid && isProcessRunning(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
        await waitForProcessExit(descendantPid).catch(() => undefined);
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cleans the command group before re-raising a parent SIGTERM", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "qa-command-parent-signal-"));
    const descendantPidPath = path.join(root, "descendant.pid");
    const bundlePath = path.join(root, "test-file-scenario-command-lifecycle.mjs");
    // Compile before the readiness window; a cold tsx child can exceed it under the full QA suite.
    // The bundle needs only the UTF-16 helper behind this SDK import, not the full plugin runtime.
    await esbuild({
      alias: {
        "openclaw/plugin-sdk/text-utility-runtime": fileURLToPath(
          new URL("../../../packages/normalization-core/src/utf16-slice.ts", import.meta.url),
        ),
      },
      bundle: true,
      entryPoints: [
        fileURLToPath(new URL("./test-file-scenario-command-lifecycle.ts", import.meta.url)),
      ],
      format: "esm",
      outfile: bundlePath,
      platform: "node",
      target: "node22",
    });
    const moduleUrl = pathToFileURL(bundlePath).href;
    let descendantPid: number | undefined;
    if (!actualSpawn.value) {
      throw new Error("real spawn unavailable");
    }
    const controllerScript = [
      `import { runQaScenarioCommandLifecycle, setQaScenarioCommandCleanupTimings } from ${JSON.stringify(moduleUrl)};`,
      "setQaScenarioCommandCleanupTimings({ killGraceMs: 50, forceSettleMs: 50 });",
      "const nested = [",
      "  \"const { writeFileSync } = require('node:fs');\",",
      `  ${JSON.stringify(`writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`)},`,
      "  \"process.on('SIGTERM', () => {});\",",
      '  "setInterval(() => {}, 1000);",',
      "].join(' ');",
      "await runQaScenarioCommandLifecycle({",
      "  command: process.execPath,",
      "  args: ['-e', nested],",
      `  cwd: ${JSON.stringify(root)},`,
      "  env: process.env,",
      "  timeoutMs: 5000,",
      "});",
    ].join("\n");
    const controller = actualSpawn.value(
      process.execPath,
      ["--input-type=module", "-e", controllerScript],
      { cwd: process.cwd(), env: process.env, stdio: "ignore" },
    );
    try {
      descendantPid = await waitForPidFile(descendantPidPath, 10_000);
      controller.kill("SIGTERM");
      const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
        (resolve) => {
          controller.once("close", (code, nextSignal) => resolve([code, nextSignal]));
        },
      );

      expect(exitCode).toBeNull();
      expect(signal).toBe("SIGTERM");
      await waitForProcessExit(descendantPid);
    } finally {
      if (controller.exitCode === null && controller.signalCode === null) {
        controller.kill("SIGKILL");
      }
      if (descendantPid && isProcessRunning(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("qa scenario command lifecycle", () => {
  const parentHandlers = new Map<ParentSignal | "exit", ParentHandler>();
  let processKill: ReturnType<typeof spyOnProcessKill>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      parentHandlers.set(event as ParentSignal | "exit", listener as ParentHandler);
      return process;
    });
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      parentHandlers.set(event as ParentSignal | "exit", listener as ParentHandler);
      return process;
    });
    vi.spyOn(process, "removeListener").mockImplementation((event, listener) => {
      if (parentHandlers.get(event as ParentSignal | "exit") === listener) {
        parentHandlers.delete(event as ParentSignal | "exit");
      }
      return process;
    });
    processKill = spyOnProcessKill().mockImplementation((pid, signal) => {
      if (pid === -42 && signal === 0) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });
  });

  afterEach(() => {
    resetQaScenarioCommandCleanupTimings();
    parentHandlers.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the exact close result and removes parent handlers", async () => {
    const child = createChild();
    const resultPromise = runCommand(5_000);

    child.stdout?.emit("data", Buffer.from("out\n"));
    child.stderr?.emit("data", Buffer.from("err\n"));
    child.emit("exit", 3, null);
    child.emit("close", 3, null);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 3,
      signal: null,
      stdout: "out\n",
      stderr: "err\n",
    });
    expect(spawnMock).toHaveBeenCalledWith("/usr/local/bin/scenario-command", ["--run"], {
      cwd: "/tmp/qa",
      detached: true,
      env: { OPENCLAW_QA_REF: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(parentHandlers.size).toBe(0);
    expect(processKill).toHaveBeenCalledWith(-42, 0);
    processKill.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(processKill).not.toHaveBeenCalled();
  });

  it("preserves spawn rejection without installing lifecycle handlers", async () => {
    const error = new Error("spawn failed");
    spawnMock.mockImplementationOnce(() => {
      throw error;
    });

    await expect(runCommand()).rejects.toBe(error);
    expect(parentHandlers.size).toBe(0);
  });

  it("preserves the Windows taskkill timeout lifecycle", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const originalSystemRoot = process.env.SystemRoot;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.SystemRoot = "C:\\Windows";
    spawnSyncMock.mockReturnValue({ status: 0 });
    createChild(12345);
    setQaScenarioCommandCleanupTimings({ killGraceMs: 20, forceSettleMs: 10 });
    try {
      const resultPromise = runCommand(100);
      await vi.advanceTimersByTimeAsync(130);

      await expect(resultPromise).resolves.toMatchObject({
        exitCode: 1,
        failureMessage: "scenario-command timed out after 100ms",
        signal: null,
      });
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(spawnSyncMock.mock.calls.map((call) => call[1])).toEqual([
        ["/PID", "12345", "/T"],
        ["/PID", "12345", "/T", "/F"],
      ]);
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      if (originalSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = originalSystemRoot;
      }
    }
  });

  it("escalates timed-out commands and preserves the timeout result", async () => {
    createChild();
    setQaScenarioCommandCleanupTimings({ killGraceMs: 20, forceSettleMs: 10 });
    let processGroupAlive = true;
    processKill.mockImplementation((pid, signal) => {
      if (pid === -42 && signal === "SIGKILL") {
        processGroupAlive = false;
      }
      if (pid === -42 && signal === 0 && !processGroupAlive) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });

    const resultPromise = runCommand(100);
    await vi.advanceTimersByTimeAsync(120);
    const child = spawnMock.mock.results[0]?.value as ChildProcess;
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 1,
      failureMessage: "scenario-command timed out after 100ms",
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(processKill).toHaveBeenCalledWith(-42, "SIGKILL");
    expect(parentHandlers.size).toBe(0);
  });

  it("forwards parent signals, cleans handlers, and preserves interruption details", async () => {
    createChild();
    setQaScenarioCommandCleanupTimings({ killGraceMs: 20, forceSettleMs: 10 });
    let processGroupAlive = true;
    processKill.mockImplementation((pid, signal) => {
      if (pid === -42 && signal === "SIGKILL") {
        processGroupAlive = false;
      }
      if (pid === -42 && signal === 0 && !processGroupAlive) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });

    const resultPromise = runCommand();
    const signalHandler = parentHandlers.get("SIGTERM") as
      | ((signal: ParentSignal) => void)
      | undefined;
    expect(signalHandler).toBeDefined();
    signalHandler?.("SIGTERM");
    await vi.advanceTimersByTimeAsync(20);
    const child = spawnMock.mock.results[0]?.value as ChildProcess;
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 1,
      failureMessage: "scenario-command interrupted by SIGTERM",
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });
    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(processKill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(parentHandlers.size).toBe(0);
  });
});
