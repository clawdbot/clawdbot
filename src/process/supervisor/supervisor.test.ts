// Process supervisor tests cover lifecycle, restart, and termination behavior.
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import type { ManagedRun, SpawnProcessAdapter } from "./types.js";

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
    adapter.oomScoreWrapperSelected = true;
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
    expect(exit.oomScoreWrapperSelected).toBe(true);
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

  it.each(["child", "pty"] as const)(
    "cancels a %s process by run ID while its adapter is starting",
    async (mode) => {
      const adapter = createStubChildAdapter({
        onKill: (signal, current) => {
          current.settle(null, signal ?? "SIGTERM");
        },
      });
      const startup = createDeferred<StubChildAdapter>();
      if (mode === "pty") {
        createPtyAdapterMock.mockReturnValueOnce(startup.promise);
      } else {
        createChildAdapterMock.mockReturnValueOnce(startup.promise);
      }

      const supervisor = createProcessSupervisor();
      const runId = `cancel-starting-${mode}`;
      const pendingRun =
        mode === "pty"
          ? supervisor.spawn({
              runId,
              sessionId: "cancel-starting",
              backendId: "test",
              mode: "pty",
              ptyCommand: "printf cancelled",
              scopeKey: "scope:cancel-starting",
            })
          : spawnChild(supervisor, {
              runId,
              sessionId: "cancel-starting",
              scopeKey: "scope:cancel-starting",
              argv: createSilentIdleArgv(),
            });

      expect(supervisor.getRecord(runId)).toMatchObject({ state: "starting" });
      supervisor.cancel(runId, "manual-cancel");
      expect(supervisor.getRecord(runId)).toMatchObject({
        state: "exiting",
        terminationReason: "manual-cancel",
      });

      startup.resolve(adapter);
      const run = await pendingRun;
      expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
      await expect(run.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
      expect(supervisor.getRecord(runId)).toMatchObject({
        state: "exited",
        terminationReason: "manual-cancel",
      });
    },
  );

  it("cancels every starting scoped process without canceling a later arrival", async () => {
    const runCount = 16;
    const startups = Array.from({ length: runCount }, () => createDeferred<StubChildAdapter>());
    const adapters = Array.from({ length: runCount }, (_unused, index) =>
      createStubChildAdapter({
        pid: 7_000 + index,
        onKill: (signal, current) => {
          current.settle(null, signal ?? "SIGTERM");
        },
      }),
    );
    const laterAdapter = createStubChildAdapter({ pid: 8_000 });
    let adapterIndex = 0;
    createChildAdapterMock.mockImplementation(() => {
      const index = adapterIndex++;
      if (index === runCount) {
        return Promise.resolve(laterAdapter);
      }
      const startup = startups[index];
      if (!startup) {
        throw new Error(`unexpected scope cancellation startup ${index}`);
      }
      return startup.promise;
    });

    const supervisor = createProcessSupervisor();
    const pendingRuns = Array.from({ length: runCount }, (_unused, index) =>
      spawnChild(supervisor, {
        runId: `cancel-scope-starting-${index}`,
        sessionId: "cancel-scope-starting",
        scopeKey: "scope:cancel-every-start",
        argv: createSilentIdleArgv(),
      }),
    );

    expect(createChildAdapterMock).toHaveBeenCalledTimes(runCount);
    supervisor.cancelScope("scope:cancel-every-start", "manual-cancel");
    for (let index = 0; index < runCount; index += 1) {
      expect(supervisor.getRecord(`cancel-scope-starting-${index}`)).toMatchObject({
        state: "exiting",
        terminationReason: "manual-cancel",
      });
    }

    const laterRun = await spawnChild(supervisor, {
      runId: "cancel-scope-later-arrival",
      sessionId: "cancel-scope-starting",
      scopeKey: "scope:cancel-every-start",
      argv: createSilentIdleArgv(),
    });
    expect(laterAdapter.killMock).not.toHaveBeenCalled();

    for (let index = runCount - 1; index >= 0; index -= 1) {
      const startup = startups[index];
      const adapter = adapters[index];
      if (!startup || !adapter) {
        throw new Error(`missing scope cancellation startup ${index}`);
      }
      startup.resolve(adapter);
    }

    const runs = await Promise.all(pendingRuns);
    for (const adapter of adapters) {
      expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    }
    await expect(Promise.all(runs.map((run) => run.wait()))).resolves.toEqual(
      Array.from({ length: runCount }, () => expect.objectContaining({ reason: "manual-cancel" })),
    );

    expect(laterAdapter.killMock).not.toHaveBeenCalled();
    laterAdapter.settle(0);
    await expect(laterRun.wait()).resolves.toMatchObject({ reason: "exit" });
  });

  it("cancels a replacement that is fenced behind an earlier startup", async () => {
    const first = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGTERM");
      },
    });
    const later = createStubChildAdapter();
    const firstStartup = createDeferred<StubChildAdapter>();
    createChildAdapterMock.mockReturnValueOnce(firstStartup.promise).mockResolvedValueOnce(later);

    const supervisor = createProcessSupervisor();
    const firstRunPromise = spawnChild(supervisor, {
      runId: "cancel-fenced-first",
      sessionId: "cancel-fenced",
      scopeKey: "scope:cancel-fenced",
      argv: createSilentIdleArgv(),
    });
    const replacementPromise = spawnChild(supervisor, {
      runId: "cancel-fenced-replacement",
      sessionId: "cancel-fenced",
      scopeKey: "scope:cancel-fenced",
      replaceExistingScope: true,
      argv: createSilentIdleArgv(),
    });

    expect(createChildAdapterMock).toHaveBeenCalledTimes(1);
    supervisor.cancelScope("scope:cancel-fenced", "manual-cancel");

    const laterPromise = spawnChild(supervisor, {
      runId: "cancel-fenced-later",
      sessionId: "cancel-fenced",
      scopeKey: "scope:cancel-fenced",
      argv: createSilentIdleArgv(),
    });
    firstStartup.resolve(first);

    const [firstRun, replacementRun, laterRun] = await Promise.all([
      firstRunPromise,
      replacementPromise,
      laterPromise,
    ]);
    expect(createChildAdapterMock).toHaveBeenCalledTimes(2);
    expect(first.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(replacementRun.pid).toBeUndefined();
    expect(later.killMock).not.toHaveBeenCalled();

    later.settle(0);
    await expect(
      Promise.all([firstRun.wait(), replacementRun.wait(), laterRun.wait()]),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "manual-cancel" }),
      expect.objectContaining({ reason: "manual-cancel" }),
      expect.objectContaining({ reason: "exit" }),
    ]);
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

  it("waits for an in-flight scoped startup before replacing its run", async () => {
    const first = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGTERM");
      },
    });
    const second = createStubChildAdapter();
    const firstStartup = createDeferred<StubChildAdapter>();
    createChildAdapterMock.mockReturnValueOnce(firstStartup.promise).mockResolvedValueOnce(second);

    const supervisor = createProcessSupervisor();
    const firstRunPromise = spawnChild(supervisor, {
      runId: "scoped-start-first",
      sessionId: "scoped-start",
      scopeKey: "scope:overlap",
      argv: createSilentIdleArgv(),
    });
    const replacementPromise = spawnChild(supervisor, {
      runId: "scoped-start-replacement",
      sessionId: "scoped-start",
      scopeKey: "scope:overlap",
      replaceExistingScope: true,
      argv: createWriteStdoutArgv("replacement"),
    });

    expect(createChildAdapterMock).toHaveBeenCalledTimes(1);

    firstStartup.resolve(first);
    const [firstRun, replacement] = await Promise.all([firstRunPromise, replacementPromise]);

    expect(createChildAdapterMock).toHaveBeenCalledTimes(2);
    expect(first.killMock).toHaveBeenCalledWith("SIGTERM");
    await expect(firstRun.wait()).resolves.toMatchObject({ reason: "manual-cancel" });

    second.emitStdout("replacement");
    second.settle(0);
    await expect(replacement.wait()).resolves.toMatchObject({
      reason: "exit",
      stdout: "replacement",
    });
  });

  it("starts same-scope runs concurrently when replacement is not requested", async () => {
    const first = createStubChildAdapter();
    const second = createStubChildAdapter();
    const firstStartup = createDeferred<StubChildAdapter>();
    const secondStartup = createDeferred<StubChildAdapter>();
    createChildAdapterMock
      .mockReturnValueOnce(firstStartup.promise)
      .mockReturnValueOnce(secondStartup.promise);

    const supervisor = createProcessSupervisor();
    const firstRunPromise = spawnChild(supervisor, {
      sessionId: "shared-scope-first",
      scopeKey: "scope:shared-concurrent",
      argv: createSilentIdleArgv(),
    });
    const secondRunPromise = spawnChild(supervisor, {
      sessionId: "shared-scope-second",
      scopeKey: "scope:shared-concurrent",
      argv: createSilentIdleArgv(),
    });

    expect(createChildAdapterMock).toHaveBeenCalledTimes(2);

    secondStartup.resolve(second);
    const secondRun = await secondRunPromise;
    firstStartup.resolve(first);
    const firstRun = await firstRunPromise;

    expect(first.killMock).not.toHaveBeenCalled();
    expect(second.killMock).not.toHaveBeenCalled();
    first.settle(0);
    second.settle(0);
    await expect(Promise.all([firstRun.wait(), secondRun.wait()])).resolves.toEqual([
      expect.objectContaining({ reason: "exit" }),
      expect.objectContaining({ reason: "exit" }),
    ]);
  });

  it("does not cancel a newer run while an earlier scoped replacement is pending", async () => {
    const first = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGTERM");
      },
    });
    const replacementAdapter = createStubChildAdapter();
    const newerAdapter = createStubChildAdapter();
    const firstStartup = createDeferred<StubChildAdapter>();
    const replacementStartup = createDeferred<StubChildAdapter>();
    createChildAdapterMock
      .mockReturnValueOnce(firstStartup.promise)
      .mockReturnValueOnce(replacementStartup.promise)
      .mockResolvedValueOnce(newerAdapter);

    const supervisor = createProcessSupervisor();
    const firstRunPromise = spawnChild(supervisor, {
      runId: "replacement-fence-first",
      sessionId: "replacement-fence",
      scopeKey: "scope:replacement-fence",
      argv: createSilentIdleArgv(),
    });
    const replacementPromise = spawnChild(supervisor, {
      runId: "replacement-fence-replacement",
      sessionId: "replacement-fence",
      scopeKey: "scope:replacement-fence",
      replaceExistingScope: true,
      argv: createSilentIdleArgv(),
    });
    const newerRunPromise = spawnChild(supervisor, {
      runId: "replacement-fence-newer",
      sessionId: "replacement-fence",
      scopeKey: "scope:replacement-fence",
      argv: createSilentIdleArgv(),
    });

    expect(createChildAdapterMock).toHaveBeenCalledTimes(1);

    firstStartup.resolve(first);
    const firstRun = await firstRunPromise;
    await vi.waitFor(() => {
      expect(createChildAdapterMock).toHaveBeenCalledTimes(2);
    });
    expect(first.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(newerAdapter.killMock).not.toHaveBeenCalled();

    replacementStartup.resolve(replacementAdapter);
    const [replacement, newerRun] = await Promise.all([replacementPromise, newerRunPromise]);
    expect(createChildAdapterMock).toHaveBeenCalledTimes(3);
    expect(replacementAdapter.killMock).not.toHaveBeenCalled();
    expect(newerAdapter.killMock).not.toHaveBeenCalled();

    replacementAdapter.settle(0);
    newerAdapter.settle(0);
    await expect(
      Promise.all([firstRun.wait(), replacement.wait(), newerRun.wait()]),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "manual-cancel" }),
      expect.objectContaining({ reason: "exit" }),
      expect.objectContaining({ reason: "exit" }),
    ]);
  });

  it("waits for every concurrent same-scope startup before replacing the scope", async () => {
    const runCount = 8;
    const startups = Array.from({ length: runCount }, () => createDeferred<StubChildAdapter>());
    const adapters = Array.from({ length: runCount }, (_unused, index) =>
      createStubChildAdapter({
        pid: 5_000 + index,
        onKill: (signal, current) => {
          current.settle(null, signal ?? "SIGTERM");
        },
      }),
    );
    const replacementAdapter = createStubChildAdapter({ pid: 6_000 });
    let adapterIndex = 0;
    createChildAdapterMock.mockImplementation(() => {
      const index = adapterIndex++;
      if (index === runCount) {
        return Promise.resolve(replacementAdapter);
      }
      const startup = startups[index];
      if (!startup) {
        throw new Error(`unexpected shared-scope startup ${index}`);
      }
      return startup.promise;
    });

    const supervisor = createProcessSupervisor();
    const pendingRuns = Array.from({ length: runCount }, (_unused, index) =>
      spawnChild(supervisor, {
        runId: `shared-scope-${index}`,
        sessionId: "shared-scope",
        scopeKey: "scope:shared-replacement",
        argv: createSilentIdleArgv(),
      }),
    );
    const replacementPromise = spawnChild(supervisor, {
      runId: "shared-scope-replacement",
      sessionId: "shared-scope",
      scopeKey: "scope:shared-replacement",
      replaceExistingScope: true,
      argv: createWriteStdoutArgv("replacement"),
    });

    expect(createChildAdapterMock).toHaveBeenCalledTimes(runCount);

    for (let index = runCount - 1; index >= 0; index -= 1) {
      const startup = startups[index];
      const adapter = adapters[index];
      if (!startup || !adapter) {
        throw new Error(`missing shared-scope startup ${index}`);
      }
      startup.resolve(adapter);
    }

    const runs = await Promise.all(pendingRuns);
    const replacement = await replacementPromise;
    expect(createChildAdapterMock).toHaveBeenCalledTimes(runCount + 1);
    for (const adapter of adapters) {
      expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    }
    await expect(Promise.all(runs.map((run) => run.wait()))).resolves.toEqual(
      Array.from({ length: runCount }, () => expect.objectContaining({ reason: "manual-cancel" })),
    );

    replacementAdapter.emitStdout("replacement");
    replacementAdapter.settle(0);
    await expect(replacement.wait()).resolves.toMatchObject({
      reason: "exit",
      stdout: "replacement",
    });
  });

  it("keeps startup independent for different replacement scopes", async () => {
    const first = createStubChildAdapter();
    const second = createStubChildAdapter();
    const firstStartup = createDeferred<StubChildAdapter>();
    const secondStartup = createDeferred<StubChildAdapter>();
    createChildAdapterMock
      .mockReturnValueOnce(firstStartup.promise)
      .mockReturnValueOnce(secondStartup.promise);

    const supervisor = createProcessSupervisor();
    const firstRunPromise = spawnChild(supervisor, {
      sessionId: "independent-a",
      scopeKey: "scope:independent-a",
      replaceExistingScope: true,
      argv: createSilentIdleArgv(),
    });
    const secondRunPromise = spawnChild(supervisor, {
      sessionId: "independent-b",
      scopeKey: "scope:independent-b",
      replaceExistingScope: true,
      argv: createSilentIdleArgv(),
    });

    expect(createChildAdapterMock).toHaveBeenCalledTimes(2);

    secondStartup.resolve(second);
    const secondRun = await secondRunPromise;
    firstStartup.resolve(first);
    const firstRun = await firstRunPromise;

    expect(first.killMock).not.toHaveBeenCalled();
    expect(second.killMock).not.toHaveBeenCalled();
    first.settle(0);
    second.settle(0);
    await expect(Promise.all([firstRun.wait(), secondRun.wait()])).resolves.toEqual([
      expect.objectContaining({ reason: "exit" }),
      expect.objectContaining({ reason: "exit" }),
    ]);
  });

  it("starts a scoped replacement after the previous adapter fails to start", async () => {
    const second = createStubChildAdapter();
    createChildAdapterMock
      .mockRejectedValueOnce(new Error("first adapter could not start"))
      .mockResolvedValueOnce(second);

    const supervisor = createProcessSupervisor();
    const firstRunPromise = spawnChild(supervisor, {
      runId: "failed-scoped-start",
      sessionId: "failed-scoped-start",
      scopeKey: "scope:recover-start",
      argv: createSilentIdleArgv(),
    });
    const replacementPromise = spawnChild(supervisor, {
      runId: "recovered-scoped-start",
      sessionId: "failed-scoped-start",
      scopeKey: "scope:recover-start",
      replaceExistingScope: true,
      argv: createWriteStdoutArgv("recovered"),
    });

    await expect(firstRunPromise).rejects.toThrow("first adapter could not start");
    const replacement = await replacementPromise;
    second.emitStdout("recovered");
    second.settle(0);

    await expect(replacement.wait()).resolves.toMatchObject({
      reason: "exit",
      stdout: "recovered",
    });
    expect(supervisor.getRecord("failed-scoped-start")).toMatchObject({
      state: "exited",
      terminationReason: "spawn-error",
    });
  });

  it("keeps only the newest run across 64 concurrent same-scope replacements", async () => {
    const runCount = 64;
    const adapters = Array.from({ length: runCount }, (_unused, index) =>
      createStubChildAdapter({
        pid: 2_000 + index,
        onKill: (signal, current) => {
          current.settle(null, signal ?? "SIGTERM");
        },
      }),
    );
    let adapterIndex = 0;
    createChildAdapterMock.mockImplementation(async () => {
      const adapter = adapters[adapterIndex++];
      if (!adapter) {
        throw new Error("unexpected concurrent supervisor startup");
      }
      return adapter;
    });

    const supervisor = createProcessSupervisor();
    const pendingRuns = Array.from({ length: runCount }, (_unused, index) =>
      spawnChild(supervisor, {
        runId: `scope-stress-${index}`,
        sessionId: "scope-stress",
        scopeKey: "scope:stress",
        replaceExistingScope: true,
        argv: createSilentIdleArgv(),
      }),
    );

    const runs = await Promise.all(pendingRuns);
    for (const [index, adapter] of adapters.entries()) {
      if (index === runCount - 1) {
        expect(adapter.killMock, `newest scope owner ${index}`).not.toHaveBeenCalled();
      } else {
        expect(adapter.killMock, `superseded scope owner ${index}`).toHaveBeenCalledWith("SIGTERM");
      }
    }

    const newestAdapter = adapters[runCount - 1];
    const newestRun = runs[runCount - 1];
    if (!newestAdapter || !newestRun) {
      throw new Error("expected the newest scoped process");
    }
    newestAdapter.settle(0);

    const exits = await Promise.all(runs.map((run) => run.wait()));
    for (const [index, exit] of exits.entries()) {
      expect(exit.reason, `scoped run ${index}`).toBe(
        index === runCount - 1 ? "exit" : "manual-cancel",
      );
    }
  });

  it("continues replacing scoped runs across interleaved startup failures", async () => {
    const runCount = 48;
    const adapters = new Map<number, StubChildAdapter>();
    let adapterIndex = 0;
    createChildAdapterMock.mockImplementation(async () => {
      const index = adapterIndex++;
      if (index % 7 === 3) {
        throw new Error(`adapter ${index} could not start`);
      }
      const adapter = createStubChildAdapter({
        pid: 3_000 + index,
        onKill: (signal, current) => {
          current.settle(null, signal ?? "SIGTERM");
        },
      });
      adapters.set(index, adapter);
      return adapter;
    });

    const supervisor = createProcessSupervisor();
    const pendingRuns = Array.from({ length: runCount }, (_unused, index) =>
      spawnChild(supervisor, {
        runId: `scope-recovery-${index}`,
        sessionId: "scope-recovery",
        scopeKey: "scope:interleaved-recovery",
        replaceExistingScope: true,
        argv: createSilentIdleArgv(),
      }),
    );

    const results = await Promise.allSettled(pendingRuns);
    const running: ManagedRun[] = [];
    for (const [index, result] of results.entries()) {
      if (index % 7 === 3) {
        expect(result.status, `failed adapter ${index}`).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ message: `adapter ${index} could not start` });
        }
        expect(supervisor.getRecord(`scope-recovery-${index}`)).toMatchObject({
          state: "exited",
          terminationReason: "spawn-error",
        });
        continue;
      }
      expect(result.status, `started adapter ${index}`).toBe("fulfilled");
      if (result.status === "fulfilled") {
        running.push(result.value);
      }
    }

    const newestAdapter = adapters.get(runCount - 1);
    if (!newestAdapter) {
      throw new Error("expected the final replacement adapter");
    }
    for (const [index, adapter] of adapters) {
      if (index === runCount - 1) {
        expect(adapter.killMock, `newest adapter ${index}`).not.toHaveBeenCalled();
      } else {
        expect(adapter.killMock, `superseded adapter ${index}`).toHaveBeenCalledWith("SIGTERM");
      }
    }
    newestAdapter.settle(0);

    const exits = await Promise.all(running.map((run) => run.wait()));
    expect(exits.filter((exit) => exit.reason === "exit")).toHaveLength(1);
    expect(exits.filter((exit) => exit.reason === "manual-cancel")).toHaveLength(
      running.length - 1,
    );
  });

  it("starts 24 independent scoped processes without a global startup bottleneck", async () => {
    const scopeCount = 24;
    const startups = Array.from({ length: scopeCount }, () => createDeferred<StubChildAdapter>());
    const adapters = Array.from({ length: scopeCount }, (_unused, index) =>
      createStubChildAdapter({ pid: 4_000 + index }),
    );
    let adapterIndex = 0;
    createChildAdapterMock.mockImplementation(() => {
      const startup = startups[adapterIndex++];
      if (!startup) {
        throw new Error("unexpected independent supervisor startup");
      }
      return startup.promise;
    });

    const supervisor = createProcessSupervisor();
    const pendingRuns = Array.from({ length: scopeCount }, (_unused, index) =>
      spawnChild(supervisor, {
        runId: `independent-scope-${index}`,
        sessionId: "scope-independence",
        scopeKey: `scope:independent-${index}`,
        replaceExistingScope: true,
        argv: createSilentIdleArgv(),
      }),
    );

    expect(createChildAdapterMock).toHaveBeenCalledTimes(scopeCount);

    for (let index = scopeCount - 1; index >= 0; index -= 1) {
      const startup = startups[index];
      const adapter = adapters[index];
      if (!startup || !adapter) {
        throw new Error(`missing independent scope ${index}`);
      }
      startup.resolve(adapter);
    }

    const runs = await Promise.all(pendingRuns);
    for (const adapter of adapters) {
      expect(adapter.killMock).not.toHaveBeenCalled();
      adapter.settle(0);
    }

    const exits = await Promise.all(runs.map((run) => run.wait()));
    expect(exits.every((exit) => exit.reason === "exit")).toBe(true);
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
