import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
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
    expect(first.killMock).toHaveBeenCalledWith("SIGKILL");
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
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(exit.reason).toBe("overall-timeout");
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
});
