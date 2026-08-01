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
