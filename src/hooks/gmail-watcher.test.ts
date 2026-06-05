// Gmail watcher tests cover watcher events and Gmail hook message flow.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasBinary: vi.fn(() => true),
  resolveExecutable: vi.fn((name: string) => name),
  runCommandWithTimeout: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: mocks.spawn },
  );
});

vi.mock("../skills/loading/config.js", () => ({
  hasBinary: mocks.hasBinary,
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutable: mocks.resolveExecutable,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

const { startGmailWatcher, stopGmailWatcher } = await import("./gmail-watcher.js");

function createGmailConfig(account = "me@example.com") {
  return {
    hooks: {
      enabled: true,
      token: "hook-token",
      gmail: {
        account,
        topic: "projects/demo/topics/gmail",
        pushToken: "push-token",
      },
    },
  } as never;
}

function deferredCommandResult() {
  let resolve!: (result: { code: number; stdout: string; stderr: string }) => void;
  const promise = new Promise<{ code: number; stdout: string; stderr: string }>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("startGmailWatcher", () => {
  beforeEach(async () => {
    await stopGmailWatcher();
    mocks.hasBinary.mockReturnValue(true);
    mocks.resolveExecutable.mockImplementation((name: string) => name);
    mocks.runCommandWithTimeout.mockReset();
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      return Object.assign(child, {
        kill: vi.fn(() => {
          queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
          return true;
        }),
        killed: false,
      });
    });
  });

  it("does not let a stale cancelled startup clear newer watcher config", async () => {
    vi.useFakeTimers();
    try {
      let oldCancelled = false;
      const oldWatchStart = deferredCommandResult();
      const spawnedChildren: Array<
        EventEmitter & { kill: ReturnType<typeof vi.fn>; killed: boolean }
      > = [];
      mocks.runCommandWithTimeout
        .mockImplementationOnce(async () => await oldWatchStart.promise)
        .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      mocks.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        const mockedChild = Object.assign(child, {
          kill: vi.fn(() => {
            queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
            return true;
          }),
          killed: false,
        });
        spawnedChildren.push(mockedChild);
        return mockedChild;
      });

      const staleStart = startGmailWatcher(createGmailConfig(), {
        isCancelled: () => oldCancelled,
      });

      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);

      await expect(startGmailWatcher(createGmailConfig("newer@example.com"))).resolves.toEqual({
        started: true,
      });
      expect(mocks.spawn).toHaveBeenCalledTimes(1);

      oldCancelled = true;
      oldWatchStart.resolve({ code: 0, stdout: "", stderr: "" });
      await expect(staleStart).resolves.toEqual({
        started: false,
        reason: "startup cancelled",
      });

      spawnedChildren[0]?.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(5000);

      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      expect(mocks.spawn.mock.calls[1]?.[1]).toContain("newer@example.com");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts watch start and does not spawn gog serve when cancelled in flight", async () => {
    let watchStartSignal: AbortSignal | undefined;
    const controller = new AbortController();
    mocks.runCommandWithTimeout.mockImplementation(
      async (_args, options: { signal?: AbortSignal }) =>
        await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          watchStartSignal = options.signal;
          options.signal?.addEventListener(
            "abort",
            () => resolve({ code: 1, stdout: "", stderr: "aborted" }),
            { once: true },
          );
        }),
    );

    const startPromise = startGmailWatcher(createGmailConfig(), {
      signal: controller.signal,
    });

    await Promise.resolve();
    expect(watchStartSignal).toBeDefined();
    controller.abort();
    expect(watchStartSignal?.aborted).toBe(true);

    await expect(startPromise).resolves.toEqual({
      started: false,
      reason: "startup cancelled",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("aborts tailscale setup and does not spawn gog serve when cancelled in flight", async () => {
    let cancelled = false;
    let tailscaleSignal: AbortSignal | undefined;
    mocks.runCommandWithTimeout.mockImplementation(
      async (_args, options: { signal?: AbortSignal }) =>
        await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
          tailscaleSignal = options.signal;
          options.signal?.addEventListener(
            "abort",
            () => resolve({ code: null, stdout: "", stderr: "aborted" }),
            { once: true },
          );
        }),
    );
    const startPromise = startGmailWatcher(
      {
        hooks: {
          enabled: true,
          token: "hook-token",
          gmail: {
            account: "me@example.com",
            topic: "projects/demo/topics/gmail",
            pushToken: "push-token",
            tailscale: { mode: "serve" },
          },
        },
      } as never,
      {
        isCancelled: () => cancelled,
      },
    );

    await vi.waitFor(() => {
      expect(tailscaleSignal).toBeDefined();
    });
    cancelled = true;

    await vi.waitFor(() => {
      expect(tailscaleSignal?.aborted).toBe(true);
    });

    await expect(startPromise).resolves.toEqual({
      started: false,
      reason: "startup cancelled",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("kills existing watcher process on re-entry before spawning new one", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const spawnedChildren: Array<
      EventEmitter & { kill: ReturnType<typeof vi.fn>; killed: boolean }
    > = [];
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      const mockedChild = Object.assign(child, {
        kill: vi.fn(() => {
          queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
          return true;
        }),
        killed: false,
      });
      spawnedChildren.push(mockedChild);
      return mockedChild;
    });

    // First start
    await startGmailWatcher(createGmailConfig());
    expect(spawnedChildren).toHaveLength(1);
    expect(spawnedChildren[0].kill).not.toHaveBeenCalled();

    // Second start (re-entry) should kill the first process
    await startGmailWatcher(createGmailConfig());
    expect(spawnedChildren).toHaveLength(2);
    expect(spawnedChildren[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("clears existing renewInterval on re-entry to prevent interval leak", async () => {
    vi.useFakeTimers();
    try {
      mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      // First start - creates a renewal interval
      await startGmailWatcher(createGmailConfig());
      const timersAfterFirstStart = vi.getTimerCount();
      expect(timersAfterFirstStart).toBeGreaterThanOrEqual(1);

      // Second start (re-entry without stop) - the guard should clear the old
      // interval before creating a new one, keeping the timer count stable.
      await startGmailWatcher(createGmailConfig());
      expect(vi.getTimerCount()).toBe(timersAfterFirstStart);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only one renewal fires per tick after multiple starts", async () => {
    vi.useFakeTimers();
    try {
      // Resolve watch-start immediately on every call
      mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      // Start twice without stopping
      await startGmailWatcher(createGmailConfig());
      await startGmailWatcher(createGmailConfig());

      // runCommandWithTimeout is called once per start (the gog watch start
      // call).  After two successful starts it has been called twice.
      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);

      // Advance by one full renewal cycle.
      // Default renewEveryMinutes = 720 (12 h) = 43_200_000 ms.
      // If the old interval leaked, the callback would fire twice per cycle.
      await vi.advanceTimersByTimeAsync(720 * 60_000);

      // Only ONE renewal should have fired (the latest interval).
      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates to SIGKILL and resolves on final timeout when process ignores signals", async () => {
    vi.useFakeTimers();
    try {
      mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      // Spawn a process that never emits exit/close/error
      const stubbornChild = new EventEmitter();
      const killCalls: string[] = [];
      Object.assign(stubbornChild, {
        kill: vi.fn((sig: string) => {
          killCalls.push(sig);
          return true;
        }),
        killed: false,
      });
      mocks.spawn.mockReturnValueOnce(stubbornChild);

      await startGmailWatcher(createGmailConfig());
      expect(mocks.spawn).toHaveBeenCalledTimes(1);

      // Now spawn a normal child for the second start so re-entry triggers settle
      mocks.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        return Object.assign(child, {
          kill: vi.fn(() => {
            queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
            return true;
          }),
          killed: false,
        });
      });

      // Re-entry starts settle on stubbornChild
      const startPromise = startGmailWatcher(createGmailConfig());

      // After 3s the escalation fires SIGKILL
      await vi.advanceTimersByTimeAsync(3_000);
      expect(killCalls).toContain("SIGTERM");
      expect(killCalls).toContain("SIGKILL");

      // After 8s total the final timeout resolves even though exit never fired
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(startPromise).resolves.toEqual({ started: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels stale respawn timeout when re-entry happens during 5s window", async () => {
    vi.useFakeTimers();
    try {
      mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const spawnedChildren: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = [];
      mocks.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        const mockedChild = Object.assign(child, {
          kill: vi.fn(() => {
            queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
            return true;
          }),
        });
        spawnedChildren.push(mockedChild);
        return mockedChild;
      });

      // First start
      await startGmailWatcher(createGmailConfig());
      expect(spawnedChildren).toHaveLength(1);

      // Process crashes (exit code 1). This queues a 5s respawn timeout.
      spawnedChildren[0].emit("exit", 1, null);

      // Before the 5s timer fires, a config reload triggers re-entry.
      // The re-entry guard should cancel the stale respawn timeout.
      await startGmailWatcher(createGmailConfig());
      expect(spawnedChildren).toHaveLength(2);

      // Advance past the 5s respawn window. If the stale timeout was NOT
      // cancelled, it would spawn a 3rd process (duplicate).
      await vi.advanceTimersByTimeAsync(6000);
      expect(spawnedChildren).toHaveLength(2); // No duplicate spawned
    } finally {
      vi.useRealTimers();
    }
  });
});
