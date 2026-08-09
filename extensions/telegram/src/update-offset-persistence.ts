// Telegram plugin module owns monotonic update-offset persistence and retry.
import {
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
} from "openclaw/plugin-sdk/runtime-env";

const OFFSET_PERSIST_RETRY_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 5_000,
  factor: 2,
  jitter: 0.1,
};

type TelegramUpdateOffsetPersistenceOptions = {
  initialUpdateId: number | null;
  writeUpdateId: (updateId: number) => Promise<void>;
  onInvalidUpdateId: (updateId: number) => void;
  onRetry: (retry: { attempt: number; delayMs: number; error: unknown; updateId: number }) => void;
  abortSignal?: AbortSignal;
};

export function normalizeTelegramUpdateId(value: number | null): number | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

export function createTelegramUpdateOffsetPersistence(
  options: TelegramUpdateOffsetPersistenceOptions,
) {
  const stopController = new AbortController();
  const retrySignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, stopController.signal])
    : stopController.signal;
  let acceptedUpdateId = options.initialUpdateId;
  let committedUpdateId = options.initialUpdateId;
  let pendingUpdateId: number | null = null;
  let activeDrain: Promise<void> | undefined;

  const drain = async () => {
    let attempt = 0;
    while (pendingUpdateId !== null) {
      if (retrySignal.aborted) {
        return;
      }
      const updateId = pendingUpdateId;
      try {
        await options.writeUpdateId(updateId);
        committedUpdateId = updateId;
        if (pendingUpdateId === updateId) {
          pendingUpdateId = null;
        }
        attempt = 0;
      } catch (error) {
        if (retrySignal.aborted) {
          return;
        }
        attempt += 1;
        const delayMs = computeBackoff(OFFSET_PERSIST_RETRY_POLICY, attempt);
        options.onRetry({ attempt, delayMs, error, updateId });
        await sleepWithAbort(delayMs, retrySignal, { ref: false });
      }
    }
  };

  const startDrain = () => {
    if (activeDrain) {
      return;
    }
    const run = drain()
      .catch(() => undefined)
      .finally(() => {
        if (activeDrain === run) {
          activeDrain = undefined;
          if (pendingUpdateId !== null && !retrySignal.aborted) {
            startDrain();
          }
        }
      });
    activeDrain = run;
  };

  const persistUpdateId = (updateId: number) => {
    if (retrySignal.aborted) {
      return;
    }
    const normalizedUpdateId = normalizeTelegramUpdateId(updateId);
    if (normalizedUpdateId === null) {
      options.onInvalidUpdateId(updateId);
      return;
    }
    if (acceptedUpdateId !== null && normalizedUpdateId <= acceptedUpdateId) {
      return;
    }
    acceptedUpdateId = normalizedUpdateId;
    pendingUpdateId = normalizedUpdateId;
    startDrain();
  };

  const stop = async () => {
    stopController.abort(new Error("Telegram update-offset persistence stopped."));
    await activeDrain?.catch(() => undefined);
  };

  return {
    getAcceptedUpdateId: () => acceptedUpdateId,
    getCommittedUpdateId: () => committedUpdateId,
    persistUpdateId,
    stop,
  };
}
