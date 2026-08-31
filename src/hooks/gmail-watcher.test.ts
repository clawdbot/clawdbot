// Gmail watcher tests cover watcher events and Gmail hook message flow.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

// Tracks spawned children by pid so the killProcessTree mock can emit close on them.
const spawnRegistry = new Map<number, EventEmitter>();

const mocks = vi.hoisted(() => ({
  hasBinary: vi.fn(() => true),
  resolveExecutable: vi.fn((name: string) => name),
  runCommandWithTimeout: vi.fn(),
  spawn: vi.fn(),
  killProcessTree: vi.fn((pid: number) => {
    const child = spawnRegistry.get(pid);
    if (child) {
      queueMicrotask(() => child.emit("close", 0, null));
    }
  }),
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

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: mocks.killProcessTree,
}));

const { startGmailWatcher, stopGmailWatcher } = await import("./gmail-watcher.js");

function createGmailConfig(account = "me@example.com", renewEveryMinutes?: number) {
  return {
    hooks: {
      enabled: true,
      token: "hook-token",
      gmail: {
        account,
        topic: "projects/demo/topics/gmail",
        pushToken: "push-token",
        renewEveryMinutes,
      },
    },
  } as never;
}

function deferredCommandResult() {
  return createDeferred<{ code: number; stdout: string; stderr: string }>();
}

type MockWatcherChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  stdout: PassThrough;
  stderr: PassThrough;
};

let nextMockPid = 1234;

function createMockWatcherChild(spawned = true): MockWatcherChild {
  const child = new EventEmitter();
  const pid = spawned ? nextMockPid++ : undefined;
  const mockedChild = Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
      return true;
    }),
    ...(pid !== undefined ? { pid } : {}),
  });
  if (pid !== undefined) {
    spawnRegistry.set(pid, mockedChild);
  }
  return mockedChild;
}

async function startMockWatcher(spawned = true): Promise<MockWatcherChild[]> {
  mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  const children: MockWatcherChild[] = [];
  mocks.spawn.mockImplementation(() => {
    const child = createMockWatcherChild(spawned);
    children.push(child);
    return child;
  });
  await startGmailWatcher(createGmailConfig());
  return children;
}

describe("startGmailWatcher", () => {
  beforeEach(async () => {
    // stopGmailWatcher uses the killProcessTree mock from the previous beforeEach run,
    // which looks up spawnRegistry entries populated by that test's children.
    await stopGmailWatcher();
    spawnRegistry.clear();
    mocks.hasBinary.mockReturnValue(true);
    mocks.resolveExecutable.mockImplementation((name: string) => name);
    mocks.runCommandWithTimeout.mockReset();
    mocks.spawn.mockReset();
    mocks.killProcessTree.mockReset();
    mocks.killProcessTree.mockImplementation((pid: number) => {
      const child = spawnRegistry.get(pid);
      if (child) {
        queueMicrotask(() => child.emit("close", 0, null));
      }
    });
    mocks.spawn.mockImplementation(() => createMockWatcherChild(false));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await stopGmailWatcher();
  });

  it("does not let a stale cancelled startup clear newer watcher config", async () => {
    vi.useFakeTimers();
    try {
      const oldController = new AbortController();
      const oldWatchStart = deferredCommandResult();
      const spawnedChildren: MockWatcherChild[] = [];
      mocks.runCommandWithTimeout
        .mockImplementationOnce(async () => await oldWatchStart.promise)
        .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      mocks.spawn.mockImplementation(() => {
        const child = createMockWatcherChild(false);
        spawnedChildren.push(child);
        return child;
      });

      const staleStart = startGmailWatcher(createGmailConfig(), {
        signal: oldController.signal,
      });

      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);

      await expect(startGmailWatcher(createGmailConfig("newer@example.com"))).resolves.toEqual({
        started: true,
      });
      expect(mocks.spawn).toHaveBeenCalledTimes(1);

      oldController.abort();
      oldWatchStart.resolve({ code: 0, stdout: "", stderr: "" });
      await expect(staleStart).resolves.toEqual({
        started: false,
        reason: "startup cancelled",
      });

      spawnedChildren[0]?.emit("close", 1, null);
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
    expect(watchStartSignal).toBe(controller.signal);
    controller.abort();
    expect(watchStartSignal?.aborted).toBe(true);

    await expect(startPromise).resolves.toEqual({
      started: false,
      reason: "startup cancelled",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("aborts tailscale setup and does not spawn gog serve when cancelled in flight", async () => {
    const controller = new AbortController();
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
        signal: controller.signal,
      },
    );

    await vi.waitFor(() => {
      expect(tailscaleSignal).toBeDefined();
    });
    controller.abort();

    expect(tailscaleSignal).toBe(controller.signal);
    expect(tailscaleSignal?.aborted).toBe(true);

    await expect(startPromise).resolves.toEqual({
      started: false,
      reason: "startup cancelled",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("kills existing watcher process on re-entry before spawning new one", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const spawnedChildren: MockWatcherChild[] = [];
    mocks.spawn.mockImplementation(() => {
      const child = createMockWatcherChild(false);
      spawnedChildren.push(child);
      return child;
    });

    // First start
    await startGmailWatcher(createGmailConfig());
    expect(spawnedChildren).toHaveLength(1);
    expect(
      expectDefined(spawnedChildren[0], "spawnedChildren[0] test invariant").kill,
    ).not.toHaveBeenCalled();

    // Second start (re-entry) should kill the first process
    await startGmailWatcher(createGmailConfig());
    expect(spawnedChildren).toHaveLength(2);
    expect(
      expectDefined(spawnedChildren[0], "spawnedChildren[0] test invariant").kill,
    ).toHaveBeenCalledWith("SIGTERM");
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

  it("keeps a stalled periodic renewal single-flight", async () => {
    vi.useFakeTimers();
    try {
      const renewal = deferredCommandResult();
      mocks.runCommandWithTimeout
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockImplementation(async () => await renewal.promise);

      await startGmailWatcher(createGmailConfig("me@example.com", 1));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      const callsWhileStalled = mocks.runCommandWithTimeout.mock.calls.length;
      renewal.resolve({ code: 0, stdout: "", stderr: "" });
      await Promise.resolve();

      expect(callsWhileStalled).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stalled renewal survive stop and suppress a replacement watcher", async () => {
    vi.useFakeTimers();
    try {
      let stalledSignal: AbortSignal | undefined;
      mocks.runCommandWithTimeout
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockImplementationOnce(
          async (_args, options: { signal?: AbortSignal }) =>
            await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
              stalledSignal = options.signal;
              options.signal?.addEventListener(
                "abort",
                () => resolve({ code: 1, stdout: "", stderr: "aborted" }),
                { once: true },
              );
            }),
        )
        .mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      await startGmailWatcher(createGmailConfig("old@example.com", 1));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stalledSignal?.aborted).toBe(false);

      await stopGmailWatcher();
      expect(stalledSignal?.aborted).toBe(true);

      await startGmailWatcher(createGmailConfig("new@example.com", 1));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(4);
      expect(mocks.runCommandWithTimeout.mock.calls[3]?.[0]).toContain("new@example.com");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses killProcessTree for gog shutdown and resolves on final timeout when process ignores signals", async () => {
    vi.useFakeTimers();
    try {
      mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      // Spawn a process with a known pid that never emits exit/close/error
      const stubbornChild = new EventEmitter();
      Object.assign(stubbornChild, {
        pid: 9999,
        kill: vi.fn(() => true),
        killed: false,
      });
      mocks.spawn.mockReturnValueOnce(stubbornChild);

      await startGmailWatcher(createGmailConfig());
      expect(mocks.spawn).toHaveBeenCalledTimes(1);

      // Now spawn a normal child for the second start so re-entry triggers settle
      mocks.spawn.mockImplementation(() => createMockWatcherChild(false));

      // Re-entry starts settle on stubbornChild; advance past the 8 s final
      // timeout (stubbornChild never emits exit), then verify the outcome.
      const startPromise = startGmailWatcher(createGmailConfig());
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(startPromise).resolves.toEqual({ started: true });

      // killProcessTree must have been called with stubbornChild's pid before settle gave up.
      expect(mocks.killProcessTree).toHaveBeenCalledWith(
        9999,
        expect.objectContaining({ graceMs: 3_000 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels stale respawn timeout when re-entry happens during 5s window", async () => {
    vi.useFakeTimers();
    try {
      mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const spawnedChildren: MockWatcherChild[] = [];
      mocks.spawn.mockImplementation(() => {
        const child = createMockWatcherChild(false);
        spawnedChildren.push(child);
        return child;
      });

      // First start
      await startGmailWatcher(createGmailConfig());
      expect(spawnedChildren).toHaveLength(1);

      // Process crashes (exit code 1). This queues a 5s respawn timeout.
      expectDefined(spawnedChildren[0], "spawnedChildren[0] test invariant").emit("close", 1, null);

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

  it("ignores a retired child's late close while replacement startup is pending", async () => {
    vi.useFakeTimers();
    const pendingStart = deferredCommandResult();
    const children = await startMockWatcher();
    mocks.killProcessTree.mockImplementation(() => {});
    mocks.runCommandWithTimeout.mockImplementationOnce(() => pendingStart.promise);
    const restarting = startGmailWatcher(createGmailConfig("new@example.com"));
    try {
      await vi.advanceTimersByTimeAsync(8_000);
      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
      const retired = expectDefined(children[0], "retired watcher");
      retired.emit("exit", 1, null);
      retired.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(children).toHaveLength(1);
      expect(mocks.killProcessTree).toHaveBeenCalledTimes(1);
      pendingStart.resolve({ code: 0, stdout: "", stderr: "" });
      await restarting;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(children).toHaveLength(2);
      expect(mocks.spawn.mock.calls[1]?.[1]).toContain("new@example.com");
    } finally {
      pendingStart.resolve({ code: 0, stdout: "", stderr: "" });
      await restarting;
      const stopping = stopGmailWatcher();
      await vi.advanceTimersByTimeAsync(8_000);
      await stopping;
      for (const child of children) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      vi.useRealTimers();
    }
  });

  it("preserves the shutdown grace period when the watcher exits before its descendants", async () => {
    vi.useFakeTimers();
    mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const child = createMockWatcherChild();
    mocks.spawn.mockReturnValueOnce(child);
    mocks.killProcessTree.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
    });

    await startGmailWatcher(createGmailConfig());
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = stopGmailWatcher().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    await stopping;

    expect(mocks.killProcessTree).toHaveBeenCalledTimes(1);
    expect(mocks.killProcessTree).toHaveBeenCalledWith(
      child.pid,
      expect.objectContaining({ graceMs: 3_000 }),
    );
    // proc.kill should not be called — tree termination replaces the direct kill.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32"] as const)(
    "restarts initial and replacement children with inherited pipes on %s",
    async (platform) => {
      vi.useFakeTimers();
      await withMockedPlatform(platform, async () => {
        const children = await startMockWatcher();
        // Descendants keep both pipes open after exit, even if tree cleanup fails.
        mocks.killProcessTree.mockImplementation(() => {});
        try {
          for (let index = 0; index < 2; index++) {
            const child = expectDefined(children[index], "watcher child");
            let closedStreams = 0;
            for (const stream of [child.stdout, child.stderr]) {
              stream.once("close", () => {
                if (++closedStreams === 2) {
                  child.emit("close", null, "SIGKILL");
                }
              });
            }
            child.emit("exit", null, "SIGKILL");
            await vi.advanceTimersByTimeAsync(6_100);
            expect(children).toHaveLength(index + 2);
            expect(child.stdout.destroyed).toBe(true);
            expect(child.stderr.destroyed).toBe(true);
            if (platform === "win32") {
              expect(mocks.killProcessTree).not.toHaveBeenCalled();
            } else {
              expect(mocks.killProcessTree).toHaveBeenCalledTimes(index + 1);
              expect(mocks.killProcessTree).toHaveBeenLastCalledWith(child.pid, {
                force: true,
                detached: true,
              });
            }
          }
          await vi.advanceTimersByTimeAsync(6_000);
          expect(children).toHaveLength(3);
        } finally {
          const stopping = stopGmailWatcher();
          await vi.advanceTimersByTimeAsync(8_000);
          await stopping;
          for (const child of children) {
            child.stdout.destroy();
            child.stderr.destroy();
          }
          vi.useRealTimers();
        }
      });
    },
  );

  it("does not taskkill an exited Windows child while inherited pipes drain", async () => {
    vi.useFakeTimers();
    await withMockedPlatform("win32", async () => {
      const children = await startMockWatcher();
      const child = expectDefined(children[0], "watcher child");
      Object.assign(child, { exitCode: 1, signalCode: null });
      child.emit("exit", 1, null);
      const stopping = stopGmailWatcher();
      try {
        await vi.advanceTimersByTimeAsync(8_000);
        await stopping;
        expect(mocks.killProcessTree).not.toHaveBeenCalled();
        expect(child.stdout.destroyed).toBe(true);
        expect(child.stderr.destroyed).toBe(true);
        expect(children).toHaveLength(1);
      } finally {
        child.stdout.destroy();
        child.stderr.destroy();
        vi.useRealTimers();
      }
    });
  });

  it("swallows stdout and stderr stream errors without crashing", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    mocks.spawn.mockImplementation(() => {
      const child = createMockWatcherChild(false);
      queueMicrotask(() => {
        child.stdout.emit("error", new Error("stdout read failed"));
        child.stderr.emit("error", new Error("stderr read failed"));
      });
      return child;
    });

    await expect(startGmailWatcher(createGmailConfig())).resolves.toEqual({ started: true });
  });

  it.each([
    { name: "failed spawn", spawned: false, expectedChildren: 1 },
    { name: "error from a running child", spawned: true, expectedChildren: 2 },
  ])("handles $name without losing restart policy", async ({ spawned, expectedChildren }) => {
    vi.useFakeTimers();
    try {
      const children = await startMockWatcher(spawned);
      const child = expectDefined(children[0], "watcher child");
      child.emit("error", new Error(spawned ? "gog stream error" : "spawn gog ENOENT"));
      child.emit("close", spawned ? 1 : -2, null);

      await vi.advanceTimersByTimeAsync(6000);
      expect(children).toHaveLength(expectedChildren);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "split address-in-use marker",
      chunks: ["address alre", "ady in use\n"],
      expectedChildren: 1,
    },
    {
      name: "final bind fragment after exit",
      chunks: ["address alre", "ady in use\n"],
      exitAfterChunk: 0,
      expectedChildren: 1,
    },
    {
      name: "marker completed before tail truncation",
      chunks: ["address alre", `ady in use ${"x".repeat(800)}`],
      expectedChildren: 1,
    },
    {
      name: "non-bind stderr",
      chunks: ["some erro", "r message\n"],
      expectedChildren: 2,
    },
  ])("classifies $name", async ({ chunks, exitAfterChunk, expectedChildren }) => {
    vi.useFakeTimers();
    try {
      const children = await startMockWatcher();
      const child = expectDefined(children[0], "watcher child");
      for (const [index, chunk] of chunks.entries()) {
        child.stderr.emit("data", Buffer.from(chunk));
        if (exitAfterChunk === index) {
          child.emit("exit", 1, null);
        }
      }
      child.emit("close", 1, null);

      await vi.advanceTimersByTimeAsync(6000);
      expect(children).toHaveLength(expectedChildren);
    } finally {
      vi.useRealTimers();
    }
  });
});
