import { describe, expect, it } from "vitest";
import {
  acquireSessionWriteLock,
  resolveSessionWriteLockAcquireTimeoutMs,
  resolveSessionWriteLockOptions,
} from "./session-write-lock-runtime.js";

describe("Plugin SDK session write-lock compatibility stubs", () => {
  it("returns an inert owned handle for legacy file and session-key calls", async () => {
    const fileLock = await acquireSessionWriteLock({
      sessionFile: "/retired/session.jsonl",
      targetKind: "file",
    });
    const sessionLock = await acquireSessionWriteLock({
      sessionFile: "agent:main:main",
      targetKind: "session-key",
    });

    for (const lock of [fileLock, sessionLock]) {
      expect(() => lock.assertOwned()).not.toThrow();
      await expect(lock.release()).resolves.toBeUndefined();
    }
  });

  it("retains the historical resolver defaults", () => {
    expect(
      resolveSessionWriteLockAcquireTimeoutMs(undefined, {
        OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS: "1",
      }),
    ).toBe(60_000);
    expect(
      resolveSessionWriteLockOptions(undefined, {
        env: {
          OPENCLAW_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS: "1",
          OPENCLAW_SESSION_WRITE_LOCK_STALE_MS: "1",
          OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS: "1",
        },
        maxHoldMsFallback: 1,
      }),
    ).toEqual({ timeoutMs: 60_000, staleMs: 1_800_000, maxHoldMs: 300_000 });
  });
});
