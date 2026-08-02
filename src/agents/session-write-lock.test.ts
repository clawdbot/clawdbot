import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  acquireSessionWriteLock,
  drainSessionWriteLockStateForTest,
  resolveSessionLockMaxHoldFromTimeout,
  resolveSessionWriteLockAcquireTimeoutMs,
  resolveSessionWriteLockOptions,
  resolveSessionWriteLockTargetKey,
} from "./session-write-lock.js";
import { resetSessionWriteLockStateForTest, testing } from "./session-write-lock.test-support.js";

describe("SQLite session write leases", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-lease-"));
  });

  afterEach(async () => {
    await drainSessionWriteLockStateForTest();
    resetSessionWriteLockStateForTest();
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function target(overrides: { agentId?: string; sessionId?: string; storePath?: string } = {}) {
    return resolveSessionWriteLockTargetKey({
      agentId: overrides.agentId ?? "main",
      sessionId: overrides.sessionId ?? "session-a",
      sessionKey: "agent:main:ignored-alias",
      storePath: overrides.storePath ?? path.join(root, "openclaw-agent.sqlite"),
    });
  }

  async function acquire(
    sessionFile = target(),
    options: {
      timeoutMs?: number;
      maxHoldMs?: number;
      signal?: AbortSignal;
      allowReentrant?: boolean;
    } = {},
  ) {
    return await acquireSessionWriteLock({
      sessionFile,
      targetKind: "session-key",
      ...options,
    });
  }

  it("serializes writers in SQLite without creating a sidecar", async () => {
    const sessionFile = target();
    const first = await acquire(sessionFile);

    await expect(acquire(sessionFile, { timeoutMs: 5 })).rejects.toThrow(/session file locked/);
    await expect(fs.access(`${sessionFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

    await first.release();
    const second = await acquire(sessionFile, { timeoutMs: 500 });
    expect(() => second.assertOwned?.()).not.toThrow();
    await second.release();
  });

  it("reference-counts intentional process-local reentrancy", async () => {
    const sessionFile = target();
    const first = await acquire(sessionFile, { allowReentrant: true });
    const second = await acquire(sessionFile, { allowReentrant: true });

    await first.release();
    expect(() => second.assertOwned?.()).not.toThrow();
    await expect(acquire(sessionFile, { timeoutMs: 5 })).rejects.toThrow(/session file locked/);
    await second.release();
    const next = await acquire(sessionFile, { timeoutMs: 500 });
    await next.release();
  });

  it("coalesces repeated release and never erases a successor", async () => {
    const sessionFile = target();
    const first = await acquire(sessionFile);
    await Promise.all([first.release(), first.release()]);

    const successor = await acquire(sessionFile, { timeoutMs: 500 });
    await first.release();
    expect(() => successor.assertOwned?.()).not.toThrow();
    await successor.release();
  });

  it("uses abort only for admission", async () => {
    const alreadyAborted = new AbortController();
    const reason = new Error("stop requested");
    alreadyAborted.abort(reason);
    await expect(acquire(target(), { signal: alreadyAborted.signal })).rejects.toBe(reason);

    const admittedAbort = new AbortController();
    const lock = await acquire(target({ sessionId: "session-b" }), {
      signal: admittedAbort.signal,
    });
    admittedAbort.abort(new Error("late abort"));
    expect(() => lock.assertOwned?.()).not.toThrow();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("aborts while waiting without affecting the current owner", async () => {
    const sessionFile = target();
    const held = await acquire(sessionFile);
    const abort = new AbortController();
    const reason = new Error("stop waiting");
    const pending = acquire(sessionFile, {
      timeoutMs: Number.POSITIVE_INFINITY,
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);

    abort.abort(reason);

    await rejected;
    expect(() => held.assertOwned?.()).not.toThrow();
    await held.release();
    const successor = await acquire(sessionFile, { timeoutMs: 500 });
    await successor.release();
  });

  it("does not time-take over a live lease owner", async () => {
    testing.setProcessStartTimeResolverForTest(() => null);
    const sessionFile = target();
    const first = await acquire(sessionFile, { maxHoldMs: 5 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });

    await expect(acquire(sessionFile, { maxHoldMs: 1_000, timeoutMs: 5 })).rejects.toThrow(
      /session file locked/,
    );
    expect(() => first.assertOwned?.()).not.toThrow();
    await first.release();
  });

  it("invalidates held handles during synchronous process cleanup", async () => {
    const lock = await acquire();
    testing.releaseAllLocksSync();
    expect(() => lock.assertOwned?.()).toThrow(/lease-lost/);
    await expect(lock.release()).resolves.toBeUndefined();
    const next = await acquire(target(), { timeoutMs: 500 });
    await next.release();
  });

  it("namespaces independent transcript targets", async () => {
    const main = await acquire(target({ agentId: "main", sessionId: "main-session" }));
    const worker = await acquire(
      target({
        agentId: "worker",
        sessionId: "worker-session",
        storePath: path.join(root, "worker", "openclaw-agent.sqlite"),
      }),
    );
    await Promise.all([main.release(), worker.release()]);
  });

  it("uses one key for session aliases and legacy/SQLite store locators", () => {
    const base = {
      agentId: "main",
      sessionId: "shared-session",
      sessionKey: "agent:main:alias-a",
    };
    expect(
      resolveSessionWriteLockTargetKey({ ...base, storePath: path.join(root, "sessions.json") }),
    ).toBe(
      resolveSessionWriteLockTargetKey({
        ...base,
        sessionKey: "agent:main:alias-b",
        storePath: path.join(root, "openclaw-agent.sqlite"),
      }),
    );
  });

  it.runIf(process.platform !== "win32")(
    "keeps the key stable when a missing directory appears beneath a symlink",
    async () => {
      const realRoot = path.join(root, "real");
      const linkedRoot = path.join(root, "linked");
      await fs.mkdir(realRoot);
      await fs.symlink(realRoot, linkedRoot);
      const transcript = {
        agentId: "main",
        sessionId: "shared-session",
        sessionKey: "agent:main:main",
        storePath: path.join(linkedRoot, "new-agent", "sessions.json"),
      };
      const before = resolveSessionWriteLockTargetKey(transcript);
      await fs.mkdir(path.join(linkedRoot, "new-agent"));
      expect(resolveSessionWriteLockTargetKey(transcript)).toBe(before);
    },
  );
});

describe("session write lease options", () => {
  it("derives bounded max hold from timeout plus grace", () => {
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 600_000 })).toBe(720_000);
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: 1_000, minMs: 5_000 })).toBe(121_000);
    expect(resolveSessionLockMaxHoldFromTimeout({ timeoutMs: Number.POSITIVE_INFINITY })).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("uses the built-in acquire timeout", () => {
    expect(resolveSessionWriteLockAcquireTimeoutMs()).toBe(60_000);
  });

  it("accepts decimal emergency overrides", () => {
    expect(
      resolveSessionWriteLockOptions(undefined, {
        env: {
          OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS: "120000",
          OPENCLAW_SESSION_WRITE_LOCK_STALE_MS: "60000",
          OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS: "50000",
        },
      }),
    ).toEqual({ timeoutMs: 120_000, staleMs: 60_000, maxHoldMs: 50_000 });
  });

  it("ignores non-decimal, unsafe, and unsupported infinite overrides", () => {
    expect(
      resolveSessionWriteLockOptions(undefined, {
        env: {
          OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS: "Infinity",
          OPENCLAW_SESSION_WRITE_LOCK_STALE_MS: "0x1000",
          OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS: "9007199254740993",
        },
      }),
    ).toEqual({
      timeoutMs: Number.POSITIVE_INFINITY,
      staleMs: 30 * 60_000,
      maxHoldMs: 5 * 60_000,
    });
  });
});
