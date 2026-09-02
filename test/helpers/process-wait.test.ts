import { spawn } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForFile,
  waitForPidFile,
} from "./process-wait.js";
import { withTestTimeout } from "./promise.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  { name: "file", wait: waitForFile, expected: undefined },
  { name: "PID", wait: waitForPidFile, expected: 42 },
])("$name readiness", ({ wait, expected }) => {
  it("observes readiness after a delayed wake crosses the deadline", async () => {
    vi.useFakeTimers();
    const file = path.join(tempDirs.make("openclaw-process-wait-"), "ready");
    const result = wait(file, 20).catch((error: unknown) => error);

    // The producer finishes while the waiting worker cannot run its pending poll.
    fsSync.writeFileSync(file, "42\n");
    vi.setSystemTime(Date.now() + 25);
    await vi.advanceTimersByTimeAsync(5);
    expect(await result).toBe(expected);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a file still missing when the deadline passes", async () => {
    vi.useFakeTimers();
    const file = path.join(tempDirs.make("openclaw-process-wait-"), "missing");
    const result = wait(file, 20).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ message: expect.stringContaining("timeout waiting for") });
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each(["", "invalid", "0", "-1"])("rejects PID contents %j at the deadline", async (contents) => {
  vi.useFakeTimers();
  const file = path.join(tempDirs.make("openclaw-process-wait-"), "pid");
  fsSync.writeFileSync(file, contents);
  const result = waitForPidFile(file, 20).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(20);
  expect(await result).toEqual(new Error(`timeout waiting for pid in ${file}`));
  expect(vi.getTimerCount()).toBe(0);
});

it("waits through an open-truncate window for valid PID contents", async () => {
  vi.useFakeTimers();
  const file = path.join(tempDirs.make("openclaw-process-wait-"), "pid");
  fsSync.writeFileSync(file, "");
  let settled = false;
  const result = waitForPidFile(file, 20)
    .finally(() => {
      settled = true;
    })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(5);
  expect(settled).toBe(false);
  fsSync.writeFileSync(file, "42\n");
  await vi.advanceTimersByTimeAsync(5);
  expect(await result).toBe(42);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops waiting when a Linux process is a zombie", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath) => {
    if (String(filePath) === "/proc/42/status") {
      return "Name:\tworker\nState:\tZ (zombie)\nPid:\t42\n";
    }
    throw new Error(`unexpected read: ${String(filePath)}`);
  });

  await expect(waitForDead(42, 20)).resolves.toBeUndefined();
});

it("rejects when the process remains alive at the deadline", async () => {
  await expect(waitForDead(process.pid, 20)).rejects.toThrow(`process still alive: ${process.pid}`);
});

it("rechecks process death after a worker stall crosses the polling deadline", async () => {
  // A separate controller can reap the real child while this worker is stalled.
  const controller = spawn(
    process.execPath,
    [
      "-e",
      `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); process.send(process.pid);'], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
process.on('message', () => child.kill('SIGKILL'));
child.once('message', pid => process.send(pid));
child.once('close', (_code, signal) => {
  if (signal !== 'SIGKILL') throw new Error('child was not killed');
  process.disconnect();
});
`,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const closed = waitForChildClose(controller);
  const nativeKill = process.kill.bind(process);
  let childPid: number | undefined;
  try {
    const [pid] = await withTestTimeout(once(controller, "message"), 2_000, "child not ready");
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      throw new Error("child did not publish a valid PID");
    }
    childPid = pid;
    let observedAlive = false;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      const result = nativeKill(target, signal);
      if (target === childPid && signal === 0 && !observedAlive) {
        observedAlive = true;
        controller.send("kill");
        // Preserve the real live observation, but delay the next poll past its deadline.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
      }
      return result;
    });
    let waitError: unknown;
    try {
      await waitForDead(childPid, 2_000);
    } catch (error) {
      waitError = error;
    } finally {
      killSpy.mockRestore();
    }
    expect(observedAlive).toBe(true);
    expect(() => nativeKill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(waitError).toBeUndefined();
    await expect(closed).resolves.toEqual({ code: 0, signal: null });
  } finally {
    try {
      if (controller.connected) {
        controller.send("kill");
      }
      await closed;
    } finally {
      try {
        if (controller.pid && isProcessAlive(controller.pid)) {
          controller.kill("SIGKILL");
          await waitForDead(controller.pid, 2_000);
        }
      } finally {
        if (childPid !== undefined && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
          await waitForDead(childPid, 2_000);
        }
      }
    }
  }
});
