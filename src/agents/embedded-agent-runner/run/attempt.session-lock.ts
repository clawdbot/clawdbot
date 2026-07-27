/** Coordinates embedded-attempt lifecycle around SQLite-owned transcript writes. */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  OwnedSessionTranscriptCacheSnapshot,
  OwnedSessionTranscriptWriteOptions,
  SessionTranscriptWriteLockTarget,
} from "../../../config/sessions/transcript-write-context.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";
import type {
  PromptReleasedSessionEntry,
  PromptReleasedSessionMergeResult,
} from "../../sessions/session-manager.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;
type LockOptions = Parameters<AcquireSessionWriteLock>[0];
type SessionFileWriteAppendValidator<T> = (result: T) => boolean;
const PROMPT_DISPOSE_SETTLE_TIMEOUT_MS = 5_000;

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
  releaseForPrompt(): Promise<void>;
  releaseHeldLockForAbort(options?: { terminal?: boolean }): Promise<void>;
  refreshAfterOwnedSessionWrite(): void;
  withOwnedSessionFileWrite<T>(
    run: () => T,
    validateAppend?: SessionFileWriteAppendValidator<T>,
  ): T;
  reacquireAfterPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
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
  const noOpLock = await params.acquireSessionWriteLock({
    ...params.lockOptions,
    targetKind: "session-key",
    ...(params.initialAcquireSignal ? { signal: params.initialAcquireSignal } : {}),
  });
  let initialLockReleasePromise: Promise<void> | undefined;
  const releaseInitialLock = (): Promise<void> => {
    initialLockReleasePromise ??= Promise.resolve(noOpLock.release());
    return initialLockReleasePromise;
  };
  let disposed = false;
  let promptAborted = false;
  let promptSubmissionBlocked = false;
  let takeoverDetected = false;
  let promptReleased = false;
  let cleanupStarted = false;
  let promptSettled = Promise.resolve();
  let settlePrompt: (() => void) | undefined;
  let lifecycle = Promise.resolve();
  let reloadFailed = false;
  let reloadFailure: unknown;
  let disposePromise: Promise<void> | undefined;
  let cleanupReleasePromise: Promise<void> | undefined;
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
  const serializeLifecycle = async <T>(run: () => Promise<T> | T): Promise<T> => {
    const inheritedOwner = lifecycleOwner.getStore();
    if (inheritedOwner?.active) {
      const previousNested = inheritedOwner.nestedTail;
      const waitForPrevious = inheritedOwner.nestedPending > 0 ? previousNested : Promise.resolve();
      inheritedOwner.nestedPending += 1;
      const operation = waitForPrevious.then(async () => {
        const childOwner = createLifecycleOwner();
        try {
          return await lifecycleOwner.run(childOwner, async () => await run());
        } finally {
          while (childOwner.pendingOperations.size > 0) {
            await Promise.all(childOwner.pendingOperations);
          }
          childOwner.active = false;
        }
      });
      const settlement = operation.then(
        () => undefined,
        () => undefined,
      );
      inheritedOwner.nestedTail = settlement;
      inheritedOwner.pendingOperations.add(settlement);
      void settlement.finally(() => {
        inheritedOwner.nestedPending -= 1;
        inheritedOwner.pendingOperations.delete(settlement);
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
      return await lifecycleOwner.run(owner, async () => await run());
    } finally {
      while (owner.pendingOperations.size > 0) {
        await Promise.all(owner.pendingOperations);
      }
      owner.active = false;
      release();
    }
  };
  const reloadPromptReleasedState = async (): Promise<void> => {
    if (reloadFailed) {
      throw reloadFailure;
    }
    try {
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
    promptReleased = false;
    settlePrompt?.();
    settlePrompt = undefined;
  };
  return {
    canAdvanceSessionEntryCache: () => false,
    publishOwnedSessionFileSnapshot: () => false,
    publishValidatedSessionFileSnapshot: () => false,
    readTrustedCurrentSessionFileSnapshot: async () => undefined,
    releaseForPrompt: async () =>
      await serializeLifecycle(() => {
        if (disposed) {
          throw new Error("attempt disposed before prompt submission");
        }
        if (promptSubmissionBlocked) {
          throw new Error("attempt aborted before prompt submission");
        }
        if (cleanupStarted) {
          throw new Error("attempt cleanup started before prompt submission");
        }
        promptAborted = false;
        promptReleased = true;
        promptSettled = new Promise<void>((resolve) => {
          settlePrompt = resolve;
        });
      }),
    releaseHeldLockForAbort: async (options) => {
      promptAborted = true;
      promptSubmissionBlocked ||= options?.terminal !== false;
      promptReleased = false;
    },
    refreshAfterOwnedSessionWrite: () => {},
    withOwnedSessionFileWrite: (run) => {
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return run();
    },
    reacquireAfterPrompt: async () =>
      await serializeLifecycle(async () => {
        try {
          if (disposed || promptAborted || cleanupStarted) {
            return;
          }
          await reloadPromptReleasedState();
        } finally {
          settlePromptRelease();
        }
      }),
    waitForSessionEvents: async () => {},
    withSessionWriteLock: async (run) => {
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      if (cleanupStarted) {
        throw new Error("attempt cleanup started before transcript write");
      }
      const writeOperation: ActiveWriteOperation = { active: true, started: false };
      const operation = serializeLifecycle(async () => {
        if (disposed) {
          throw new Error("attempt disposed before transcript write");
        }
        if (cleanupStarted) {
          throw new Error("attempt cleanup started before transcript write");
        }
        if (reloadFailed) {
          throw reloadFailure;
        }
        writeOperation.started = true;
        return await activeWriteOperation.run(writeOperation, async () => await run());
      });
      const settlement = operation.then(
        () => undefined,
        () => undefined,
      );
      writeOperation.settlement = settlement;
      activeWriteOperations.add(writeOperation);
      void settlement.then(() => {
        writeOperation.active = false;
        activeWriteOperations.delete(writeOperation);
      });
      return await operation;
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
        cleanupStarted = true;
        if (promptReleased) {
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
      return {
        release: () => {
          cleanupReleasePromise ??= (async () => {
            await serializeLifecycle(() => {});
            while (activeWriteOperations.size > 0) {
              await Promise.all(
                [...activeWriteOperations].flatMap((operation) =>
                  operation.settlement ? [operation.settlement] : [],
                ),
              );
            }
            await releaseInitialLock();
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
        promptReleased = false;
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
      })();
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
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  reacquireAfterPrompt: () => Promise<void>;
}): Promise<void> {
  let drainFailed = false;
  let drainError: unknown;
  try {
    await params.waitForSessionEvents(params.session);
  } catch (error) {
    drainFailed = true;
    drainError = error;
  }
  try {
    await params.reacquireAfterPrompt();
  } catch (error) {
    if (drainFailed) {
      attachPromptSettlementError(error, drainError);
    }
    throw error;
  }
  if (drainFailed) {
    throw drainError;
  }
}

function attachPromptSettlementError(promptError: unknown, settlementError: unknown): void {
  if (promptError instanceof Error && promptError.cause === undefined) {
    try {
      promptError.cause = settlementError;
    } catch {
      // A frozen provider error remains the primary failure; settlement diagnostics are secondary.
    }
  }
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
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
    await params.waitForSessionEvents(params.session);
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
