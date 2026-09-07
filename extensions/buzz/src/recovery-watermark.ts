import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getBuzzRuntime } from "./runtime.js";
import { BUZZ_MAX_CONFIGURED_ROOMS } from "./subscription-budget.js";

type BuzzRecoveryWatermark = { seconds: number };
type BuzzRecoveryWatermarkStore = PluginStateKeyedStore<BuzzRecoveryWatermark>;

function roomCursorKey(channelId: string): string {
  return `room:${channelId}`;
}

export function openBuzzRecoveryWatermarkStore(params: {
  accountId: string;
}): BuzzRecoveryWatermarkStore {
  const accountScope = createHash("sha256").update(params.accountId).digest("hex").slice(0, 16);
  return getBuzzRuntime().state.openKeyedStore<BuzzRecoveryWatermark>({
    namespace: `buzz.recovery-watermark-${accountScope}`,
    maxEntries: BUZZ_MAX_CONFIGURED_ROOMS,
    overflowPolicy: "reject-new",
  });
}

export async function resolveBuzzRecoverySince(params: {
  store: BuzzRecoveryWatermarkStore;
  channelIds: readonly string[];
  nowSeconds: number;
  lookbackSeconds: number;
}): Promise<Map<string, number>> {
  const { store, channelIds, nowSeconds, lookbackSeconds } = params;
  const configuredKeys = new Set(channelIds.map(roomCursorKey));

  // Reclaim removed rooms before reject-new capacity can strand their replacements.
  for (const { key } of await store.entries()) {
    if (key.startsWith("room:") && !configuredKeys.has(key)) {
      await store.delete(key);
    }
  }

  const sinceByRoom = new Map<string, number>();
  const retentionFloor = nowSeconds - lookbackSeconds;
  for (const channelId of channelIds) {
    const key = roomCursorKey(channelId);
    const activation = await store.lookup(key);
    if (activation === undefined) {
      await store.register(key, { seconds: nowSeconds });
      sinceByRoom.set(channelId, nowSeconds);
      continue;
    }
    if (typeof activation.seconds !== "number" || !Number.isFinite(activation.seconds)) {
      throw new Error(`Invalid Buzz recovery watermark for room ${channelId}`);
    }
    // Keep the activation floor immutable: sender timestamps can arrive out of order.
    sinceByRoom.set(channelId, Math.min(Math.max(activation.seconds, retentionFloor), nowSeconds));
  }
  return sinceByRoom;
}
