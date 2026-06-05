// Gateway benchmark child test support simulates child process behavior for script tests.
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

type StopChildResult = {
  exitedBeforeTeardown: boolean;
  exitCode: number | null;
  signal: string | null;
};

type StopChild<TChild> = (
  child: TChild,
  options?: { killGraceMs?: number; teardownGraceMs?: number },
) => Promise<StopChildResult>;

export function registerStopChildBehaviorTests<TChild>(params: {
  stopChild: StopChild<TChild>;
  queuedExitCode: number;
}) {
  it("classifies queued child exits before sending teardown signals", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);

    const stopped = params.stopChild(child as unknown as TChild);
    queueMicrotask(() => {
      child.exitCode = params.queuedExitCode;
      child.emit("exit", params.queuedExitCode, null);
    });

    await expect(stopped).resolves.toEqual({
      exitedBeforeTeardown: true,
      exitCode: params.queuedExitCode,
      signal: null,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("classifies failed teardown signaling as a pre-teardown child exit", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      setImmediate(() => {
        child.exitCode = 8;
        child.emit("exit", 8, null);
      });
      return false;
    });

    await expect(params.stopChild(child as unknown as TChild)).resolves.toEqual({
      exitedBeforeTeardown: true,
      exitCode: 8,
      signal: null,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds teardown when the child ignores termination signals", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
      stderr: { destroy: ReturnType<typeof vi.fn> };
      stdin: { destroy: ReturnType<typeof vi.fn> };
      stdout: { destroy: ReturnType<typeof vi.fn> };
      unref: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    child.stderr = { destroy: vi.fn() };
    child.stdin = { destroy: vi.fn() };
    child.stdout = { destroy: vi.fn() };
    child.unref = vi.fn();

    await expect(
      params.stopChild(child as unknown as TChild, {
        killGraceMs: 1,
        teardownGraceMs: 1,
      }),
    ).resolves.toEqual({
      exitedBeforeTeardown: false,
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });
}
