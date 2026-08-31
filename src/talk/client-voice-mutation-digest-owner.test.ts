import { describe, expect, it, vi } from "vitest";
import { ClientVoiceMutationDigestOwner } from "./client-voice-mutation-digest-owner.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("client voice mutation digest owner", () => {
  it("bounds retained identities, dedupes keys, and limits concurrency", async () => {
    const attempts: Array<{ id: string; completion: ReturnType<typeof deferred<boolean>> }> = [];
    let active = 0;
    let maxActive = 0;
    const warn = vi.fn();
    const owner = new ClientVoiceMutationDigestOwner<number>({
      policy: {
        maxRetainedIntents: 4,
        maxRetainedIdentityBytes: 64,
        maxConcurrentAttempts: 2,
        maxAttemptFailures: 3,
        attemptAbortAfterMs: 60_000,
        failureRetentionMs: 60_000,
      },
      warn,
      attempt: async ({ voiceSessionId }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const completion = deferred<boolean>();
        attempts.push({ id: voiceSessionId, completion });
        try {
          return await completion.promise;
        } finally {
          active -= 1;
        }
      },
    });

    for (let index = 1; index <= 6; index += 1) {
      owner.record({ agentId: "a", voiceSessionId: `v${index}`, context: index });
    }
    owner.record({ agentId: "a", voiceSessionId: "v1", context: 99 });
    expect(owner.snapshot()).toEqual({
      active: 2,
      pending: 2,
      retained: 4,
      retainedIdentityBytes: 16,
    });

    let resolved = 0;
    while (resolved < 4) {
      await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(resolved));
      const batch = attempts.slice(resolved);
      resolved += batch.length;
      for (const attempt of batch) {
        attempt.completion.resolve(true);
      }
    }
    await vi.waitFor(() =>
      expect(owner.snapshot()).toEqual({
        active: 0,
        pending: 0,
        retained: 0,
        retainedIdentityBytes: 0,
      }),
    );
    expect(attempts.map((attempt) => attempt.id)).toEqual(["v1", "v2", "v3", "v4"]);
    expect(attempts.map((attempt) => attempt.id)).not.toContain("v5");
    expect(attempts.map((attempt) => attempt.id)).not.toContain("v6");
    expect(maxActive).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, "voice mutation digest retry owner is full");
    expect(warn).toHaveBeenNthCalledWith(2, "voice mutation digest retry owner is full");
  });

  it("retries once when a duplicate intent arrives during a failed active attempt", async () => {
    const attempts: Array<ReturnType<typeof deferred<boolean>>> = [];
    const owner = new ClientVoiceMutationDigestOwner<number>({
      policy: {
        maxRetainedIntents: 2,
        maxRetainedIdentityBytes: 64,
        maxConcurrentAttempts: 1,
        maxAttemptFailures: 3,
        attemptAbortAfterMs: 60_000,
        failureRetentionMs: 60_000,
      },
      warn: vi.fn(),
      attempt: async () => {
        const completion = deferred<boolean>();
        attempts.push(completion);
        return await completion.promise;
      },
    });

    owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
    owner.record({ agentId: "a", voiceSessionId: "v1", context: 2 });
    attempts[0]?.reject(new Error("offline"));
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    attempts[1]?.resolve(true);
    await vi.waitFor(() => expect(owner.snapshot().retained).toBe(0));
  });

  it("keeps an ignored abort request active until its real promise settles", async () => {
    const attempts: Array<{
      completion: ReturnType<typeof deferred<boolean>>;
      signal: AbortSignal;
    }> = [];
    const owner = new ClientVoiceMutationDigestOwner<number>({
      policy: {
        maxRetainedIntents: 2,
        maxRetainedIdentityBytes: 64,
        maxConcurrentAttempts: 1,
        maxAttemptFailures: 3,
        attemptAbortAfterMs: 10,
        failureRetentionMs: 60_000,
      },
      warn: vi.fn(),
      attempt: async ({ signal }) => {
        const completion = deferred<boolean>();
        attempts.push({ completion, signal });
        return await completion.promise;
      },
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
      owner.record({ agentId: "a", voiceSessionId: "v2", context: 2 });
      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.signal.aborted).toBe(true);
      expect(owner.snapshot()).toMatchObject({ active: 1, pending: 1, retained: 2 });

      attempts[0]?.completion.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(2);
      attempts[1]?.completion.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.snapshot().retained).toBe(0);
    } finally {
      for (const attempt of attempts) {
        attempt.completion.resolve(true);
      }
      owner.clear();
      vi.useRealTimers();
    }
  });

  it("rejects an oversized identity atomically", async () => {
    const warn = vi.fn();
    const attempt = vi.fn(async () => true);
    const owner = new ClientVoiceMutationDigestOwner<number>({
      policy: {
        maxRetainedIntents: 2,
        maxRetainedIdentityBytes: 8,
        maxConcurrentAttempts: 1,
        maxAttemptFailures: 3,
        attemptAbortAfterMs: 60_000,
        failureRetentionMs: 60_000,
      },
      warn,
      attempt,
    });

    owner.record({ agentId: "agent", voiceSessionId: "voice", context: 1 });
    await flushMicrotasks();

    expect(owner.snapshot()).toEqual({
      active: 0,
      pending: 0,
      retained: 0,
      retainedIdentityBytes: 0,
    });
    expect(attempt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "voice mutation digest identity exceeds the retry owner byte limit",
    );
  });

  it("preserves older intents when aggregate identity bytes are full", async () => {
    const attempts: Array<{ id: string; completion: ReturnType<typeof deferred<boolean>> }> = [];
    const warn = vi.fn();
    const owner = new ClientVoiceMutationDigestOwner<number>({
      policy: {
        maxRetainedIntents: 4,
        maxRetainedIdentityBytes: 10,
        maxConcurrentAttempts: 1,
        maxAttemptFailures: 3,
        attemptAbortAfterMs: 60_000,
        failureRetentionMs: 60_000,
      },
      warn,
      attempt: async ({ voiceSessionId }) => {
        const completion = deferred<boolean>();
        attempts.push({ id: voiceSessionId, completion });
        return await completion.promise;
      },
    });

    owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
    owner.record({ agentId: "a", voiceSessionId: "v2", context: 2 });
    owner.record({ agentId: "a", voiceSessionId: "v3", context: 3 });

    expect(owner.snapshot()).toEqual({
      active: 1,
      pending: 1,
      retained: 2,
      retainedIdentityBytes: 8,
    });
    expect(warn).toHaveBeenCalledOnce();

    attempts[0]?.completion.resolve(true);
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    attempts[1]?.completion.resolve(true);
    await vi.waitFor(() => expect(owner.snapshot().retained).toBe(0));
    expect(attempts.map((attempt) => attempt.id)).toEqual(["v1", "v2"]);
  });

  it("drops a permanently failing intent after bounded lifecycle retries", async () => {
    const warn = vi.fn();
    const attempts: string[] = [];
    const owner = new ClientVoiceMutationDigestOwner<number>({
      policy: {
        maxRetainedIntents: 1,
        maxRetainedIdentityBytes: 64,
        maxConcurrentAttempts: 1,
        maxAttemptFailures: 2,
        attemptAbortAfterMs: 60_000,
        failureRetentionMs: 60_000,
      },
      warn,
      attempt: async ({ agentId }) => {
        attempts.push(agentId);
        if (agentId === "first") {
          throw new Error("permanent");
        }
        return true;
      },
    });

    owner.record({ agentId: "first", voiceSessionId: "v1", context: 1 });
    await vi.waitFor(() =>
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 }),
    );
    owner.retry({ agentId: "first", voiceSessionId: "v1" });
    await vi.waitFor(() => expect(owner.snapshot().retained).toBe(0));

    owner.record({ agentId: "second", voiceSessionId: "v2", context: 2 });
    await vi.waitFor(() => expect(owner.snapshot().retained).toBe(0));
    expect(attempts).toEqual(["first", "first", "second"]);
    expect(warn).toHaveBeenLastCalledWith(
      "voice mutation digest dropped after 2 failed attempts: permanent",
    );
  });

  it("expires a failed intent without self-retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const warn = vi.fn();
      const attempt = vi.fn(async () => {
        throw new Error("offline");
      });
      const owner = new ClientVoiceMutationDigestOwner<number>({
        policy: {
          maxRetainedIntents: 1,
          maxRetainedIdentityBytes: 64,
          maxConcurrentAttempts: 1,
          maxAttemptFailures: 3,
          attemptAbortAfterMs: 60_000,
          failureRetentionMs: 100,
        },
        warn,
        attempt,
      });

      owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempt).toHaveBeenCalledOnce();
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });

      await vi.advanceTimersByTimeAsync(99);
      expect(owner.snapshot().retained).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(owner.snapshot().retained).toBe(0);
      expect(attempt).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenLastCalledWith(
        "voice mutation digest dropped after retry retention expired (1 failed attempts)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("suspends failure expiry while a legitimate defer owns the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let outcome: "fail" | "defer" | "succeed" = "fail";
      const attempt = vi.fn(async () => {
        if (outcome === "fail") {
          throw new Error("offline");
        }
        return outcome === "succeed";
      });
      const owner = new ClientVoiceMutationDigestOwner<number>({
        policy: {
          maxRetainedIntents: 1,
          maxRetainedIdentityBytes: 64,
          maxConcurrentAttempts: 1,
          maxAttemptFailures: 3,
          attemptAbortAfterMs: 60_000,
          failureRetentionMs: 100,
        },
        warn: vi.fn(),
        attempt,
      });

      owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });

      outcome = "defer";
      owner.retry({ agentId: "a", voiceSessionId: "v1" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(101);
      expect(owner.snapshot()).toMatchObject({ active: 0, pending: 0, retained: 1 });

      outcome = "succeed";
      owner.retry({ agentId: "a", voiceSessionId: "v1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.snapshot().retained).toBe(0);
      expect(attempt).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores settlement from an attempt owned by a cleared generation", async () => {
    const attempts: Array<{
      context: number;
      completion: ReturnType<typeof deferred<boolean>>;
    }> = [];
    const owner = new ClientVoiceMutationDigestOwner<number>({
      policy: {
        maxRetainedIntents: 1,
        maxRetainedIdentityBytes: 64,
        maxConcurrentAttempts: 1,
        maxAttemptFailures: 3,
        attemptAbortAfterMs: 60_000,
        failureRetentionMs: 60_000,
      },
      warn: vi.fn(),
      attempt: async ({ context }) => {
        const completion = deferred<boolean>();
        attempts.push({ context, completion });
        return await completion.promise;
      },
    });

    owner.record({ agentId: "a", voiceSessionId: "v1", context: 1 });
    owner.clear();
    owner.record({ agentId: "a", voiceSessionId: "v1", context: 2 });
    owner.record({ agentId: "a", voiceSessionId: "v1", context: 3 });

    attempts[0]?.completion.reject(new Error("old generation"));
    attempts[1]?.completion.resolve(false);
    await vi.waitFor(() => expect(attempts).toHaveLength(3));
    expect(attempts[2]?.context).toBe(3);
    attempts[2]?.completion.resolve(true);
    await vi.waitFor(() => expect(owner.snapshot().retained).toBe(0));
  });
});
