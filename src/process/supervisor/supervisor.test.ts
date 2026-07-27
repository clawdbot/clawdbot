// Process supervisor tests cover lifecycle, restart, and termination behavior.
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import type { SpawnProcessAdapter } from "./types.js";

const { createChildAdapterMock, createPtyAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock: vi.fn(),
  createPtyAdapterMock: vi.fn(),
}));

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

vi.mock("./adapters/pty.js", () => ({
  createPtyAdapter: createPtyAdapterMock,
}));

let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;

type ProcessSupervisor = ReturnType<typeof createProcessSupervisor>;
type SpawnOptions = Parameters<ProcessSupervisor["spawn"]>[0];
type ChildSpawnOptions = Omit<Extract<SpawnOptions, { mode: "child" }>, "backendId" | "mode">;
type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;
type StubChildAdapter = ChildAdapter & {
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
  killMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
};

function createWriteStdoutArgv(output: string): string[] {
  if (process.platform === "win32") {
    return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`];
  }
  return ["/usr/bin/printf", "%s", output];
}

function createSilentIdleArgv(): string[] {
  return [process.execPath, "-e", "setInterval(() => {}, 1_000)"];
}

function createStubChildAdapter(options?: {
  pid?: number;
  onKill?: (signal: NodeJS.Signals | undefined, adapter: StubChildAdapter) => void;
}): StubChildAdapter {
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      resolveWait = resolve;
    },
  );
  const killMock = vi.fn();
  const disposeMock = vi.fn();
  const adapter: StubChildAdapter = {
    pid: options?.pid ?? 1234,
    stdin: undefined,
    onStdout: (listener) => {
      stdoutListeners.push(listener);
    },
    onStderr: (listener) => {
      stderrListeners.push(listener);
    },
    wait: async () => await waitPromise,
    kill: (signal) => {
      killMock(signal);
      options?.onKill?.(signal, adapter);
    },
    dispose: () => {
      disposeMock();
    },
    emitStdout: (chunk) => {
      for (const listener of stdoutListeners) {
        listener(chunk);
      }
    },
    emitStderr: (chunk) => {
      for (const listener of stderrListeners) {
        listener(chunk);
      }
    },
    settle: (code, signal = null) => {
      resolveWait?.({ code, signal });
      resolveWait = null;
    },
    killMock,
    disposeMock,
  };

  return adapter;
}

async function spawnChild(supervisor: ProcessSupervisor, options: ChildSpawnOptions) {
  return supervisor.spawn({
    ...options,
    backendId: "test",
    mode: "child",
  });
}

describe("process supervisor", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ createProcessSupervisor } = await import("./supervisor.js"));
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("spawns child runs and captures output", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createWriteStdoutArgv("ok"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    adapter.emitStdout("ok");
    adapter.settle(0);

    const exit = await run.wait();
    expect(exit.reason).toBe("exit");
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toBe("ok");
    expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
  });

  it("passes private secret input to the child adapter", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);
    const secretInput = {
      fd: 3,
      createData: () => Buffer.from("secret"),
    };

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createWriteStdoutArgv("ok"),
      secretInput,
    });
    adapter.settle(0);
    await run.wait();

    expect(createChildAdapterMock).toHaveBeenCalledWith(expect.objectContaining({ secretInput }));
  });

  it("enforces no-output timeout for silent processes", async () => {
    vi.useFakeTimers();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createSilentIdleArgv(),
      timeoutMs: 300,
      noOutputTimeoutMs: 5,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    await vi.advanceTimersByTimeAsync(5);

    const exit = await exitPromise;
    const expectedTimeoutSignal = process.platform === "win32" ? "SIGKILL" : "SIGTERM";
    expect(adapter.killMock).toHaveBeenCalledWith(expectedTimeoutSignal);
    if (process.platform !== "win32") {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");
    }
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it("coalesces overlapping Windows deadline cancellation while hard kill is pending", async () => {
    vi.useFakeTimers();
    mockProcessPlatform("win32");
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-windows-timeout-overlap",
      argv: createSilentIdleArgv(),
      timeoutMs: 20,
      noOutputTimeoutMs: 5,
      stdinMode: "pipe-closed",
    });
    const exitPromise = run.wait();

    await vi.advanceTimersByTimeAsync(5);
    expect(adapter.killMock).toHaveBeenCalledTimes(1);
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(15);
    expect(adapter.killMock).toHaveBeenCalledTimes(1);

    adapter.settle(null, "SIGKILL");
    const exit = await exitPromise;
    expect(exit.reason).toBe("no-output-timeout");
  });

  it("escalates cancellation to SIGKILL when graceful shutdown does not settle", async () => {
    vi.useFakeTimers();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        if (signal === "SIGKILL") {
          current.settle(null, signal);
        }
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createSilentIdleArgv(),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    run.cancel("manual-cancel");

    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(1);
    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(exit.reason).toBe("manual-cancel");
    expect(exit.exitSignal).toBe("SIGKILL");
  });

  it("cancels prior scoped run when replaceExistingScope is enabled", async () => {
    const first = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    const second = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const supervisor = createProcessSupervisor();
    const firstRun = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 80)"],
      timeoutMs: 1_000,
      stdinMode: "pipe-open",
    });

    const secondRun = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      replaceExistingScope: true,
      argv: createWriteStdoutArgv("new"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    second.emitStdout("new");
    second.settle(0);

    const firstExit = await firstRun.wait();
    const secondExit = await secondRun.wait();
    expect(first.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(["manual-cancel", "signal"]).toContain(firstExit.reason);
    expect(secondExit.reason).toBe("exit");
    expect(secondExit.stdout).toBe("new");
  });

  it("applies overall timeout even for near-immediate timer firing", async () => {
    vi.useFakeTimers();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-timeout",
      argv: createSilentIdleArgv(),
      timeoutMs: 1,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    await vi.advanceTimersByTimeAsync(1);

    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith(
      process.platform === "win32" ? "SIGKILL" : "SIGTERM",
    );
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("classifies a natural close after a missed overall deadline as timed out", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-timeout-race",
      argv: createSilentIdleArgv(),
      timeoutMs: 10,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    nowSpy.mockReturnValue(1_011);
    adapter.settle(0);

    const exit = await exitPromise;
    expect(adapter.killMock).not.toHaveBeenCalled();
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("uses the refreshed no-output deadline when a missed timer races natural close", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-no-output-race",
      argv: createSilentIdleArgv(),
      timeoutMs: 100,
      noOutputTimeoutMs: 10,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    nowSpy.mockReturnValue(1_005);
    adapter.emitStdout("progress");
    nowSpy.mockReturnValue(1_016);
    adapter.settle(0);

    const exit = await exitPromise;
    expect(adapter.killMock).not.toHaveBeenCalled();
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it("can stream output without retaining it in RunExit payload", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    let streamed = "";
    const run = await spawnChild(supervisor, {
      sessionId: "s-capture",
      argv: createWriteStdoutArgv("streamed"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      captureOutput: false,
      onStdout: (chunk) => {
        streamed += chunk;
      },
    });

    adapter.emitStdout("streamed");
    adapter.settle(0);

    const exit = await run.wait();
    expect(streamed).toBe("streamed");
    expect(exit.stdout).toBe("");
  });

  it("bounds retained output on UTF-16 boundaries while streaming full chunks", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    let streamedStdout = "";
    let streamedStderr = "";
    const maxCapturedOutputChars = 256;
    const stdoutMarker = `[openclaw: captured stdout truncated to last ${maxCapturedOutputChars} chars]\n`;
    const stderrMarker = `[openclaw: captured stderr truncated to last ${maxCapturedOutputChars} chars]\n`;
    const retainedChars = maxCapturedOutputChars - stdoutMarker.length - 1;
    const stdoutChunk = `${"a".repeat(stdoutMarker.length)}😀${"s".repeat(retainedChars)}`;
    const stderrChunk = `${"b".repeat(stderrMarker.length)}😀${"e".repeat(retainedChars)}`;
    const run = await spawnChild(supervisor, {
      sessionId: "s-capture-cap",
      argv: createWriteStdoutArgv(stdoutChunk),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      maxCapturedOutputChars,
      onStdout: (chunk) => {
        streamedStdout += chunk;
      },
      onStderr: (chunk) => {
        streamedStderr += chunk;
      },
    });

    adapter.emitStdout(stdoutChunk);
    adapter.emitStderr(stderrChunk);
    adapter.settle(0);

    const exit = await run.wait();
    expect(streamedStdout).toBe(stdoutChunk);
    expect(streamedStderr).toBe(stderrChunk);
    expect(exit.stdout).toBe(`${stdoutMarker}${"s".repeat(retainedChars)}`);
    expect(exit.stderr).toBe(`${stderrMarker}${"e".repeat(retainedChars)}`);
  });
});
