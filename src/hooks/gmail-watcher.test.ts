import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasBinary: vi.fn(() => true),
  resolveExecutable: vi.fn((name: string) => name),
  runCommandWithTimeout: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("../agents/skills.js", () => ({
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
});
