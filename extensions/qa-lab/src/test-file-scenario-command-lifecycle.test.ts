import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
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
  child.stdout = new EventEmitter() as NonNullable<ChildProcess["stdout"]>;
  child.stderr = new EventEmitter() as NonNullable<ChildProcess["stderr"]>;
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

describe.skipIf(process.platform === "win32")("qa scenario command lifecycle", () => {
  const parentHandlers = new Map<ParentSignal | "exit", ParentHandler>();
  let processKill: ReturnType<typeof spyOnProcessKill>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
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
    await vi.advanceTimersByTimeAsync(130);

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
    await vi.advanceTimersByTimeAsync(30);

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
