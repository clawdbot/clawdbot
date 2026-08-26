/** Serializes run-owned transcript callbacks and bounds teardown settlement. */
import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "../../../infra/errors.js";
import { log } from "../logger.js";

const TRANSCRIPT_TEARDOWN_BUDGET_MS = 30_000;

type LifecycleOwner = {
  active: boolean;
  nestedPending: number;
  nestedTail: Promise<void>;
  pendingOperations: Set<Promise<void>>;
};

export type EmbeddedAttemptTranscriptLifecycle = {
  withTranscriptWrite<T>(run: () => Promise<T> | T): Promise<T>;
  beginCleanup(): Promise<void>;
  dispose(): Promise<void>;
};

export function createEmbeddedAttemptTranscriptLifecycle(params: {
  runId?: string;
  sessionId?: string;
}): EmbeddedAttemptTranscriptLifecycle {
  let cleanupRequested = false;
  let disposed = false;
  let lifecycle = Promise.resolve();
  let cleanupDrain: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  let pendingWrites = 0;
  let teardownBudgetLogged = false;
  const lifecycleOwner = new AsyncLocalStorage<LifecycleOwner>();

  const createLifecycleOwner = (): LifecycleOwner => ({
    active: true,
    nestedPending: 0,
    nestedTail: Promise.resolve(),
    pendingOperations: new Set(),
  });
  const drainLifecycleOwner = async (owner: LifecycleOwner): Promise<void> => {
    let firstError: Error | undefined;
    while (owner.pendingOperations.size > 0) {
      const pending = [...owner.pendingOperations];
      owner.pendingOperations.clear();
      const settled = await Promise.allSettled(pending);
      const rejected = settled.find((result) => result.status === "rejected");
      if (firstError === undefined && rejected?.status === "rejected") {
        firstError = toErrorObject(rejected.reason, "nested transcript write failed");
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  };
  const runLifecycleOwner = async <T>(
    owner: LifecycleOwner,
    run: () => Promise<T> | T,
  ): Promise<T> => {
    let value: T | undefined;
    let primaryError: Error | undefined;
    try {
      value = await lifecycleOwner.run(owner, async () => await run());
    } catch (error) {
      primaryError = toErrorObject(error, "transcript write failed");
    }
    let drainError: Error | undefined;
    try {
      await drainLifecycleOwner(owner);
    } catch (error) {
      drainError = toErrorObject(error, "nested transcript drain failed");
    } finally {
      owner.active = false;
    }
    if (primaryError !== undefined) {
      if (
        drainError !== undefined &&
        drainError !== primaryError &&
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
    if (drainError !== undefined) {
      throw drainError;
    }
    return value as T;
  };
  const serializeLifecycle = async <T>(run: () => Promise<T> | T): Promise<T> => {
    const inheritedOwner = lifecycleOwner.getStore();
    if (inheritedOwner?.active) {
      const waitForPrevious =
        inheritedOwner.nestedPending > 0 ? inheritedOwner.nestedTail : Promise.resolve();
      inheritedOwner.nestedPending += 1;
      const operation = waitForPrevious.then(async () => {
        const childOwner = createLifecycleOwner();
        return await runLifecycleOwner(childOwner, run);
      });
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
  const logTeardownBudgetExpiry = (): void => {
    if (teardownBudgetLogged) {
      return;
    }
    teardownBudgetLogged = true;
    log.error(
      `transcript teardown budget expired: runId=${params.runId ?? "unknown"} ` +
        `sessionId=${params.sessionId ?? "unknown"} pendingWrites=${pendingWrites} ` +
        `timeoutMs=${TRANSCRIPT_TEARDOWN_BUDGET_MS}`,
    );
  };
  const settleWithinTeardownBudget = async (operation: Promise<void>): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), TRANSCRIPT_TEARDOWN_BUDGET_MS);
        timeout.unref?.();
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (!settled) {
      void operation.catch(() => {});
      logTeardownBudgetExpiry();
    }
  };
  const beginCleanup = async (): Promise<void> => {
    const currentOwner = lifecycleOwner.getStore();
    if (currentOwner?.active) {
      throw new Error("cannot start attempt cleanup inside a transcript write callback");
    }
    if (cleanupRequested) {
      if (cleanupDrain) {
        await cleanupDrain;
      }
      return;
    }
    cleanupRequested = true;
    cleanupDrain = settleWithinTeardownBudget(serializeLifecycle(() => {}));
    await cleanupDrain;
  };

  return {
    withTranscriptWrite: (run) => {
      const activeDescendant = lifecycleOwner.getStore()?.active === true;
      if ((cleanupRequested || disposed) && !activeDescendant) {
        const rejected = Promise.reject(
          new Error(
            disposed
              ? "attempt disposed before transcript write"
              : "attempt cleanup started before transcript write",
          ),
        );
        void rejected.catch(() => {});
        return rejected;
      }
      pendingWrites += 1;
      const operation = serializeLifecycle(run);
      void operation
        .finally(() => {
          pendingWrites -= 1;
        })
        .catch(() => {});
      return operation;
    },
    beginCleanup,
    dispose: async () => {
      const currentOwner = lifecycleOwner.getStore();
      if (currentOwner?.active) {
        throw new Error("cannot dispose an attempt from inside a transcript write callback");
      }
      disposePromise ??= (async () => {
        await beginCleanup();
        disposed = true;
      })();
      await disposePromise;
    },
  };
}
