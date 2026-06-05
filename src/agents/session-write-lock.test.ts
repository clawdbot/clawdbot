// Verifies session write locks handle reentrancy, stale locks, and symlinked paths.
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionWriteLockStaleError } from "./session-write-lock-error.js";

const FAKE_STARTTIME = 12345;
let testing: typeof import("./session-write-lock.js").testing;
let acquireSessionWriteLock: typeof import("./session-write-lock.js").acquireSessionWriteLock;
let cleanStaleLockFiles: typeof import("./session-write-lock.js").cleanStaleLockFiles;
let resetSessionWriteLockStateForTest: typeof import("./session-write-lock.js").resetSessionWriteLockStateForTest;
let resolveSessionLockMaxHoldFromTimeout: typeof import("./session-write-lock.js").resolveSessionLockMaxHoldFromTimeout;
let resolveSessionWriteLockAcquireTimeoutMs: typeof import("./session-write-lock.js").resolveSessionWriteLockAcquireTimeoutMs;
let resolveSessionWriteLockOptions: typeof import("./session-write-lock.js").resolveSessionWriteLockOptions;

async function expectLockRemovedOnlyAfterFinalRelease(params: {
  lockPath: string;
  firstLock: { release: () => Promise<void> };
  secondLock: { release: () => Promise<void> };
}) {
  // Reentrant locks share one file; only the final release removes it.
  await expect(fs.access(params.lockPath)).resolves.toBeUndefined();
  await params.firstLock.release();
  await expect(fs.access(params.lockPath)).resolves.toBeUndefined();
  await params.secondLock.release();
  await expectPathMissing(params.lockPath);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

function lockCleanupRecords(
  locks: Array<{ lockPath: string; removed: boolean; stale: boolean; staleReasons: string[] }>,
) {
  return locks.map((entry) => ({
    name: path.basename(entry.lockPath),
    removed: entry.removed,
    stale: entry.stale,
    staleReasons: entry.staleReasons,
  }));
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

function readFilePathToString(filePath: Parameters<typeof fs.readFile>[0]): string | undefined {
  if (typeof filePath === "string") {
    return filePath;
  }
  if (Buffer.isBuffer(filePath)) {
    return filePath.toString("utf8");
  }
  if (filePath instanceof URL) {
    return fileURLToPath(filePath);
  }
  return undefined;
}

async function withSymlinkedSessionPaths(
  run: (params: {
    sessionReal: string;
    sessionLink: string;
    realLockPath: string;
    linkLockPath: string;
  }) => Promise<void>,
) {
  // Symlinked session paths must resolve to the same lock ownership boundary.
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
    await run({
      sessionReal,
      sessionLink,
      realLockPath: `${sessionReal}.lock`,
      linkLockPath: `${sessionLink}.lock`,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function expectActiveInProcessLockIsNotReclaimed(params?: {
  legacyStarttime?: unknown;
  createdAt?: string;
}): Promise<void> {
  await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
    const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
    const lockPayload = {
      pid: process.pid,
      createdAt: params?.createdAt ?? new Date().toISOString(),
      ...(params && "legacyStarttime" in params ? { starttime: params.legacyStarttime } : {}),
    };
    await fs.writeFile(lockPath, JSON.stringify(lockPayload), "utf8");

    await expect(
      acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 5,
        allowReentrant: false,
      }),
    ).rejects.toThrow(/session file locked/);
    await lock.release();
  });
}

describe("acquireSessionWriteLock", () => {
  beforeAll(async () => {
    ({
      testing,
      acquireSessionWriteLock,
      cleanStaleLockFiles,
      resetSessionWriteLockStateForTest,
      resolveSessionLockMaxHoldFromTimeout,
      resolveSessionWriteLockAcquireTimeoutMs,
      resolveSessionWriteLockOptions,
    } = await import("./session-write-lock.js"));
  });

  afterEach(() => {
    resetSessionWriteLockStateForTest();
    vi.clearAllMocks();
  });

  function pinCurrentProcessStartTimeForTest(): void {
    testing.setProcessStartTimeResolverForTest((pid) =>
      pid === process.pid ? FAKE_STARTTIME : null,
    );
  }
  it("reuses locks across symlinked session paths", async () => {
    await withSymlinkedSessionPaths(
      async ({ sessionReal, sessionLink, realLockPath, linkLockPath }) => {
        const lockA = await acquireSessionWriteLock({
          sessionFile: sessionReal,
          timeoutMs: 500,
          allowReentrant: true,
        });
        const lockB = await acquireSessionWriteLock({
          sessionFile: sessionLink,
          timeoutMs: 500,
          allowReentrant: true,
        });

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
      },
    );
  });

  it("keeps the lock file until the last release", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const lockA = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 500,
        allowReentrant: true,
      });
      const lockB = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 500,
        allowReentrant: true,
      });

      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    });
  });

  it("does not reenter locks by default in the same process", async () => {
    await withTempSessionLockFile(async ({ sessionFile }) => {
      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await expect(
        acquireSessionWriteLock({ sessionFile, timeoutMs: 5, staleMs: 60_000 }),
      ).rejects.toThrow(/session file locked/);
      await lock.release();
    });
  });

  it("does not reenter locks by default through symlinked session paths", async () => {
    await withSymlinkedSessionPaths(async ({ sessionReal, sessionLink }) => {
      const lock = await acquireSessionWriteLock({ sessionFile: sessionReal, timeoutMs: 500 });

      await expect(
        acquireSessionWriteLock({ sessionFile: sessionLink, timeoutMs: 5, staleMs: 60_000 }),
      ).rejects.toThrow(/session file locked/);

      await lock.release();
    });
  });

  it("allows a new default lock acquisition after the held lock is released", async () => {
    await withTempSessionLockFile(async ({ sessionFile }) => {
      const lockA = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await expect(
        acquireSessionWriteLock({ sessionFile, timeoutMs: 5, staleMs: 60_000 }),
      ).rejects.toThrow(/session file locked/);
      await lockA.release();

      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await lockB.release();
    });
  });

  it("reclaims stale lock files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    try {
      const sessionFile = path.join(root, "sessions.json");
      const lockPath = `${sessionFile}.lock`;
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 2 ** 30, createdAt: new Date(Date.now() - 60_000).toISOString() }),
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
        acquireSessionWriteLock({ sessionFile, timeoutMs: 5, staleMs: 60_000 }),
      ).rejects.toThrow(/session file locked/);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves short-timeout recovery for payload-less orphan lock files", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      await fs.writeFile(lockPath, "", "utf8");
      const orphanDate = new Date(Date.now() - 10_000);
      await fs.utimes(lockPath, orphanDate, orphanDate);

      const lock = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 500,
        staleMs: 60_000,
      });
      const raw = await fs.readFile(lockPath, "utf8");
      const payload = JSON.parse(raw) as { pid?: unknown };
      expect(payload.pid).toBe(process.pid);
      await lock.release();
    });
  });

  it("reclaims payload-less orphan lock files past the 30s init grace", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      await fs.writeFile(lockPath, "", "utf8");
      const orphanDate = new Date(Date.now() - 35_000);
      await fs.utimes(lockPath, orphanDate, orphanDate);

      // 35s > 30s grace, so the payload-less lock is reclaimed.
      const lock = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 30_000,
        staleMs: 60_000,
      });
      const raw = await fs.readFile(lockPath, "utf8");
      const payload = JSON.parse(raw) as { pid?: unknown };
      expect(payload.pid).toBe(process.pid);
      await lock.release();
    });
  });

  it("preserves payload-less lock files within the 30s cleanup grace", async () => {
    await withTempSessionLockFile(async ({ root }) => {
      const lockPath = path.join(root, "sessions.jsonl.lock");
      await fs.writeFile(lockPath, "", "utf8");
      const orphanDate = new Date(Date.now() - 10_000);
      await fs.utimes(lockPath, orphanDate, orphanDate);

      const result = await cleanStaleLockFiles({
        sessionsDir: root,
        staleMs: 60_000,
        removeStale: true,
      });

      expect(result.cleaned).toEqual([]);
      expect(result.locks).toHaveLength(1);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    });
  });

  it("reclaims malformed lock files once they are old enough", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      await fs.writeFile(lockPath, "{}", "utf8");
      const staleDate = new Date(Date.now() - 2 * 60_000);
      await fs.utimes(lockPath, staleDate, staleDate);

      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10_000 });
      await lock.release();
      await expectPathMissing(lockPath);
    });
  });

  it("marks live lock payloads stale once they exceed max hold", () => {
    const nowMs = Date.now();
    const inspected = testing.inspectLockPayloadForTest(
      {
        pid: process.pid,
        createdAt: new Date(nowMs - 30_000).toISOString(),
        maxHoldMs: 10_000,
      },
      60_000,
      nowMs,
      { respectMaxHold: true },
    );

    expect(inspected.stale).toBe(true);
    expect(inspected.staleReasons).toEqual(["hold-exceeded"]);
  });

  it("keeps live lock payloads fresh until their recorded holder max hold expires", () => {
    const nowMs = Date.now();
    const inspected = testing.inspectLockPayloadForTest(
      {
        pid: process.pid,
        createdAt: new Date(nowMs - 30_000).toISOString(),
        maxHoldMs: 60_000,
      },
      60_000,
      nowMs,
      { respectMaxHold: true },
    );

    expect(inspected.stale).toBe(false);
    expect(inspected.staleReasons).toEqual([]);
  });

  it("does not reclaim an active in-process lock through max-hold acquisition", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, maxHoldMs: 1 });
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(Date.now() - 30_000).toISOString(),
          maxHoldMs: 1,
        }),
        "utf8",
      );

      await expect(
        acquireSessionWriteLock({
          sessionFile,
          timeoutMs: 5,
          staleMs: 60_000,
          allowReentrant: false,
        }),
      ).rejects.toThrow(/session file locked/);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
      await lock.release();
    });
  });

  it("does not report or remove active in-process locks that pass staleMs", async () => {
    await expectActiveInProcessLockIsNotReclaimed({
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
  });

  it("reports live OpenClaw-owned stale locks without removing them", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "openclaw"], {
        stdio: "ignore",
      });
      if (!owner.pid) {
        throw new Error("missing lock owner pid");
      }
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: owner.pid,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
        }),
        "utf8",
      );

      try {
        await expect(
          acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10 }),
        ).rejects.toMatchObject({
          name: "SessionWriteLockStaleError",
          staleReasons: ["too-old"],
        });
        await expect(
          acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10 }),
        ).rejects.toBeInstanceOf(SessionWriteLockStaleError);
        await expect(fs.access(lockPath)).resolves.toBeUndefined();
      } finally {
        owner.kill("SIGTERM");
      }
    });
  });

  it("retries when a stale lock report disappears before diagnostics", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "openclaw"], {
        stdio: "ignore",
      });
      if (!owner.pid) {
        throw new Error("missing lock owner pid");
      }
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: owner.pid,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
        }),
        "utf8",
      );

      const originalReadFile = fs.readFile.bind(fs);
      let lockReads = 0;
      const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((async (
        filePath,
        options,
      ) => {
        const lockFilePath = readFilePathToString(filePath);
        if (lockFilePath && path.basename(lockFilePath) === path.basename(lockPath)) {
          lockReads += 1;
          if (lockReads === 3) {
            await fs.rm(lockFilePath, { force: true });
            await fs.rm(lockPath, { force: true });
            throw Object.assign(new Error("lock disappeared"), { code: "ENOENT" });
          }
        }
        return await originalReadFile(filePath, options as never);
      }) as typeof fs.readFile);

      try {
        const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10 });
        await lock.release();
        expect(lockReads).toBeGreaterThanOrEqual(3);
        await expectPathMissing(lockPath);
      } finally {
        readFileSpy.mockRestore();
        owner.kill("SIGTERM");
      }
    });
  });

  it("retries when a stale lock report is replaced before diagnostics", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "openclaw"], {
        stdio: "ignore",
      });
      if (!owner.pid) {
        throw new Error("missing lock owner pid");
      }
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: owner.pid,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
        }),
        "utf8",
      );

      const originalReadFile = fs.readFile.bind(fs);
      let lockReads = 0;
      const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((async (
        filePath,
        options,
      ) => {
        const lockFilePath = readFilePathToString(filePath);
        if (lockFilePath && path.basename(lockFilePath) === path.basename(lockPath)) {
          lockReads += 1;
          if (lockReads === 3) {
            await fs.rm(lockFilePath, { force: true });
            await fs.rm(lockPath, { force: true });
            await fs.writeFile(
              lockFilePath,
              JSON.stringify({ pid: owner.pid, createdAt: new Date().toISOString() }),
              "utf8",
            );
            setTimeout(() => {
              void fs.rm(lockFilePath, { force: true });
            }, 10);
            throw Object.assign(new Error("lock disappeared"), { code: "ENOENT" });
          }
        }
        return await originalReadFile(filePath, options as never);
      }) as typeof fs.readFile);

      try {
        const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500, staleMs: 10 });
        await lock.release();
        expect(lockReads).toBeGreaterThanOrEqual(3);
        await expectPathMissing(lockPath);
      } finally {
        readFileSpy.mockRestore();
        owner.kill("SIGTERM");
      }
    });
  });

  it("retries when a stale lock report is replaced by a fresh payload-less lock", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "openclaw"], {
        stdio: "ignore",
      });
      if (!owner.pid) {
        throw new Error("missing lock owner pid");
      }
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: owner.pid,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
        }),
        "utf8",
      );

      const originalReadFile = fs.readFile.bind(fs);
      let lockReads = 0;
      const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((async (
        filePath,
        options,
      ) => {
        const lockFilePath = readFilePathToString(filePath);
        if (lockFilePath && path.basename(lockFilePath) === path.basename(lockPath)) {
          lockReads += 1;
          if (lockReads === 3) {
            await fs.rm(lockFilePath, { force: true });
            await fs.writeFile(lockFilePath, "", "utf8");
            setTimeout(() => {
              void fs.rm(lockFilePath, { force: true });
            }, 10);
          }
        }
        return await originalReadFile(filePath, options as never);
      }) as typeof fs.readFile);

      try {
        const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 800, staleMs: 10 });
        await lock.release();
        expect(lockReads).toBeGreaterThanOrEqual(3);
        await expectPathMissing(lockPath);
      } finally {
        readFileSpy.mockRestore();
        owner.kill("SIGTERM");
      }
    });
  });

  it("watchdog releases stale in-process locks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const sessionFile = path.join(root, "session.jsonl");
      const lockPath = `${sessionFile}.lock`;
      const lockA = await acquireSessionWriteLock({
        sessionFile,
        timeoutMs: 500,
        maxHoldMs: 1,
      });

      const released = await testing.runLockWatchdogCheck(Date.now() + 1000);
      expect(released).toBe(1);
      await expectPathMissing(lockPath);

      const lockB = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await expect(fs.access(lockPath)).resolves.toBeUndefined();

      // Old release handle must not affect the new lock.
      await expectLockRemovedOnlyAfterFinalRelease({
        lockPath,
        firstLock: lockA,
        secondLock: lockB,
      });
    } finally {
      stderrSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes lock files during process-exit cleanup", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });

      testing.releaseAllLocksSync();

      await expectPathMissing(lockPath);
      await lock.release();
    });
  });

  it("derives max hold from timeout plus grace", () => {
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 600_000 })).toBe(720_000);
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 1_000, minMs: 5_000 })).toBe(121_000);
  });

  it("resolves the session write-lock acquire timeout", () => {
    expect(resolveSessionWriteLockAcquireTimeoutMs()).toBe(60_000);
    expect(
      resolveSessionWriteLockAcquireTimeoutMs({
        session: { writeLock: { acquireTimeoutMs: 90_000 } },
      }),
    ).toBe(90_000);
    expect(
      resolveSessionWriteLockAcquireTimeoutMs({
        session: { writeLock: { acquireTimeoutMs: 0 } },
      }),
    ).toBe(60_000);
  });

  it("resolves session write-lock stale and max-hold policy", () => {
    expect(
      resolveSessionWriteLockOptions({
        session: {
          writeLock: {
            acquireTimeoutMs: 90_000,
            staleMs: 45_000,
            maxHoldMs: 30_000,
          },
        },
      }),
    ).toEqual({
      timeoutMs: 90_000,
      staleMs: 45_000,
      maxHoldMs: 30_000,
    });
  });

  it("lets session write-lock env override config for emergency tuning", () => {
    expect(
      resolveSessionWriteLockOptions(
        {
          session: {
            writeLock: {
              acquireTimeoutMs: 90_000,
              staleMs: 45_000,
              maxHoldMs: 30_000,
            },
          },
        },
        {
          env: {
            OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS: "120000",
            OPENCLAW_SESSION_WRITE_LOCK_STALE_MS: "60000",
            OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS: "50000",
          },
        },
      ),
    ).toEqual({
      timeoutMs: 120_000,
      staleMs: 60_000,
      maxHoldMs: 50_000,
    });
  });

  it("ignores non-decimal and unsafe session write-lock env values", () => {
    expect(
      resolveSessionWriteLockOptions(
        {
          session: {
            writeLock: {
              acquireTimeoutMs: 90_000,
              staleMs: 45_000,
              maxHoldMs: 30_000,
            },
          },
        },
        {
          env: {
            OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS: "1e3",
            OPENCLAW_SESSION_WRITE_LOCK_STALE_MS: "0x1000",
            OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS: "9007199254740993",
          },
        },
      ),
    ).toEqual({
      timeoutMs: 90_000,
      staleMs: 45_000,
      maxHoldMs: 30_000,
    });
  });

  it("allows explicit infinite acquire timeout but not infinite stale policy", () => {
    expect(
      resolveSessionWriteLockOptions(undefined, {
        env: {
          OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS: "Infinity",
          OPENCLAW_SESSION_WRITE_LOCK_STALE_MS: "Infinity",
        },
      }),
    ).toMatchObject({
      timeoutMs: Number.POSITIVE_INFINITY,
      staleMs: 30 * 60 * 1000,
    });
  });

  it("preserves one acquire timeout budget across retries", () => {
    expect(testing.resolveRemainingAcquireTimeoutMs(500, 1_000, 1_125)).toBe(375);
    expect(testing.resolveRemainingAcquireTimeoutMs(500, 1_000, 1_500)).toBe(0);
    expect(testing.resolveRemainingAcquireTimeoutMs(Number.POSITIVE_INFINITY, 1_000, 9_000)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("uses resolved stale policy when cleaning stale lock files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-policy-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const nowMs = Date.now();
    const lockPath = path.join(sessionsDir, "configured-live.jsonl.lock");

    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 45_000).toISOString(),
        }),
        "utf8",
      );

      const configOnly = await cleanStaleLockFiles({
        sessionsDir,
        config: { session: { writeLock: { staleMs: 30_000 } } },
        nowMs,
        removeStale: false,
        readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
      });
      expect(configOnly.locks[0]?.stale).toBe(true);

      const envOverride = await cleanStaleLockFiles({
        sessionsDir,
        config: { session: { writeLock: { staleMs: 30_000 } } },
        env: { OPENCLAW_SESSION_WRITE_LOCK_STALE_MS: "60000" },
        nowMs,
        removeStale: false,
        readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "doctor"],
      });
      expect(envOverride.locks[0]?.stale).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not clean live OpenClaw locks just because holder max hold expired", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-policy-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const nowMs = Date.now();
    const lockPath = path.join(sessionsDir, "held-past-max.jsonl.lock");

    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 30_000).toISOString(),
          maxHoldMs: 10_000,
        }),
        "utf8",
      );

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 60_000,
        nowMs,
        removeStale: true,
        readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "agent"],
      });

      expect(lockCleanupRecords(result.locks)).toEqual([
        {
          name: "held-past-max.jsonl.lock",
          removed: false,
          stale: false,
          staleReasons: [],
        },
      ]);
      expect(result.cleaned).toEqual([]);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("clamps max hold for effectively no-timeout runs", () => {
    expect(
      resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
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
        readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "agent"],
      });

      expect(result.locks).toHaveLength(3);
      expect(lockCleanupRecords(result.locks)).toEqual([
        {
          name: "dead.jsonl.lock",
          removed: true,
          stale: true,
          staleReasons: ["dead-pid", "too-old"],
        },
        {
          name: "fresh-live.jsonl.lock",
          removed: false,
          stale: false,
          staleReasons: [],
        },
        {
          name: "old-live.jsonl.lock",
          removed: false,
          stale: true,
          staleReasons: ["too-old"],
        },
      ]);
      expect(lockCleanupRecords(result.cleaned)).toEqual([
        {
          name: "dead.jsonl.lock",
          removed: true,
          stale: true,
          staleReasons: ["dead-pid", "too-old"],
        },
      ]);

      await expectPathMissing(staleDeadLock);
      await expect(fs.access(staleAliveLock)).resolves.toBeUndefined();
      await expect(fs.access(freshAliveLock)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans old live .jsonl lock files owned by non-OpenClaw processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const nowMs = Date.now();
    const lockPath = path.join(sessionsDir, "old-non-openclaw.jsonl.lock");

    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs - 120_000).toISOString(),
        }),
        "utf8",
      );

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
        readOwnerProcessArgs: () => ["python", "worker.py"],
      });

      expect(lockCleanupRecords(result.cleaned)).toEqual([
        {
          name: "old-non-openclaw.jsonl.lock",
          removed: true,
          stale: true,
          staleReasons: ["too-old", "non-openclaw-owner"],
        },
      ]);
      await expectPathMissing(lockPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not clean fresh malformed .jsonl lock files during cleanup sweeps", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const nowMs = Date.now();
    const lockPath = path.join(sessionsDir, "fresh-malformed.jsonl.lock");

    try {
      await fs.writeFile(lockPath, "{}", "utf8");

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
      });

      expect(lockCleanupRecords(result.locks)).toEqual([
        {
          name: "fresh-malformed.jsonl.lock",
          removed: false,
          stale: true,
          staleReasons: ["missing-pid", "invalid-createdAt"],
        },
      ]);
      expect(result.cleaned).toEqual([]);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans fresh live .jsonl lock files owned by a non-OpenClaw process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const nowMs = Date.now();
    const falseLiveLock = path.join(sessionsDir, "false-live.jsonl.lock");

    try {
      await fs.writeFile(
        falseLiveLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs).toISOString(),
        }),
        "utf8",
      );

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
        readOwnerProcessArgs: () => ["python", "worker.py"],
      });

      expect(lockCleanupRecords(result.locks)).toEqual([
        {
          name: "false-live.jsonl.lock",
          removed: true,
          stale: true,
          staleReasons: ["non-openclaw-owner"],
        },
      ]);
      expect(lockCleanupRecords(result.cleaned)).toEqual([
        {
          name: "false-live.jsonl.lock",
          removed: true,
          stale: true,
          staleReasons: ["non-openclaw-owner"],
        },
      ]);
      await expect(fs.access(falseLiveLock)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans fresh live .jsonl lock files owned by generic non-OpenClaw entrypoints", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const nowMs = Date.now();
    const falseLiveLock = path.join(sessionsDir, "false-live-generic-entry.jsonl.lock");

    try {
      await fs.writeFile(
        falseLiveLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs).toISOString(),
        }),
        "utf8",
      );

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
        readOwnerProcessArgs: () => ["node", "/srv/app/dist/index.js"],
      });

      expect(lockCleanupRecords(result.cleaned)).toEqual([
        {
          name: "false-live-generic-entry.jsonl.lock",
          removed: true,
          stale: true,
          staleReasons: ["non-openclaw-owner"],
        },
      ]);
      await expect(fs.access(falseLiveLock)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("memoizes readOwnerProcessArgs across locks with the same pid in one sweep (#86509)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const nowMs = Date.now();
    const lockCount = 5;
    try {
      for (let i = 0; i < lockCount; i++) {
        await fs.writeFile(
          path.join(sessionsDir, `same-pid-${i}.jsonl.lock`),
          JSON.stringify({ pid: process.pid, createdAt: new Date(nowMs).toISOString() }),
          "utf8",
        );
      }
      const readArgsCalls: number[] = [];
      const readOwnerProcessArgs = (pid: number) => {
        readArgsCalls.push(pid);
        return ["node", "/srv/app/dist/index.js"];
      };
      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
        readOwnerProcessArgs,
      });
      expect(result.cleaned).toHaveLength(lockCount);
      // Without memo this would be `lockCount`; the per-pid cache collapses it to a single call.
      expect(readArgsCalls).toEqual([process.pid]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not poison the per-pid memo when readOwnerProcessArgs throws (#86509)", async () => {
    // A helper one layer up (`readOwnerProcessArgs`) already catches thrown resolvers and
    // returns null, so `cleanStaleLockFiles` never propagates the throw — but a naive memo
    // could still cache that null-equivalent failure and short-circuit later locks for the
    // same pid. The fix writes the cache only after the resolver returns, so each lock
    // retries the resolver fresh after a throw.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const nowMs = Date.now();
    const lockCount = 3;
    try {
      for (let i = 0; i < lockCount; i++) {
        await fs.writeFile(
          path.join(sessionsDir, `throwing-${i}.jsonl.lock`),
          JSON.stringify({ pid: process.pid, createdAt: new Date(nowMs).toISOString() }),
          "utf8",
        );
      }
      let throwCalls = 0;
      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
        readOwnerProcessArgs: () => {
          throwCalls++;
          throw new Error("transient resolver failure");
        },
      });
      // Resolver is invoked once per lock — the throw is not cached as a no-args entry.
      expect(throwCalls).toBe(lockCount);
      expect(result.cleaned).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps fresh live .jsonl lock files with OpenClaw or unknown owners", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const nowMs = Date.now();
    const openclawLock = path.join(sessionsDir, "openclaw-live.jsonl.lock");
    const gatewayLock = path.join(sessionsDir, "gateway-live.jsonl.lock");
    const unknownLock = path.join(sessionsDir, "unknown-live.jsonl.lock");

    try {
      await fs.writeFile(
        openclawLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs).toISOString(),
        }),
        "utf8",
      );
      const openclawResult = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
        readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "agent"],
      });

      expect(openclawResult.cleaned).toEqual([]);
      await expect(fs.access(openclawLock)).resolves.toBeUndefined();

      await fs.rm(openclawLock, { force: true });
      await fs.writeFile(
        gatewayLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs).toISOString(),
        }),
        "utf8",
      );
      const gatewayResult = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
        readOwnerProcessArgs: () => ["node", "dist/index.js", "gateway", "run"],
      });

      expect(gatewayResult.cleaned).toEqual([]);
      await expect(fs.access(gatewayLock)).resolves.toBeUndefined();

      await fs.rm(gatewayLock, { force: true });
      await fs.writeFile(
        unknownLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs).toISOString(),
        }),
        "utf8",
      );
      const unknownResult = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
        readOwnerProcessArgs: () => null,
      });

      expect(unknownResult.cleaned).toEqual([]);
      await expect(fs.access(unknownLock)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans untracked current-process .jsonl lock files with matching starttime", async () => {
    pinCurrentProcessStartTimeForTest();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const nowMs = Date.now();
    const orphanSelfLock = path.join(sessionsDir, "orphan-self.jsonl.lock");

    try {
      await fs.writeFile(
        orphanSelfLock,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date(nowMs).toISOString(),
          starttime: FAKE_STARTTIME,
        }),
        "utf8",
      );

      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: 30_000,
        nowMs,
        removeStale: true,
      });

      expect(lockCleanupRecords(result.locks)).toEqual([
        {
          name: "orphan-self.jsonl.lock",
          removed: true,
          stale: true,
          staleReasons: ["orphan-self-pid"],
        },
      ]);
      expect(lockCleanupRecords(result.cleaned)).toEqual([
        {
          name: "orphan-self.jsonl.lock",
          removed: true,
          stale: true,
          staleReasons: ["orphan-self-pid"],
        },
      ]);
      await expectPathMissing(orphanSelfLock);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retries when a reported stale same-process lock disappears before recovery", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          starttime: FAKE_STARTTIME,
        }),
        "utf8",
      );
      let resolverCalls = 0;
      testing.setProcessStartTimeResolverForTest((pid) => {
        if (pid !== process.pid) {
          return null;
        }
        resolverCalls += 1;
        if (resolverCalls === 1) {
          fsSync.rmSync(lockPath, { force: true });
        }
        return FAKE_STARTTIME;
      });

      const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 500 });
      await lock.release();
      expect(resolverCalls).toBeGreaterThan(0);
    });
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

          testing.handleTerminationSignal(signal);

          await expectPathMissing(lockPath);
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
      pinCurrentProcessStartTimeForTest();
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

  it("reclaims untracked current-process lock files with matching starttime", async () => {
    await withTempSessionLockFile(async ({ sessionFile, lockPath }) => {
      pinCurrentProcessStartTimeForTest();
      await writeCurrentProcessLock(lockPath, { starttime: FAKE_STARTTIME });

      await expectCurrentPidOwnsLock({ sessionFile, timeoutMs: 500 });
    });
  });

  it("does not reclaim active in-process lock files without starttime", async () => {
    await expectActiveInProcessLockIsNotReclaimed();
  });

  it("does not reclaim active in-process lock files with malformed starttime", async () => {
    await expectActiveInProcessLockIsNotReclaimed({ legacyStarttime: 123.5 });
  });

  it("does not reclaim active in-process lock files with matching starttime", async () => {
    pinCurrentProcessStartTimeForTest();
    await expectActiveInProcessLockIsNotReclaimed({ legacyStarttime: FAKE_STARTTIME });
  });

  it("registers cleanup for SIGQUIT and SIGABRT", () => {
    expect(testing.cleanupSignals).toContain("SIGQUIT");
    expect(testing.cleanupSignals).toContain("SIGABRT");
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

      testing.handleTerminationSignal("SIGINT");

      await expectPathMissing(lockPath);
      expect(otherHandlerCalled).toBe(false);
      expect(killCalls).toStrictEqual([]);
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

      await expectPathMissing(lockPath);
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
      testing.handleTerminationSignal("SIGINT");
      expect(process.listeners("SIGINT")).toContain(keepAlive);
    } finally {
      process.off("SIGINT", keepAlive);
      process.kill = originalKill;
    }
  });
});
