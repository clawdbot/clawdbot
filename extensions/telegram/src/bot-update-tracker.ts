import {
  buildTelegramUpdateKey,
  createTelegramUpdateDedupe,
  resolveTelegramUpdateId,
  type TelegramUpdateKeyContext,
} from "./bot-updates.js";

type PersistUpdateId = (updateId: number) => void | Promise<void>;

type TelegramUpdateTrackerOptions = {
  initialUpdateId?: number | null;
  onAcceptedUpdateId?: PersistUpdateId;
  onPersistError?: (error: unknown) => void;
  onSkip?: (key: string) => void;
};

type AcceptedTelegramUpdate = {
  key?: string;
  updateId?: number;
};

type BeginUpdateResult =
  | {
      accepted: true;
      update: AcceptedTelegramUpdate;
    }
  | {
      accepted: false;
      reason: "accepted-watermark" | "semantic-dedupe";
    };

type FinishUpdateOptions = {
  completed: boolean;
};

export type TelegramUpdateTrackerState = {
  highestAcceptedUpdateId: number | null;
  highestPersistedAcceptedUpdateId: number | null;
  highestCompletedUpdateId: number | null;
  safeCompletedUpdateId: number | null;
  pendingUpdateIds: number[];
  failedUpdateIds: number[];
};

function sortedIds(ids: Set<number>): number[] {
  return [...ids].toSorted((a, b) => a - b);
}

export function createTelegramUpdateTracker(options: TelegramUpdateTrackerOptions = {}) {
  const initialUpdateId =
    typeof options.initialUpdateId === "number" ? options.initialUpdateId : null;
  const recentUpdates = createTelegramUpdateDedupe();
  const pendingUpdateKeys = new Set<string>();
  const activeHandledUpdateKeys = new Map<string, boolean>();
  const pendingUpdateIds = new Set<number>();
  const failedUpdateIds = new Set<number>();
  let highestAcceptedUpdateId: number | null = initialUpdateId;
  let highestPersistedAcceptedUpdateId: number | null = initialUpdateId;
  let highestPersistenceRequestedUpdateId: number | null = initialUpdateId;
  let highestCompletedUpdateId: number | null = initialUpdateId;
  let persistInFlight = false;
  let persistTargetUpdateId: number | null = null;

  const skip = (key: string) => {
    options.onSkip?.(key);
  };

  const drainPersistQueue = async () => {
    const persist = options.onAcceptedUpdateId;
    if (persistInFlight || typeof persist !== "function") {
      return;
    }
    persistInFlight = true;
    try {
      while (persistTargetUpdateId !== null) {
        const updateId = persistTargetUpdateId;
        persistTargetUpdateId = null;
        try {
          await persist(updateId);
          if (
            highestPersistedAcceptedUpdateId === null ||
            updateId > highestPersistedAcceptedUpdateId
          ) {
            highestPersistedAcceptedUpdateId = updateId;
          }
        } catch (err) {
          options.onPersistError?.(err);
        }
      }
    } finally {
      persistInFlight = false;
    }
  };

  const requestPersistAcceptedUpdateId = (updateId: number) => {
    if (typeof options.onAcceptedUpdateId !== "function") {
      return;
    }
    if (
      highestPersistenceRequestedUpdateId !== null &&
      updateId <= highestPersistenceRequestedUpdateId
    ) {
      return;
    }
    highestPersistenceRequestedUpdateId = updateId;
    persistTargetUpdateId = updateId;
    void drainPersistQueue().catch((err) => {
      options.onPersistError?.(err);
    });
  };

  const acceptUpdateId = (updateId: number) => {
    if (highestAcceptedUpdateId !== null && updateId <= highestAcceptedUpdateId) {
      return;
    }
    highestAcceptedUpdateId = updateId;
    requestPersistAcceptedUpdateId(updateId);
  };

  const beginUpdate = (ctx: TelegramUpdateKeyContext): BeginUpdateResult => {
    const updateId = resolveTelegramUpdateId(ctx);
    const updateKey = buildTelegramUpdateKey(ctx);
    if (typeof updateId === "number") {
      if (highestAcceptedUpdateId !== null && updateId <= highestAcceptedUpdateId) {
        if (!failedUpdateIds.has(updateId)) {
          skip(`update:${updateId}`);
          return { accepted: false, reason: "accepted-watermark" };
        }
      } else {
        failedUpdateIds.delete(updateId);
      }
    }
    if (updateKey) {
      if (pendingUpdateKeys.has(updateKey) || recentUpdates.peek(updateKey)) {
        skip(updateKey);
        return { accepted: false, reason: "semantic-dedupe" };
      }
      pendingUpdateKeys.add(updateKey);
      activeHandledUpdateKeys.set(updateKey, false);
    }
    if (typeof updateId === "number") {
      pendingUpdateIds.add(updateId);
      acceptUpdateId(updateId);
    }
    return {
      accepted: true,
      update: {
        ...(updateKey ? { key: updateKey } : {}),
        ...(typeof updateId === "number" ? { updateId } : {}),
      },
    };
  };

  const finishUpdate = (update: AcceptedTelegramUpdate, finish: FinishUpdateOptions) => {
    if (update.key) {
      activeHandledUpdateKeys.delete(update.key);
      if (finish.completed) {
        recentUpdates.check(update.key);
      }
      pendingUpdateKeys.delete(update.key);
    }
    if (typeof update.updateId === "number") {
      pendingUpdateIds.delete(update.updateId);
      if (finish.completed) {
        failedUpdateIds.delete(update.updateId);
        if (highestCompletedUpdateId === null || update.updateId > highestCompletedUpdateId) {
          highestCompletedUpdateId = update.updateId;
        }
      } else {
        failedUpdateIds.add(update.updateId);
      }
    }
  };

  const shouldSkipHandlerDispatch = (ctx: TelegramUpdateKeyContext) => {
    const updateId = resolveTelegramUpdateId(ctx);
    if (typeof updateId === "number" && initialUpdateId !== null && updateId <= initialUpdateId) {
      return true;
    }
    const key = buildTelegramUpdateKey(ctx);
    if (!key) {
      return false;
    }
    const handled = activeHandledUpdateKeys.get(key);
    if (handled != null) {
      if (handled) {
        skip(key);
        return true;
      }
      activeHandledUpdateKeys.set(key, true);
      return false;
    }
    const skipped = recentUpdates.check(key);
    if (skipped) {
      skip(key);
    }
    return skipped;
  };

  const resolveSafeCompletedUpdateId = () => {
    if (highestCompletedUpdateId === null) {
      return null;
    }
    let safeCompletedUpdateId = highestCompletedUpdateId;
    for (const updateId of pendingUpdateIds) {
      if (updateId <= safeCompletedUpdateId) {
        safeCompletedUpdateId = updateId - 1;
      }
    }
    for (const updateId of failedUpdateIds) {
      if (updateId <= safeCompletedUpdateId) {
        safeCompletedUpdateId = updateId - 1;
      }
    }
    return safeCompletedUpdateId;
  };

  const getState = (): TelegramUpdateTrackerState => ({
    highestAcceptedUpdateId,
    highestPersistedAcceptedUpdateId,
    highestCompletedUpdateId,
    safeCompletedUpdateId: resolveSafeCompletedUpdateId(),
    pendingUpdateIds: sortedIds(pendingUpdateIds),
    failedUpdateIds: sortedIds(failedUpdateIds),
  });

  return {
    beginUpdate,
    finishUpdate,
    getState,
    shouldSkipHandlerDispatch,
  };
}
