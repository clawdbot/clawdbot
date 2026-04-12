import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const FAKE_STARTTIME = 12345;
let __testing: typeof import("./session-write-lock.js").__testing;
let acquireSessionWriteLock: typeof import("./session-write-lock.js").acquireSessionWriteLock;
let cleanStaleLockFiles: typeof import("./session-write-lock.js").cleanStaleLockFiles;
let resetSessionWriteLockStateForTest: typeof import("./session-write-lock.js").resetSessionWriteLockStateForTest;
let resolveSessionLockMaxHoldFromTimeout: typeof import("./session-write-lock.js").resolveSessionLockMaxHoldFromTimeout;

vi.mock("../shared/pid-alive.js", async () => {
  const original =
    await vi.importActual<typeof import("../shared/pid-alive.js")>("../shared/pid-alive.js");
  return {
    ...original,
    // Keep liveness checks real; only pin process start time for PID recycle coverage.
    getProcessStartTime: (pid: number) => (pid === process.pid ? FAKE_STARTTIME : null),
  };
});

async function expectLockRemovedOnlyAfterFinalRelease(params: {
  lockPath: string;
  firstLock: { release: () => Promise<void> };
  secondLock: { release: () => Promise<void> };
}) {
  await expect(fs.access(params.lockPath)).resolves.toBeUndefined();
  await params.firstLock.release();
  await expect(fs.access(params.lockPath)).resolves.toBeUndefined();
  await params.secondLock.release();
  await expect(fs.access(params.lockPath)).rejects.toThrow();
}

async function expectCurrentPidOwnsLock(params: {
  sessionFile: string;
  timeoutMs: number;
  staleMs?: number;
}) {
  const { sessionFile, timeoutMs, staleMs } = params;
  const lockPath = `${sessionFile}.lock`;
  const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs, staleMs });
  const raw = await fs.readFile(lockPath, "utf8");
  const payload = JSON.parse(raw) as { pid: number };
  expect(payload.pid).toBe(process.pid);
  await lock.release();
}

async function withTempSessionLockFile(
  run: (params: { root: string; sessionFile: string; lockPath: string }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
  try {
    const sessionFile = path.join(root, "sessions.json");
    await run({ root, sessionFile, lockPath: `${sessionFile}.lock` });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeCurrentProcessLock(lockPath: string, extra?: Record<string, unknown>) {
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ...extra,
    }),
    "utf8",
  );
}

async function expectActiveInProcessLockIsNotReclaimed(params?: {
  legacyStarttime?: unknown;
}): Promise<void> {
  await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
    const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    const lockPayload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ...(params && "legacyStarttime" in params ? { starttime: params.legacyStarttime } : {}),
    };
    await fs.writeFile(lockPath, JSON.stringify(lockPayload), "utf8");

    await expect(
      acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 50,
        allowReentrant: false,
      }),
    ).rejects.toThrow(/session file locked/);
    await lock.release();
  });
}

describe("acquireSessionWriteLock", () => {
  beforeAll(async () => {
    ({
      __testing,
      acquireSessionWriteLock,
      cleanStaleLockFiles,
      resetSessionWriteLockStateForTest,
      resolveSessionLockMaxHoldFromTimeout,
    } = await import("./session-write-lock.js"));
  });

  afterEach(() => {
    resetSessionWriteLockStateForTest();
    vi.restoreAllMocks();
  });
  it("reuses locks across symlinked session paths", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const realDir = path.join(root, "real");
      const linkDir = path.join(root, "link");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, linkDir);

      const sessionReal = path.join(realDir, "sessions.json");
      const sessionLink = path.join(linkDir, "sessions.json");
      const realLockPath = `${sessionReal}.lock`;
      const linkLockPath = `${sessionLink}.lock`;

      const lockA = await acquireSessionWriteLock({ sessionFile: sessionReal, timeoutMs: 500 });
      const lockB = await acquireSessionWriteLock({ sessionFile: sessionLink, timeoutMs: 500 });

      await expect(fs.access(realLockPath)).resolves.toBeUndefined();
      await expect(fs.access(linkLockPath)).resolves.toBeUndefined();
      const [realCanonicalLockPath, linkCanonicalLockPath] = await Promise.all([
        fs.realpath(realLockPath),
        fs.realpath(linkLockPath),
      ]);
      expect(linkCanonicalLockPath).toBe(realCanonicalLockPath);
      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath: realLockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the lock file until the last release", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const lockA = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    });
  });

  it("reclaims stale lock files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 123456, createdAt: new Date(Date.now() - 60_000).toISOString() }),
        "utf8",
      );

      await expectCurrentPidOwnsLock({ sessionFile, timeoutMs: 500, staleMs: 10 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reclaim fresh malformed lock files during contention", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(lockPath, "{}", "utf8");

      await expect(
        acquireSessionWriteLock({ sessionFile, timeoutMs: 50, staleMs: 60_000 }),
      ).rejects.toThrow(/session file locked/);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims malformed lock files once they are old enough", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      await fs.writeFile(lockPath, "{}", "utf8");
      const staleDate = new Date(Date.now() - 2 * 60_000);
      await fs.utimes(lockPath, staleDate, staleDate);

      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10_000 });
      await lock.release();
      await expect(fs.access(lockPath)).rejects.toThrow();
    });
  });

  it("watchdog releases stale in-process locks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sessionFile = path.join(root, "session.jsonl");
      const lockPath = `${sessionFile}.lock`;
      const lockA = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 500,
        maxHoldMs: 1,
      });

      const released = await __testing.runLockWatchdogCheck(Date.now() + 1000);
      expect(released).toBeGreaterThanOrEqual(1);
      await expect(fs.access(lockPath)).rejects.toThrow();

      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await expect(fs.access(lockPath)).resolves.toBeUndefined();

      // Old release handle must not affect the new lock.
      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    } finally {
      warnSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes lock files during process-exit cleanup", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      __testing.releaseAllLocksSync();

      await expect(fs.access(lockPath)).rejects.toThrow();
      await lock.release();
    });
  });

  it("derives max hold from timeout plus grace", () => {
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 600_000 })).toBe(720_000);
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 1_000, minMs: 5_000 })).toBe(121_000);
  });

  it("clamps max hold for effectively no-timeout runs", () => {
    expect(
      resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: 2_147_000_000,
      }),
    ).toBe(2_147_000_000);
  });

  it("cleans stale .jsonl lock files in sessions directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const nowMs = Date.now();
    const staleDeadLock = path.join(sessionsDir, "dead.jsonl.lock");
    const staleAliveLock = path.join(sessionsDir, "old-live.jsonl.lock");
    const freshAliveLock = path.join(sessionsDir, "fresh-live.jsonl.lock");

    try {
      await fs.writeFile(
        staleDeadLock,
        JSON.stringify({
          pid: 999_999,
          createdAt: new Date(nowMs - 120_000).toISOString(),
        }),
        "utf8",
      );
      await fs.writeFile(
        staleAliveLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 120_000).toISOString(),
        }),
        "utf8",
      );
      await fs.writeFile(
        freshAliveLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 1_000).toISOString(),
        }),
        "utf8",
      );

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
      });

      expect(result.locks).toHaveLength(3);
      expect(result.cleaned).toHaveLength(2);
      expect(result.cleaned.map((entry) => path.basename(entry.lockPath)).toSorted()).toEqual([
        "dead.jsonl.lock",
        "old-live.jsonl.lock",
      ]);

      await expect(fs.access(staleDeadLock)).rejects.toThrow();
      await expect(fs.access(staleAliveLock)).rejects.toThrow();
      await expect(fs.access(freshAliveLock)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes held locks on termination signals", async () => {
    const signals = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
    const originalKill = process.kill.bind(process);
    process.kill = ((_pid: number, _signal?: NodeJS.Signals) => true) as typeof process.kill;
    try {
      for (const signal of signals) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-cleanup-"));
        try {
          const sessionFile = path.join(root, "sessions.json");
          const lockPath = `${sessionFile}.lock`;
          await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
          const keepAlive = () => {};
          if (signal === "SIGINT") {
            process.on(signal, keepAlive);
          }

          __testing.handleTerminationSignal(signal);

          await expect(fs.stat(lockPath)).rejects.toThrow();
          if (signal === "SIGINT") {
            process.off(signal, keepAlive);
          }
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    } finally {
      process.kill = originalKill;
    }
  });

  it("reclaims lock files with recycled PIDs", async () => {
    if (process.platform !== "linux") {
      return;
    }
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      // Write a lock with a live PID (current process) but a wrong starttime,
      // simulating PID recycling: the PID is alive but belongs to a different
      // process than the one that created the lock.
      await writeCurrentProcessLock(lockPath, { starttime: 999_999_999 });

      await expectCurrentPidOwnsLock({ sessionFile, timeoutMs: 500 });
    });
  });

  it("reclaims orphan lock files without starttime when PID matches current process", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      // Simulate an old-format lock file left behind by a previous process
      // instance that reused the same PID (common in containers).
      await writeCurrentProcessLock(lockPath);

      await expectCurrentPidOwnsLock({ sessionFile, timeoutMs: 500 });
    });
  });

  it("does not reclaim active in-process lock files without starttime", async () => {
    await expectActiveInProcessLockIsNotReclaimed();
  });

  it("does not reclaim active in-process lock files with malformed starttime", async () => {
    await expectActiveInProcessLockIsNotReclaimed({ legacyStarttime: 123.5 });
  });

  it("registers cleanup for SIGQUIT and SIGABRT", () => {
    expect(__testing.cleanupSignals).toContain("SIGQUIT");
    expect(__testing.cleanupSignals).toContain("SIGABRT");
  });
  it("cleans up locks on SIGINT without removing other handlers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const originalKill = process.kill.bind(process);
    const killCalls: Array<NodeJS.Signals | undefined> = [];
    let otherHandlerCalled = false;

    process.kill = ((pid: number, signal?: NodeJS.Signals) => {
      killCalls.push(signal);
      return true;
    }) as typeof process.kill;

    const otherHandler = () => {
      otherHandlerCalled = true;
    };

    process.on("SIGINT", otherHandler);

    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      __testing.handleTerminationSignal("SIGINT");

      await expect(fs.access(lockPath)).rejects.toThrow();
      expect(otherHandlerCalled).toBe(false);
      expect(killCalls).toEqual([]);
    } finally {
      process.off("SIGINT", otherHandler);
      process.kill = originalKill;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up locks on exit", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      process.emit("exit", 0);

      await expect(fs.access(lockPath)).rejects.toThrow();
    });
  });

  it("does not accumulate exit listeners across reset cycles", async () => {
    const baselineExitListeners = process.listenerCount("exit");

    await withTempSessionLockFile(async ({ sessionFile }) => {
      for (let i = 0; i < 3; i += 1) {
        const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
        await lock.release();
        resetSessionWriteLockStateForTest();
        expect(process.listenerCount("exit")).toBe(baselineExitListeners);
      }
    });
  });

  it("keeps other signal listeners registered", () => {
    const keepAlive = () => {};
    const originalKill = process.kill.bind(process);
    process.kill = ((_pid: number, _signal?: NodeJS.Signals) => true) as typeof process.kill;
    process.on("SIGINT", keepAlive);

    try {
      __testing.handleTerminationSignal("SIGINT");
      expect(process.listeners("SIGINT")).toContain(keepAlive);
    } finally {
      process.off("SIGINT", keepAlive);
      process.kill = originalKill;
    }
  });
});
