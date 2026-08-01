import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getBuzzRuntime } from "./runtime.js";

const WATERMARK_NAMESPACE = "buzz.recovery-watermark";
const WATERMARK_MAX_ENTRIES = 1_000;

export type BuzzRecoveryWatermark = { seconds: number };

export type BuzzRecoveryWatermarkStore = PluginStateKeyedStore<BuzzRecoveryWatermark>;

export function openBuzzRecoveryWatermarkStore(params?: {
  onError?: (error: Error) => void;
}): BuzzRecoveryWatermarkStore | undefined {
  try {
    return getBuzzRuntime().state.openKeyedStore<BuzzRecoveryWatermark>({
      namespace: WATERMARK_NAMESPACE,
      maxEntries: WATERMARK_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
  } catch (error) {
    params?.onError?.(error instanceof Error ? error : new Error(String(error)));
    return undefined;
  }
}

function isUsableWatermark(
  value: BuzzRecoveryWatermark | undefined,
): value is BuzzRecoveryWatermark {
  return typeof value?.seconds === "number" && Number.isFinite(value.seconds);
}

export async function resolveBuzzColdStartSince(params: {
  store: BuzzRecoveryWatermarkStore | undefined;
  accountId: string;
  nowSeconds: number;
  lookbackSeconds: number;
  onError?: (error: Error) => void;
}): Promise<number> {
  const { store, accountId, nowSeconds, lookbackSeconds } = params;
  if (!store) {
    return nowSeconds;
  }
  try {
    const persisted = await store.lookup(accountId);
    if (isUsableWatermark(persisted)) {
      const floor = nowSeconds - lookbackSeconds;
      return Math.min(Math.max(persisted.seconds, floor), nowSeconds);
    }
    await store.register(accountId, { seconds: nowSeconds });
  } catch (error) {
    params.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
  return nowSeconds;
}

export type BuzzRecoveryFrontier = {
  admit: (params: { createdAt: number; observedSeconds: number }) => number;
  settle: (token: number) => number | undefined;
  abandon: (token: number) => void;
  markBacklogDrained: () => number | undefined;
};

export function createBuzzRecoveryFrontier(params: { sinceSeconds: number }): BuzzRecoveryFrontier {
  const outstanding = new Map<number, number>();
  let committed = params.sinceSeconds;
  let settledCeiling: number | undefined;
  let failedFloor = Number.POSITIVE_INFINITY;
  let backlogDrained = false;
  let nextToken = 0;

  const nextCheckpoint = (): number | undefined => {
    if (!backlogDrained || settledCeiling === undefined) {
      return undefined;
    }
    let checkpoint = Math.min(settledCeiling, failedFloor);
    for (const seconds of outstanding.values()) {
      checkpoint = Math.min(checkpoint, seconds);
    }
    if (checkpoint <= committed) {
      return undefined;
    }
    committed = checkpoint;
    return committed;
  };

  return {
    admit({ createdAt, observedSeconds }) {
      const token = nextToken;
      nextToken += 1;
      outstanding.set(
        token,
        Number.isFinite(createdAt) ? Math.min(createdAt, observedSeconds) : observedSeconds,
      );
      return token;
    },
    settle(token) {
      const seconds = outstanding.get(token);
      if (seconds === undefined) {
        return undefined;
      }
      outstanding.delete(token);
      settledCeiling = settledCeiling === undefined ? seconds : Math.max(settledCeiling, seconds);
      return nextCheckpoint();
    },
    abandon(token) {
      const seconds = outstanding.get(token);
      if (seconds === undefined) {
        return;
      }
      outstanding.delete(token);
      failedFloor = Math.min(failedFloor, seconds);
    },
    markBacklogDrained() {
      backlogDrained = true;
      return nextCheckpoint();
    },
  };
}

export async function advanceBuzzRecoveryWatermark(params: {
  store: BuzzRecoveryWatermarkStore | undefined;
  accountId: string;
  seconds: number;
  onError?: (error: Error) => void;
}): Promise<void> {
  const { store, accountId, seconds } = params;
  if (!store || !Number.isFinite(seconds)) {
    return;
  }
  const next = { seconds } satisfies BuzzRecoveryWatermark;
  try {
    if (store.update) {
      await store.update(accountId, (current) =>
        isUsableWatermark(current) && current.seconds >= seconds ? current : next,
      );
      return;
    }
    const current = await store.lookup(accountId);
    if (isUsableWatermark(current) && current.seconds >= seconds) {
      return;
    }
    await store.register(accountId, next);
  } catch (error) {
    params.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
