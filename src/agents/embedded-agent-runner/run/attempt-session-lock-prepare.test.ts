import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireSessionFileOwner: vi.fn(),
  acquireSessionWriteLock: vi.fn(),
  createSessionLockController: vi.fn(),
  resolveCompactionTimeoutMs: vi.fn(() => 30_000),
  resolveSessionWriteLockOptions: vi.fn(() => ({
    timeoutMs: 100,
    staleMs: 200,
    maxHoldMs: 300,
  })),
}));

vi.mock("../../session-write-lock.js", () => ({
  acquireSessionWriteLock: mocks.acquireSessionWriteLock,
}));
vi.mock("../compaction-safety-timeout.js", () => ({
  resolveCompactionTimeoutMs: mocks.resolveCompactionTimeoutMs,
}));
vi.mock("./attempt.run-decisions.js", () => ({
  resolveEmbeddedAttemptSessionWriteLockOptions: mocks.resolveSessionWriteLockOptions,
}));
vi.mock("./attempt.session-lock.js", () => ({
  acquireEmbeddedAttemptSessionFileOwner: mocks.acquireSessionFileOwner,
  createEmbeddedAttemptSessionLockController: mocks.createSessionLockController,
}));

import { prepareEmbeddedAttemptSessionLock } from "./attempt-session-lock-prepare.js";

type PrepareInput = Parameters<typeof prepareEmbeddedAttemptSessionLock>[0];
type CreateControllerInput = {
  acquireSessionWriteLock: unknown;
  initialAcquireSignal?: AbortSignal;
  lockOptions: {
    sessionFile: string;
    timeoutMs: number;
    staleMs: number;
    maxHoldMs: number;
  };
  mergePromptReleasedSessionEntries: (entries: never[]) => unknown;
  reloadPromptReleasedSessionFile: () => void;
};

function createFixture(options?: { rejectPostArmFence?: Error }) {
  const order: string[] = [];
  const sessionFileOwner = { release: vi.fn() };
  const sessionManager = {
    mergePromptReleasedSessionEntries: vi.fn(() => "merged"),
    setSessionFile: vi.fn(),
  };
  const sessionLockController = {
    canAdvanceSessionEntryCache: vi.fn(() => true),
    dispose: vi.fn(async () => undefined),
    publishOwnedSessionFileSnapshot: vi.fn(() => true),
    withSessionWriteLock: vi.fn(async <T>(operation: () => Promise<T> | T) => await operation()),
  };
  mocks.acquireSessionFileOwner.mockImplementation(async () => {
    order.push("file-owner");
    return sessionFileOwner;
  });
  mocks.createSessionLockController.mockImplementation(async () => {
    order.push("session-lock");
    return sessionLockController;
  });

  let fenceCount = 0;
  const externalAbortController = {
    arm: vi.fn(() => {
      order.push("arm");
    }),
    throwIfFiredAfterPrepCleanup: vi.fn(async () => {
      fenceCount += 1;
      order.push(`abort-fence-${fenceCount}`);
      if (fenceCount === 2 && options?.rejectPostArmFence) {
        throw options.rejectPostArmFence;
      }
    }),
  };
  let releaseSessionLock: (() => Promise<void>) | undefined;
  const input = {
    attempt: {
      abortSignal: new AbortController().signal,
      config: {},
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:session-1",
    },
    externalAbortController,
    getSessionManager: () => sessionManager,
    onSessionFileOwnerAcquired: vi.fn(() => {
      order.push("publish-file-owner");
    }),
    onSessionLockReleaseReady: vi.fn((release) => {
      order.push("publish-session-lock");
      releaseSessionLock = release;
    }),
  } as unknown as PrepareInput;

  return {
    externalAbortController,
    input,
    order,
    releaseSessionLock: () => releaseSessionLock,
    sessionFileOwner,
    sessionLockController,
    sessionManager,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareEmbeddedAttemptSessionLock", () => {
  it("publishes ownership before arming and exposes owned transcript writes", async () => {
    const fixture = createFixture();

    const result = await prepareEmbeddedAttemptSessionLock(fixture.input);

    expect(fixture.order).toEqual([
      "abort-fence-1",
      "file-owner",
      "publish-file-owner",
      "session-lock",
      "publish-session-lock",
      "arm",
      "abort-fence-2",
    ]);
    expect(result.compactionTimeoutMs).toBe(30_000);
    expect(mocks.acquireSessionFileOwner).toHaveBeenCalledWith({
      sessionFile: "/tmp/session.jsonl",
      timeoutMs: 300,
      signal: fixture.input.attempt.abortSignal,
    });

    const controllerInput = mocks.createSessionLockController.mock.calls[0]?.[0] as
      | CreateControllerInput
      | undefined;
    expect(controllerInput).toEqual(
      expect.objectContaining({
        acquireSessionWriteLock: mocks.acquireSessionWriteLock,
        initialAcquireSignal: fixture.input.attempt.abortSignal,
        lockOptions: {
          sessionFile: "/tmp/session.jsonl",
          timeoutMs: 100,
          staleMs: 200,
          maxHoldMs: 300,
        },
      }),
    );
    expect(controllerInput?.mergePromptReleasedSessionEntries([])).toBe("merged");
    expect(fixture.sessionManager.mergePromptReleasedSessionEntries).toHaveBeenCalledWith([], {
      persistLeaf: true,
    });
    controllerInput?.reloadPromptReleasedSessionFile();
    expect(fixture.sessionManager.setSessionFile).toHaveBeenCalledWith("/tmp/session.jsonl");

    await expect(result.withOwnedSessionWriteLock(async () => "done")).resolves.toBe("done");
    expect(fixture.sessionLockController.withSessionWriteLock).toHaveBeenCalledOnce();
    await fixture.releaseSessionLock()?.();
    expect(fixture.sessionLockController.dispose).toHaveBeenCalledOnce();
  });

  it("publishes both cleanup handles before a post-arm abort fence fails", async () => {
    const abortError = new Error("aborted during lock acquisition");
    const fixture = createFixture({ rejectPostArmFence: abortError });

    await expect(prepareEmbeddedAttemptSessionLock(fixture.input)).rejects.toBe(abortError);

    expect(fixture.input.onSessionFileOwnerAcquired).toHaveBeenCalledWith(fixture.sessionFileOwner);
    expect(fixture.input.onSessionLockReleaseReady).toHaveBeenCalledOnce();
    expect(fixture.externalAbortController.arm).toHaveBeenCalledOnce();
  });
});
