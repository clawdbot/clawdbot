/** Coordinates embedded-attempt lifecycle around SQLite-owned transcript writes. */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  OwnedSessionTranscriptCacheSnapshot,
  OwnedSessionTranscriptWriteOptions,
  SessionTranscriptWriteLockTarget,
} from "../../../config/sessions/transcript-write-context.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { isSessionWriteLockAcquireError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";
import type {
  PromptReleasedSessionEntry,
  PromptReleasedSessionMergeResult,
} from "../../sessions/session-manager.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;
type SessionKeyLockOptions = Extract<
  Parameters<AcquireSessionWriteLock>[0],
  { targetKind: "session-key" }
>;
type LockOptions = Omit<SessionKeyLockOptions, "targetKind"> & {
  targetKind?: "session-key";
};
const PROMPT_DISPOSE_SETTLE_TIMEOUT_MS = 5_000;

function createPromptSubmissionAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return reason === undefined
    ? new Error("attempt aborted before prompt submission")
    : new Error("attempt aborted before prompt submission", { cause: reason });
}

export type EmbeddedAttemptSessionFileOwner = {
  sessionFileKey: string;
  release(): void;
};

/** Session lanes and SQLite writer queues already serialize this identity. */
export async function acquireEmbeddedAttemptSessionFileOwner(params: {
  sessionFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<EmbeddedAttemptSessionFileOwner> {
  if (params.signal?.aborted) {
    throw params.signal.reason;
  }
  return { sessionFileKey: params.sessionFile, release() {} };
}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionKey: string) {
    super(`session changed while the prompt was running: ${sessionKey}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export type EmbeddedAttemptSessionLockController = {
  canAdvanceSessionEntryCache(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishOwnedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishValidatedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  readTrustedCurrentSessionFileSnapshot(): Promise<undefined>;
  isPromptSubmissionBlockedError(error: unknown): boolean;
  releaseForPrompt(): Promise<void>;
  releaseHeldLockForAbort(options?: { reason?: unknown; terminal?: boolean }): Promise<void>;
  refreshAfterOwnedSessionWrite(): void;
  reacquireAfterPrompt(): Promise<void>;
  withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
  dispose(): Promise<void>;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  acquireSessionWriteLock: AcquireSessionWriteLock;
  initialAcquireSignal?: AbortSignal;
  lockOptions: LockOptions;
  mergePromptReleasedSessionEntries?: (
    entries: readonly PromptReleasedSessionEntry[],
  ) => Promise<PromptReleasedSessionMergeResult | void> | PromptReleasedSessionMergeResult | void;
  reloadPromptReleasedSessionFile?: () => Promise<void> | void;
}): Promise<EmbeddedAttemptSessionLockController> {
  // The runtime caller supplies resolveSessionWriteLockTargetKey(sessionTarget),
  // so aliases for one session incarnation converge before lease acquisition.
  const noOpLock = await params.acquireSessionWriteLock({
    ...params.lockOptions,
    targetKind: "session-key",
    ...(params.initialAcquireSignal ? { signal: params.initialAcquireSignal } : {}),
  });
  let initialLockReleasePromise: Promise<void> | undefined;
  let initialLockReleased = false;
  const releaseInitialLock = (): Promise<void> => {
    if (initialLockReleased) {
      return Promise.resolve();
    }
    initialLockReleasePromise ??= Promise.resolve(noOpLock.release()).then(
      () => {
        initialLockReleased = true;
      },
      (error: unknown) => {
        initialLockReleasePromise = undefined;
        throw error;
      },
    );
    return initialLockReleasePromise;
  };
  let disposed = false;
  let promptAborted = false;
  let promptSubmissionBlockedError: Error | undefined;
  let takeoverDetected = false;
  const assertInitialLockOwned = (): void => {
    try {
      noOpLock.assertOwned?.();
    } catch (error) {
      if (isSessionWriteLockAcquireError(error)) {
        takeoverDetected = true;
      }
      throw error;
    }
  };
  let promptReleaseNeedsReload = false;
  let cleanupStarted = false;
  let promptSettled = Promise.resolve();
  let settlePrompt: (() => void) | undefined;
  let lifecycle = Promise.resolve();
  let reloadFailed = false;
  let reloadFailure: unknown;
  let disposePromise: Promise<void> | undefined;
  let cleanupReleasePromise: Promise<void> | undefined;
  let cleanupLockGranted = false;
  let cleanupOwnershipReleased: Promise<void> | undefined;
  let resolveCleanupOwnershipReleased: (() => void) | undefined;
  let rejectCleanupOwnershipReleased: ((error: unknown) => void) | undefined;
  type ActiveWriteOperation = {
    active: boolean;
    settlement?: Promise<void>;
    started: boolean;
  };
  const activeWriteOperations = new Set<ActiveWriteOperation>();
  const activeWriteOperation = new AsyncLocalStorage<ActiveWriteOperation>();
  type LifecycleOwner = {
    active: boolean;
    nestedPending: number;
    nestedTail: Promise<void>;
    pendingOperations: Set<Promise<void>>;
  };
  const createLifecycleOwner = (): LifecycleOwner => ({
    active: true,
    nestedPending: 0,
    nestedTail: Promise.resolve(),
    pendingOperations: new Set(),
  });
  const lifecycleOwner = new AsyncLocalStorage<LifecycleOwner>();
  const drainLifecycleOwner = async (owner: LifecycleOwner): Promise<void> => {
    let failed = false;
    let firstError: unknown;
    while (owner.pendingOperations.size > 0) {
      const pending = [...owner.pendingOperations];
      owner.pendingOperations.clear();
      const settled = await Promise.allSettled(pending);
      const rejection = settled.find((result) => result.status === "rejected");
      if (!failed && rejection?.status === "rejected") {
        failed = true;
        firstError = rejection.reason;
      }
    }
    if (failed) {
      throw firstError;
    }
  };
  const runLifecycleOwner = async <T>(
    owner: LifecycleOwner,
    run: () => Promise<T> | T,
  ): Promise<T> => {
    let value: T | undefined;
    let primaryError: unknown;
    let primaryFailed = false;
    try {
      value = await lifecycleOwner.run(owner, async () => await run());
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    }
    let drainError: unknown;
    let drainFailed = false;
    try {
      await drainLifecycleOwner(owner);
    } catch (error) {
      drainFailed = true;
      drainError = error;
    } finally {
      owner.active = false;
    }
    if (primaryFailed) {
      if (
        drainFailed &&
        drainError !== primaryError &&
        primaryError instanceof Error &&
        primaryError.cause === undefined
      ) {
        try {
          primaryError.cause = drainError;
        } catch {
          // Frozen callback errors remain primary; drain failure is secondary.
        }
      }
      throw primaryError;
    }
    if (drainFailed) {
      throw drainError;
    }
    return value as T;
  };
  const serializeLifecycle = async <T>(run: () => Promise<T> | T): Promise<T> => {
    const inheritedOwner = lifecycleOwner.getStore();
    if (inheritedOwner?.active) {
      const previousNested = inheritedOwner.nestedTail;
      const waitForPrevious = inheritedOwner.nestedPending > 0 ? previousNested : Promise.resolve();
      inheritedOwner.nestedPending += 1;
      const operation = waitForPrevious.then(async () => {
        const childOwner = createLifecycleOwner();
        return await runLifecycleOwner(childOwner, run);
      });
      void operation.catch(() => {});
      const queueTail = operation.then(
        () => undefined,
        () => undefined,
      );
      const propagated = operation.then(() => undefined);
      void propagated.catch(() => {});
      inheritedOwner.nestedTail = queueTail;
      inheritedOwner.pendingOperations.add(propagated);
      void queueTail.finally(() => {
        inheritedOwner.nestedPending -= 1;
      });
      return await operation;
    }
    const previous = lifecycle;
    let release!: () => void;
    lifecycle = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const owner = createLifecycleOwner();
    try {
      return await runLifecycleOwner(owner, run);
    } finally {
      release();
    }
  };
  const reloadPromptReleasedState = async (): Promise<void> => {
    if (reloadFailed) {
      throw reloadFailure;
    }
    try {
      assertInitialLockOwned();
      await params.reloadPromptReleasedSessionFile?.();
    } catch (error) {
      reloadFailed = true;
      reloadFailure = error;
      if (error instanceof EmbeddedAttemptSessionTakeoverError) {
        takeoverDetected = true;
      }
      throw error;
    }
  };
  const settlePromptRelease = (): void => {
    promptReleaseNeedsReload = false;
    settlePrompt?.();
    settlePrompt = undefined;
  };
  return {
    canAdvanceSessionEntryCache: () => false,
    publishOwnedSessionFileSnapshot: () => false,
    publishValidatedSessionFileSnapshot: () => false,
    readTrustedCurrentSessionFileSnapshot: async () => undefined,
    releaseForPrompt: async () => {
      if (disposed) {
        throw new Error("attempt disposed before prompt submission");
      }
      await serializeLifecycle(() => {
        if (disposed) {
          throw new Error("attempt disposed before prompt submission");
        }
        if (promptSubmissionBlockedError) {
          throw promptSubmissionBlockedError;
        }
        if (cleanupStarted) {
          throw new Error("attempt cleanup started before prompt submission");
        }
        assertInitialLockOwned();
        // The SQLite lease spans the provider prompt. Its stale deadline never
        // permits takeover from a live process owner.
        promptAborted = false;
        promptReleaseNeedsReload = true;
        promptSettled = new Promise<void>((resolve) => {
          settlePrompt = resolve;
        });
      });
    },
    isPromptSubmissionBlockedError: (error) =>
      promptSubmissionBlockedError !== undefined && error === promptSubmissionBlockedError,
    releaseHeldLockForAbort: async (options) => {
      promptAborted = true;
      if (options?.terminal !== false && !promptSubmissionBlockedError) {
        promptSubmissionBlockedError = createPromptSubmissionAbortError(options?.reason);
      }
    },
    refreshAfterOwnedSessionWrite: () => {},
    reacquireAfterPrompt: async () => {
      if (disposed) {
        settlePromptRelease();
        return;
      }
      await serializeLifecycle(async () => {
        try {
          if (disposed || cleanupStarted || (promptAborted && !promptReleaseNeedsReload)) {
            return;
          }
          await reloadPromptReleasedState();
        } finally {
          settlePromptRelease();
        }
      });
    },
    withSessionWriteLock: (run) => {
      const rejectWrite = (error: Error): Promise<never> => {
        const rejected = Promise.reject(error);
        void rejected.catch(() => {});
        return rejected;
      };
      const parentWriteOperation = activeWriteOperation.getStore();
      const activeDescendant = Boolean(
        parentWriteOperation?.active && activeWriteOperations.has(parentWriteOperation),
      );
      if (disposed && !activeDescendant) {
        return rejectWrite(new Error("attempt disposed before transcript write"));
      }
      if (cleanupStarted) {
        return rejectWrite(new Error("attempt cleanup started before transcript write"));
      }
      const writeOperation: ActiveWriteOperation = { active: true, started: false };
      const operation = serializeLifecycle(async () => {
        if (disposed && !activeDescendant) {
          throw new Error("attempt disposed before transcript write");
        }
        if (cleanupStarted) {
          throw new Error("attempt cleanup started before transcript write");
        }
        if (reloadFailed) {
          throw reloadFailure;
        }
        assertInitialLockOwned();
        writeOperation.started = true;
        return await activeWriteOperation.run(writeOperation, async () => await run());
      });
      const settlement = operation.then(
        () => undefined,
        () => undefined,
      );
      void operation.catch(() => {});
      writeOperation.settlement = settlement;
      activeWriteOperations.add(writeOperation);
      void settlement.then(() => {
        writeOperation.active = false;
        activeWriteOperations.delete(writeOperation);
      });
      return operation;
    },
    acquireForCleanup: async () => {
      const currentWriteOperation = activeWriteOperation.getStore();
      if (currentWriteOperation?.active && activeWriteOperations.has(currentWriteOperation)) {
        throw new Error("cannot start attempt cleanup inside a transcript write callback");
      }
      if (disposed) {
        throw new Error("attempt disposed before cleanup");
      }
      await serializeLifecycle(async () => {
        if (disposed) {
          throw new Error("attempt disposed before cleanup");
        }
        if (cleanupStarted) {
          throw new Error("attempt cleanup already started");
        }
        cleanupStarted = true;
        if (promptReleaseNeedsReload) {
          try {
            if (!disposed) {
              await reloadPromptReleasedState();
            }
          } finally {
            settlePromptRelease();
          }
        }
      });
      await serializeLifecycle(() => {});
      if (disposed) {
        throw new Error("attempt disposed before cleanup");
      }
      assertInitialLockOwned();
      cleanupLockGranted = true;
      cleanupOwnershipReleased = new Promise<void>((resolve, reject) => {
        resolveCleanupOwnershipReleased = resolve;
        rejectCleanupOwnershipReleased = reject;
      });
      void cleanupOwnershipReleased.catch(() => {});
      return {
        release: () => {
          cleanupReleasePromise ??= (async () => {
            try {
              while (activeWriteOperations.size > 0) {
                await Promise.all(
                  [...activeWriteOperations].flatMap((operation) =>
                    operation.settlement ? [operation.settlement] : [],
                  ),
                );
              }
              await releaseInitialLock();
              resolveCleanupOwnershipReleased?.();
            } catch (error) {
              rejectCleanupOwnershipReleased?.(error);
              throw error;
            }
          })();
          return cleanupReleasePromise;
        },
      } as SessionLock;
    },
    hasSessionTakeover: () => takeoverDetected,
    dispose: async () => {
      const currentWriteOperation = activeWriteOperation.getStore();
      if (currentWriteOperation?.active && activeWriteOperations.has(currentWriteOperation)) {
        throw new Error("cannot dispose an attempt from inside a transcript write callback");
      }
      disposePromise ??= (async () => {
        disposed = true;
        promptAborted = true;
        if (cleanupLockGranted) {
          // Cleanup acquisition already drained the lifecycle queue. Its lock
          // release resolves this handoff after any tracked write settlements.
          try {
            await cleanupOwnershipReleased;
          } catch {
            await releaseInitialLock();
          }
          return;
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await Promise.all([promptSettled, serializeLifecycle(() => {})]);
              while (true) {
                const pendingWrites = [...activeWriteOperations].flatMap((operation) =>
                  operation.settlement ? [operation.settlement] : [],
                );
                if (pendingWrites.length === 0) {
                  break;
                }
                await Promise.all(pendingWrites);
              }
            })(),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, PROMPT_DISPOSE_SETTLE_TIMEOUT_MS);
            }),
          ]);
          while (true) {
            const startedWrites = [...activeWriteOperations]
              .filter((operation) => operation.started)
              .flatMap((operation) => (operation.settlement ? [operation.settlement] : []));
            if (startedWrites.length === 0) {
              break;
            }
            await Promise.all(startedWrites);
          }
        } finally {
          if (timeout) {
            clearTimeout(timeout);
          }
          await releaseInitialLock();
        }
      })().catch((error: unknown) => {
        disposePromise = undefined;
        throw error;
      });
      await disposePromise;
    },
  };
}

type PromptReleaseStreamFn = ((...args: unknown[]) => Promise<unknown>) & {
  openclawSessionLockPromptReleaseInstalled?: true;
};

type SessionWithAgentPrompt = {
  agent?: { streamFn?: PromptReleaseStreamFn };
};

async function settlePromptSubmission(params: {
  reacquireAfterPrompt: () => Promise<void>;
}): Promise<void> {
  await params.reacquireAfterPrompt();
}

function attachPromptSettlementError(promptError: unknown, settlementError: unknown): void {
  if (
    promptError instanceof Error &&
    promptError.cause === undefined &&
    settlementError !== promptError
  ) {
    try {
      promptError.cause = settlementError;
    } catch {
      // A frozen provider error remains the primary failure; settlement diagnostics are secondary.
    }
  }
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  releaseForPrompt: () => Promise<void>;
  reacquireAfterPrompt: () => Promise<void>;
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptWriteLockTarget;
  withSessionWriteLock?: <T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ) => Promise<T>;
  canAdvanceSessionEntryCache?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
  publishSessionFileSnapshot?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn.openclawSessionLockPromptReleaseInstalled === true) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    // The internal agent runtime routes transcript mutations through the
    // lifecycle lock; it has no separate SDK event queue to drain.
    await params.releaseForPrompt();
    let promptFailed = false;
    let promptError: unknown;
    let promptResult: unknown;
    try {
      if (params.sessionFile && params.withSessionWriteLock) {
        promptResult = await withOwnedSessionTranscriptWrites(
          {
            sessionFile: params.sessionFile,
            sessionKey: params.sessionKey,
            sessionTarget: params.sessionTarget,
            withSessionWriteLock: params.withSessionWriteLock,
            canAdvanceSessionEntryCache: params.canAdvanceSessionEntryCache,
            publishSessionFileSnapshot: params.publishSessionFileSnapshot,
          },
          async () => await originalStreamFn(...args),
        );
      } else {
        promptResult = await originalStreamFn(...args);
      }
    } catch (error) {
      promptFailed = true;
      promptError = error;
    }
    let settlementFailed = false;
    let settlementError: unknown;
    try {
      await settlePromptSubmission(params);
    } catch (error) {
      settlementFailed = true;
      settlementError = error;
    }
    if (promptFailed) {
      if (settlementFailed) {
        attachPromptSettlementError(promptError, settlementError);
      }
      throw promptError;
    }
    if (settlementFailed) {
      throw settlementError;
    }
    return promptResult;
  };
  wrappedStreamFn.openclawSessionLockPromptReleaseInstalled = true;
  agent.streamFn = wrappedStreamFn;
}
