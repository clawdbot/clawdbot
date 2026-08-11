import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getBuzzRuntime } from "./runtime.js";
import { BUZZ_MAX_CONFIGURED_ROOMS } from "./subscription-budget.js";

const WATERMARK_NAMESPACE = "buzz.recovery-watermark";
const WATERMARK_MAX_ENTRIES = BUZZ_MAX_CONFIGURED_ROOMS;

export type BuzzRecoveryWatermark = { seconds: number };

export type BuzzRecoveryWatermarkStore = PluginStateKeyedStore<BuzzRecoveryWatermark>;

function roomCursorKey(accountId: string, channelId: string): string {
  return `room:${accountId}:${channelId}`;
}

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
  channelIds: readonly string[];
  nowSeconds: number;
  lookbackSeconds: number;
  onError?: (error: Error) => void;
}): Promise<Map<string, number>> {
  const { store, accountId, channelIds, nowSeconds, lookbackSeconds } = params;
  const sinceByRoom = new Map(channelIds.map((channelId) => [channelId, nowSeconds]));
  if (!store) {
    return sinceByRoom;
  }
  try {
    const floor = nowSeconds - lookbackSeconds;
    for (const channelId of channelIds) {
      const key = roomCursorKey(accountId, channelId);
      const persisted = await store.lookup(key);
      if (isUsableWatermark(persisted)) {
        sinceByRoom.set(channelId, Math.min(Math.max(persisted.seconds, floor), nowSeconds));
        continue;
      }
      await store.register(key, { seconds: nowSeconds });
    }
  } catch (error) {
    params.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
  return sinceByRoom;
}

export type BuzzRecoveryToken = { channelId: string; id: number };

export type BuzzRecoveryFrontier = {
  admit: (params: {
    channelId: string;
    createdAt: number;
    observedSeconds: number;
  }) => BuzzRecoveryToken;
  settle: (token: BuzzRecoveryToken) => void;
  abandon: (token: BuzzRecoveryToken) => void;
  markBacklogDrained: () => void;
};

type RoomFrontier = {
  committed: number;
  outstanding: Map<number, number>;
  settledCeiling: number | undefined;
  failedFloor: number;
};

export function createBuzzRecoveryFrontier(params: {
  sinceFor: (channelId: string) => number;
  onCheckpoint: (channelId: string, seconds: number) => void;
}): BuzzRecoveryFrontier {
  const rooms = new Map<string, RoomFrontier>();
  let backlogDrained = false;
  let nextToken = 0;

  const roomFrontier = (channelId: string): RoomFrontier => {
    const existing = rooms.get(channelId);
    if (existing) {
      return existing;
    }
    const created = {
      committed: params.sinceFor(channelId),
      outstanding: new Map<number, number>(),
      settledCeiling: undefined,
      failedFloor: Number.POSITIVE_INFINITY,
    } satisfies RoomFrontier;
    rooms.set(channelId, created);
    return created;
  };

  const publishCheckpoint = (channelId: string, room: RoomFrontier): void => {
    if (!backlogDrained || room.settledCeiling === undefined) {
      return;
    }
    let checkpoint = Math.min(room.settledCeiling, room.failedFloor);
    for (const seconds of room.outstanding.values()) {
      checkpoint = Math.min(checkpoint, seconds);
    }
    if (checkpoint <= room.committed) {
      return;
    }
    room.committed = checkpoint;
    params.onCheckpoint(channelId, checkpoint);
  };

  return {
    admit({ channelId, createdAt, observedSeconds }) {
      const id = nextToken;
      nextToken += 1;
      roomFrontier(channelId).outstanding.set(
        id,
        Number.isFinite(createdAt) ? Math.min(createdAt, observedSeconds) : observedSeconds,
      );
      return { channelId, id };
    },
    settle({ channelId, id }) {
      const room = roomFrontier(channelId);
      const seconds = room.outstanding.get(id);
      if (seconds === undefined) {
        return;
      }
      room.outstanding.delete(id);
      room.settledCeiling =
        room.settledCeiling === undefined ? seconds : Math.max(room.settledCeiling, seconds);
      publishCheckpoint(channelId, room);
    },
    abandon({ channelId, id }) {
      const room = roomFrontier(channelId);
      const seconds = room.outstanding.get(id);
      if (seconds === undefined) {
        return;
      }
      room.outstanding.delete(id);
      room.failedFloor = Math.min(room.failedFloor, seconds);
    },
    markBacklogDrained() {
      backlogDrained = true;
      for (const [channelId, room] of rooms) {
        publishCheckpoint(channelId, room);
      }
    },
  };
}

export async function advanceBuzzRecoveryWatermark(params: {
  store: BuzzRecoveryWatermarkStore | undefined;
  accountId: string;
  channelId: string;
  seconds: number;
  onError?: (error: Error) => void;
}): Promise<void> {
  const { store, accountId, channelId, seconds } = params;
  if (!store || !Number.isFinite(seconds)) {
    return;
  }
  const key = roomCursorKey(accountId, channelId);
  const next = { seconds } satisfies BuzzRecoveryWatermark;
  try {
    if (store.update) {
      await store.update(key, (current) =>
        isUsableWatermark(current) && current.seconds >= seconds ? current : next,
      );
      return;
    }
    const current = await store.lookup(key);
    if (isUsableWatermark(current) && current.seconds >= seconds) {
      return;
    }
    await store.register(key, next);
  } catch (error) {
    params.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
