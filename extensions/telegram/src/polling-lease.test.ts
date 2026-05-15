import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireTelegramPollingLease,
  releaseStoppedTelegramPollingLease,
  resetTelegramPollingLeasesForTests,
} from "./polling-lease.js";

describe("Telegram polling lease", () => {
  beforeEach(() => {
    resetTelegramPollingLeasesForTests();
  });

  it("refuses an active duplicate poller for the same bot token", async () => {
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
      }),
    ).rejects.toThrow('refusing duplicate poller for account "ops"');

    first.release();
  });

  it("allows concurrent pollers for different bot tokens", async () => {
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });
    const second = await acquireTelegramPollingLease({
      token: "456:def",
      accountId: "ops",
    });

    expect(first.tokenFingerprint).not.toBe(second.tokenFingerprint);

    first.release();
    second.release();
  });

  it("waits for an aborting same-token poller before acquiring", async () => {
    const oldAbort = new AbortController();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      abortSignal: oldAbort.signal,
    });
    oldAbort.abort();

    const acquire = acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      waitMs: 1_000,
    });
    await Promise.resolve();
    first.release();
    const second = await acquire;

    expect(second.waitedForPrevious).toBe(true);
    expect(second.replacedStoppingPrevious).toBe(false);

    second.release();
  });

  it("does not let stale release clear a replacement lease", async () => {
    vi.useFakeTimers();
    try {
      const oldAbort = new AbortController();
      const first = await acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "old",
        abortSignal: oldAbort.signal,
      });
      oldAbort.abort();

      const acquireReplacement = acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "new",
        waitMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      const replacement = await acquireReplacement;
      expect(replacement.replacedStoppingPrevious).toBe(true);

      first.release();

      await expect(
        acquireTelegramPollingLease({
          token: "123:abc",
          accountId: "third",
        }),
      ).rejects.toThrow('account "new"');

      replacement.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release a no-signal active lease", async () => {
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
      }),
    ).rejects.toThrow('refusing duplicate poller for account "ops"');

    await expect(
      releaseStoppedTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
      }),
    ).resolves.toBe(false);

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
      }),
    ).rejects.toThrow('account "default"');

    first.release();
  });

  it("does not release a non-aborted active lease", async () => {
    const abort = new AbortController();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      abortSignal: abort.signal,
    });

    await expect(
      releaseStoppedTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
      }),
    ).resolves.toBe(false);

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
      }),
    ).rejects.toThrow('account "default"');

    first.release();
  });

  it("releases an aborted same-account lease after the stop wait elapses", async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const first = await acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
        abortSignal: abort.signal,
      });
      abort.abort();

      const release = releaseStoppedTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
        waitMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(release).resolves.toBe(true);

      const next = await acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
      });
      next.release();
      first.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an aborted same-account lease immediately with no stop wait", async () => {
    const abort = new AbortController();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      abortSignal: abort.signal,
    });
    abort.abort();

    await expect(
      releaseStoppedTelegramPollingLease({
        token: "123:abc",
        accountId: "default",
        waitMs: 0,
      }),
    ).resolves.toBe(true);

    const next = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });
    next.release();
    first.release();
  });
});
