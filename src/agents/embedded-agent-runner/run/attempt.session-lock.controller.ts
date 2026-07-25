import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import type {
  OwnedSessionTranscriptPublishedEntry,
  OwnedSessionTranscriptWriteOptions,
  OwnedSessionTranscriptCacheSnapshot,
} from "../../../config/sessions/transcript-write-context.js";
import { isSessionWriteLockAcquireError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";
import type { PromptReleasedSessionEntry } from "./attempt.session-lock.entries.js";
import {
  EmbeddedAttemptSessionFileFence,
  EmbeddedAttemptSessionTakeoverError,
  type SessionFileWriteAppendValidator,
} from "./attempt.session-lock.fence-controller.js";
import {
  readSessionFileFingerprint,
  readSessionFileFingerprintSync,
  type TrustedSessionFileSnapshot,
} from "./attempt.session-lock.fence.js";
import {
  createActiveWriteLockScope,
  drainWriteLockScope,
  trackWriteLockOperation,
  type ActiveWriteLockState,
} from "./attempt.session-lock.write-scope.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type PromptReleasedSessionMergeResult = {
  sessionFileSnapshot?: OwnedSessionTranscriptCacheSnapshot;
  publishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
  requiresReload?: true;
};

async function waitForSessionEventQueue(_session: unknown): Promise<void> {}

export type EmbeddedAttemptSessionLockController = {
  canAdvanceSessionEntryCache(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishOwnedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishValidatedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  readTrustedCurrentSessionFileSnapshot(): Promise<TrustedSessionFileSnapshot | undefined>;
  releaseForPrompt(): Promise<void>;
  releaseHeldLockForAbort(): Promise<void>;
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
  const acquireLock = async (signal?: AbortSignal): Promise<SessionLock> =>
    await params.acquireSessionWriteLock({
      sessionFile: params.lockOptions.sessionFile,
      timeoutMs: params.lockOptions.timeoutMs,
      staleMs: params.lockOptions.staleMs,
      maxHoldMs: params.lockOptions.maxHoldMs,
      ...(signal ? { signal } : {}),
    });

  let heldLock: SessionLock | undefined = await acquireLock(params.initialAcquireSignal);
  const activeWriteLock = new AsyncLocalStorage<ActiveWriteLockState>();
  let ownedPublicationQueue: Promise<void> = Promise.resolve();
  const fence = new EmbeddedAttemptSessionFileFence({
    sessionFile: params.lockOptions.sessionFile,
    mergePromptReleasedSessionEntries: params.mergePromptReleasedSessionEntries,
    reloadPromptReleasedSessionFile: params.reloadPromptReleasedSessionFile,
  });
  // An aborted prompt can settle after attempt teardown. Never let its finally
  // path reacquire a retained lock that no owner remains to release.
  let disposed = false;
  // Prompt-finally reacquisition can overlap attempt cleanup. Serialize that
  // ownership handoff so cleanup adopts an in-flight reacquire, and skip any
  // later reacquire once cleanup has begun or it could orphan a retained lock.
  let lockLifecycle: Promise<void> = Promise.resolve();
  let cleanupStarted = false;
  // Set when an active retained write prevents immediate held-lock release.
  // The scope completion path retries release after the retained use unwinds.
  let releaseHeldLockDeferred = false;
  let retainedLockUseCount = 0;
  const retainedLockIdleWaiters = new Set<() => void>();
  let heldLockDraining = false;
  let heldLockDrainOwner: symbol | undefined;
  const heldLockDrainWaiters = new Set<() => void>();
  function runLockLifecycle<T>(run: () => Promise<T>): Promise<T> {
    const operation = lockLifecycle.then(run);
    lockLifecycle = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function beginRetainedLockUse(): () => void {
    retainedLockUseCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      retainedLockUseCount -= 1;
      if (retainedLockUseCount === 0 && retainedLockIdleWaiters.size > 0) {
        const waiters = Array.from(retainedLockIdleWaiters);
        retainedLockIdleWaiters.clear();
        for (const resolve of waiters) {
          resolve();
        }
      }
    };
  }

  async function waitForRetainedLockIdle(): Promise<boolean> {
    if (retainedLockUseCount === 0) {
      return true;
    }
    if (activeWriteLock.getStore()?.scope.active === true) {
      return false;
    }
    await new Promise<void>((resolve) => {
      retainedLockIdleWaiters.add(resolve);
    });
    return true;
  }

  async function acquireWriteLock(): Promise<{
    lock: SessionLock;
    owned: boolean;
    releaseRetainedUse?: () => void;
  }> {
    await waitForHeldLockDrain();
    if (heldLock) {
      return { lock: heldLock, owned: false, releaseRetainedUse: beginRetainedLockUse() };
    }
    try {
      return { lock: await acquireLock(), owned: true };
    } catch (err) {
      if (isSessionWriteLockAcquireError(err)) {
        fence.markTakeover();
      }
      throw err;
    }
  }

  async function waitForHeldLockDrain(): Promise<void> {
    for (;;) {
      if (!heldLockDraining) {
        return;
      }
      await new Promise<void>((resolve) => {
        heldLockDrainWaiters.add(resolve);
      });
    }
  }

  async function beginHeldLockDrain(): Promise<symbol> {
    for (;;) {
      if (!heldLockDraining) {
        const owner = Symbol("held-lock-drain");
        heldLockDraining = true;
        heldLockDrainOwner = owner;
        return owner;
      }
      await new Promise<void>((resolve) => {
        heldLockDrainWaiters.add(resolve);
      });
    }
  }

  function finishHeldLockDrain(owner: symbol): void {
    if (!heldLockDraining || heldLockDrainOwner !== owner) {
      return;
    }
    heldLockDraining = false;
    heldLockDrainOwner = undefined;
    if (heldLockDrainWaiters.size === 0) {
      return;
    }
    const waiters = Array.from(heldLockDrainWaiters);
    heldLockDrainWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  const noopLock: SessionLock = { release: async () => {} };

  async function releaseHeldLockWithFence(): Promise<void> {
    if (!heldLock) {
      await waitForHeldLockDrain();
      return;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        releaseHeldLockDeferred = true;
        return;
      }
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      // Clearing `heldLock` transfers release ownership to this block. Fence reads can
      // throw after that transfer; release the underlying file lock anyway so later
      // turns do not wait for the maxHoldMs watchdog.
      try {
        await fence.activateForRelease();
      } finally {
        await lock.release();
      }
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function takeHeldLockAfterRetainedIdle(): Promise<SessionLock | undefined> {
    if (!heldLock) {
      return undefined;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        // Do not wait for retained idle from inside the active scope; that
        // scope must unwind before the retained-use waiter can resolve.
        return undefined;
      }
      if (!heldLock) {
        return undefined;
      }
      const lock = heldLock;
      heldLock = undefined;
      return lock;
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function disposeHeldLockAfterRetainedIdle(): Promise<void> {
    if (!heldLock) {
      await waitForHeldLockDrain();
      return;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        // Same active-scope self-deadlock guard as takeHeldLockAfterRetainedIdle.
        return;
      }
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      await lock.release();
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function releaseHeldLockAfterTakeover(): Promise<void> {
    if (!fence.hasTakeover()) {
      return;
    }
    await disposeHeldLockAfterRetainedIdle();
  }

  async function acquireCleanupLock(): Promise<SessionLock | undefined> {
    const retainedLock = await takeHeldLockAfterRetainedIdle();
    if (retainedLock) {
      return retainedLock;
    }
    await waitForHeldLockDrain();
    try {
      return await acquireLock();
    } catch (err) {
      if (isSessionWriteLockAcquireError(err)) {
        fence.markTakeover();
        return undefined;
      }
      throw err;
    }
  }

  async function runWithPhysicalWriteLockScope<T>(
    run: () => Promise<T>,
    release: () => Promise<void> | void,
  ): Promise<T> {
    const scope = createActiveWriteLockScope();
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await activeWriteLock.run(scope.state, run) };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      try {
        await drainWriteLockScope(scope.state.scope);
      } finally {
        scope.state.active = false;
        scope.state.scope.active = false;
        try {
          await release();
        } finally {
          scope.complete();
        }
      }
    }
    await releaseHeldLockAfterTakeover();
    // Retained use has been released and the active scope is no longer live,
    // so a prior active-scope release bailout can drain the held file lock now.
    if (releaseHeldLockDeferred) {
      releaseHeldLockDeferred = false;
      await releaseHeldLockWithFence();
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    if (fence.hasTakeover()) {
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    return outcome.value;
  }

  async function runWithRetainedLock<T>(
    run: () => Promise<T>,
    releaseRetainedUse: () => void,
  ): Promise<T> {
    return await runWithPhysicalWriteLockScope(run, releaseRetainedUse);
  }

  async function runPublishingOwnedSessionFileWrite<T>(
    run: () => Promise<T> | T,
    resolvePublishedEntries?: (result: T) => readonly OwnedSessionTranscriptPublishedEntry[],
    resolvePublishedEntriesAfterFailure?: () => readonly OwnedSessionTranscriptPublishedEntry[],
  ): Promise<T> {
    const parentLockState = activeWriteLock.getStore();
    if (!parentLockState?.active || !parentLockState.scope.active) {
      throw new Error("owned session publication requires an active session write lock");
    }
    if (parentLockState?.publishingOwnedWrite && parentLockState.acceptingNestedPublications) {
      const nestedPublication = (async () => {
        let nestedEntries: readonly OwnedSessionTranscriptPublishedEntry[] | undefined;
        try {
          const result = await run();
          nestedEntries = resolvePublishedEntries?.(result);
          return result;
        } catch (error) {
          nestedEntries = resolvePublishedEntriesAfterFailure?.();
          throw error;
        } finally {
          if (nestedEntries !== undefined) {
            parentLockState.publishedEntries ??= [];
            parentLockState.publishedEntries.push(...nestedEntries);
          }
        }
      })();
      return await trackWriteLockOperation(
        parentLockState.scope,
        nestedPublication,
        parentLockState.pendingNestedPublications,
      );
    }
    const publication = (async () => {
      let releaseQueue!: () => void;
      const currentQueueEntry = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      const previousQueueEntry = ownedPublicationQueue.catch(() => undefined);
      ownedPublicationQueue = previousQueueEntry.then(() => currentQueueEntry);
      await previousQueueEntry;
      try {
        if (fence.hasTakeover()) {
          throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
        }
        const beforeWrite = await fence.captureOwnedWriteStart();
        const publicationLockState: ActiveWriteLockState = {
          active: true,
          scope: parentLockState.scope,
          publishingOwnedWrite: true,
          acceptingNestedPublications: true,
          pendingNestedPublications: new Set(),
          publishedEntries: undefined,
        };
        try {
          return await activeWriteLock.run(publicationLockState, async () => {
            let ownEntries: readonly OwnedSessionTranscriptPublishedEntry[] | undefined;
            try {
              const result = await run();
              ownEntries = resolvePublishedEntries?.(result);
              return result;
            } catch (error) {
              ownEntries = resolvePublishedEntriesAfterFailure?.();
              throw error;
            } finally {
              // Nested transcript callbacks inherit this publication owner.
              // Drain them before freezing the expected fence entry set.
              while (publicationLockState.pendingNestedPublications.size > 0) {
                await Promise.all(publicationLockState.pendingNestedPublications);
              }
              publicationLockState.acceptingNestedPublications = false;
              publicationLockState.active = false;
              const nestedEntries = publicationLockState.publishedEntries;
              const expectedPublishedEntries =
                nestedEntries === undefined
                  ? ownEntries
                  : ownEntries === undefined
                    ? nestedEntries
                    : [...nestedEntries, ...ownEntries];
              await fence.publishOwnedWrite(beforeWrite, expectedPublishedEntries);
            }
          });
        } finally {
          publicationLockState.active = false;
        }
      } finally {
        releaseQueue();
      }
    })();
    return await trackWriteLockOperation(parentLockState.scope, publication);
  }

  async function runInheritedWriteLockOperation<T>(
    state: ActiveWriteLockState,
    run: () => Promise<T> | T,
  ): Promise<T> {
    const operation = (async () => await run())();
    return await trackWriteLockOperation(state.scope, operation);
  }

  async function withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ): Promise<T> {
    if (fence.hasTakeover()) {
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    const inheritedLockState = activeWriteLock.getStore();
    if (inheritedLockState && (!inheritedLockState.active || !inheritedLockState.scope.active)) {
      await inheritedLockState.scope.completion;
      return await activeWriteLock.exit(() => withSessionWriteLock(run, options));
    }
    if (inheritedLockState?.active === true) {
      if (options?.publishOwnedWrite !== true) {
        return await runInheritedWriteLockOperation(inheritedLockState, run);
      }
      return await runPublishingOwnedSessionFileWrite(
        run,
        options.resolvePublishedEntries,
        options.resolvePublishedEntriesAfterFailure,
      );
    }
    const { lock, owned, releaseRetainedUse } = await acquireWriteLock();
    const runLockedOperation = async () => {
      await fence.assert();
      if (options?.publishOwnedWrite === true) {
        return await runPublishingOwnedSessionFileWrite(
          run,
          options.resolvePublishedEntries,
          options.resolvePublishedEntriesAfterFailure,
        );
      }
      const beforeWrite = await readSessionFileFingerprint(params.lockOptions.sessionFile);
      try {
        return await run();
      } finally {
        await fence.refresh(beforeWrite);
      }
    };
    if (!owned) {
      return await runWithRetainedLock(runLockedOperation, releaseRetainedUse ?? (() => {}));
    }

    return await runWithPhysicalWriteLockScope(runLockedOperation, () => lock.release());
  }

  return {
    canAdvanceSessionEntryCache(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
      const state = activeWriteLock.getStore();
      return (
        state?.active === true && state.scope.active && fence.canAdvanceSessionEntryCache(snapshot)
      );
    },
    publishOwnedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
      const state = activeWriteLock.getStore();
      return state?.active === true && state.scope.active
        ? fence.publishOwnedSessionFileSnapshot(snapshot)
        : false;
    },
    publishValidatedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
      return heldLock && !heldLockDraining
        ? fence.publishValidatedSessionFileSnapshot(snapshot)
        : false;
    },
    async readTrustedCurrentSessionFileSnapshot(): Promise<TrustedSessionFileSnapshot | undefined> {
      return await fence.readTrustedCurrentSessionFileSnapshot();
    },
    async releaseForPrompt(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    async releaseHeldLockForAbort(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    refreshAfterOwnedSessionWrite(): void {
      fence.refreshAfterOwnedSessionWrite();
    },
    withOwnedSessionFileWrite<T>(
      run: () => T,
      validateAppend?: SessionFileWriteAppendValidator<T>,
    ): T {
      const beforeWrite = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      const beforeText = validateAppend
        ? readFileSync(params.lockOptions.sessionFile, "utf8")
        : undefined;
      const result = run();
      fence.publishOwnedWriteSync({
        beforeWrite,
        result,
        ...(beforeText !== undefined ? { beforeText } : {}),
        ...(validateAppend ? { validateAppend } : {}),
      });
      return result;
    },
    async reacquireAfterPrompt(): Promise<void> {
      if (cleanupStarted) {
        return;
      }
      await runLockLifecycle(async () => {
        await waitForHeldLockDrain();
        if (disposed || fence.hasTakeover() || heldLock) {
          return;
        }
        let lock: SessionLock;
        try {
          lock = await acquireLock();
        } catch (err) {
          if (isSessionWriteLockAcquireError(err)) {
            fence.markTakeover();
          }
          throw err;
        }
        if (disposed) {
          await lock.release();
          return;
        }
        try {
          heldLock = lock;
          await fence.assert();
        } catch (err) {
          heldLock = undefined;
          await lock.release();
          throw err;
        }
      });
    },
    waitForSessionEvents: waitForSessionEventQueue,
    withSessionWriteLock,
    async acquireForCleanup(cleanupParams?: { session?: unknown }): Promise<SessionLock> {
      cleanupStarted = true;
      if (cleanupParams?.session) {
        await waitForSessionEventQueue(cleanupParams.session);
      }
      return await runLockLifecycle(async () => {
        if (fence.hasTakeover()) {
          return noopLock;
        }
        const cleanupLock = await acquireCleanupLock();
        if (!cleanupLock) {
          return noopLock;
        }
        try {
          await fence.assert();
        } catch (err) {
          await cleanupLock.release();
          if (err instanceof EmbeddedAttemptSessionTakeoverError) {
            return noopLock;
          }
          throw err;
        }
        return cleanupLock;
      });
    },
    hasSessionTakeover(): boolean {
      return fence.hasTakeover();
    },
    async dispose(): Promise<void> {
      disposed = true;
      try {
        await disposeHeldLockAfterRetainedIdle();
      } finally {
        fence.deactivate();
      }
    },
  };
}
