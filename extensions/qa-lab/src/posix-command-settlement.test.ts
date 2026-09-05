import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaPosixCommandSettlement } from "./posix-command-settlement.js";

type TestOutcome = Parameters<Parameters<typeof createQaPosixCommandSettlement>[0]["onSettled"]>[0];

function createChild() {
  const child = new EventEmitter() as ChildProcess;
  const childKill = vi.fn(() => true);
  const stderrDestroy = vi.fn();
  const stdoutDestroy = vi.fn();
  Object.defineProperty(child, "pid", { value: 42 });
  child.stdout = Object.assign(new EventEmitter(), { destroy: stdoutDestroy }) as never;
  child.stderr = Object.assign(new EventEmitter(), { destroy: stderrDestroy }) as never;
  child.kill = childKill as ChildProcess["kill"];
  return { child, childKill, stderrDestroy, stdoutDestroy };
}

describe("POSIX command settlement", () => {
  let processGroupAlive: boolean;
  let processKill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    processGroupAlive = false;
    processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== -42) {
        return true;
      }
      if (signal === 0 && !processGroupAlive) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      if (signal === "SIGKILL") {
        processGroupAlive = false;
      }
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function start(
    params: {
      executionTimeoutMs?: number;
      onSettled?: (outcome: TestOutcome) => void;
    } = {},
  ) {
    const childFixture = createChild();
    const { child } = childFixture;
    const settled = vi.fn(params.onSettled);
    const controller = createQaPosixCommandSettlement({
      child,
      settlementFailureMessage: "settlement failed",
      executionTimeoutMs: params.executionTimeoutMs,
      forceKillAfterMs: 20,
      initialSignal: "SIGTERM",
      onSettled: settled,
      processGroupId: 42,
      verifyAfterMs: 10,
    });
    return { ...childFixture, controller, settled };
  }

  it("keeps the exit tuple, resets only idle, and disposes listeners once", async () => {
    const { child, settled } = start();

    child.emit("exit", 7, null);
    await vi.advanceTimersByTimeAsync(90);
    child.stdout?.emit("data", Buffer.from("tail"));
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", 7, null);

    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith({
      primary: { type: "exit", exitCode: 7, signal: null },
    });
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    child.emit("close", 7, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toHaveBeenCalledOnce();
  });

  it("caps active output at one second and destroys readers only after cleanup", async () => {
    processGroupAlive = true;
    const { child, settled, stderrDestroy, stdoutDestroy } = start();
    child.emit("exit", 0, null);

    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(90);
      child.stdout?.emit("data", Buffer.from(String(index)));
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(stdoutDestroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(stdoutDestroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(processKill).toHaveBeenCalledWith(-42, "SIGKILL");
    await vi.advanceTimersByTimeAsync(10);

    expect(stdoutDestroy).toHaveBeenCalledOnce();
    expect(stderrDestroy).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith({
      settlementFailure: expect.objectContaining({ message: "stdio-drain-timeout" }),
      primary: { type: "exit", exitCode: 0, signal: null },
    });
  });

  it("preserves the timeout primary when process-group signaling fails", async () => {
    processGroupAlive = true;
    processKill.mockImplementation((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid === -42 && signal !== 0) {
        throw Object.assign(new Error(`cannot send ${String(signal)}`), { code: "EPERM" });
      }
      return true;
    });
    const { child, childKill, settled } = start({ executionTimeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(30);

    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0]?.[0]).toMatchObject({
      primary: { type: "timeout" },
      settlementFailure: expect.any(Error),
    });
    expect(childKill).not.toHaveBeenCalled();
  });

  it("bounds stdio draining when a timeout cleans the group without close", async () => {
    const { settled, stderrDestroy, stdoutDestroy } = start({ executionTimeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(1_099);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(stdoutDestroy).toHaveBeenCalledOnce();
    expect(stderrDestroy).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith({
      settlementFailure: expect.objectContaining({ message: "stdio-drain-timeout" }),
      primary: { type: "timeout" },
    });
  });

  it("preserves a stream failure that follows a successful exit", async () => {
    const { child, settled } = start();
    const streamFailure = new Error("stdout pipe failed");

    child.emit("exit", 0, null);
    child.stdout?.emit("error", streamFailure);
    child.emit("close", 0, null);

    expect(settled).toHaveBeenCalledWith({
      primary: { type: "exit", exitCode: 0, signal: null },
      settlementFailure: expect.objectContaining({
        cause: streamFailure,
        message: "stdout stream error: stdout pipe failed",
      }),
    });
  });
});
