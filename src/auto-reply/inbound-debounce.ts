// Keyed inbound-message debouncer that preserves same-key delivery order.
import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import type { InboundDebounceByProvider } from "../config/types.messages.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const resolveMs = (value: unknown): number | undefined =>
  resolveOptionalIntegerOption(value, { min: 0 });

const resolveChannelOverride = (params: {
  byChannel?: InboundDebounceByProvider;
  channel: string;
}): number | undefined => {
  if (!params.byChannel) {
    return undefined;
  }
  return resolveMs(params.byChannel[params.channel]);
};

/** Resolve effective inbound debounce milliseconds from explicit, channel, and global config. */
export function resolveInboundDebounceMs(params: {
  cfg: OpenClawConfig;
  channel: string;
  overrideMs?: number;
}): number {
  const inbound = params.cfg.messages?.inbound;
  const override = resolveMs(params.overrideMs);
  const byChannel = resolveChannelOverride({
    byChannel: inbound?.byChannel,
    channel: params.channel,
  });
  const base = resolveMs(inbound?.debounceMs);
  return override ?? byChannel ?? base ?? 0;
}

type DebounceBuffer<T> = {
  items: T[];
  timeout: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  releaseReady: () => void;
  readyReleased: boolean;
  task: Promise<void>;
};

const DEFAULT_MAX_TRACKED_KEYS = 2048;

/** Options for creating a keyed inbound debouncer. */
export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  serializeImmediate?: boolean;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
  onCancel?: (items: T[]) => void;
};

/** Create a keyed debouncer with flush/cancel controls and same-key serialization. */
export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const keyChains = new Map<string, Promise<void>>();
  const keyGenerations = new Map<string, number>();
  const defaultDebounceMs = resolveNonNegativeIntegerOption(params.debounceMs, 0);
  const maxTrackedKeys = Math.max(1, Math.trunc(params.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS));

  const resolveDebounceMs = (item: T) => {
    const resolved = params.resolveDebounceMs?.(item);
    return resolveNonNegativeIntegerOption(resolved, defaultDebounceMs);
  };

  const runFlush = async (items: T[]) => {
    try {
      await params.onFlush(items);
    } catch (err) {
      try {
        params.onError?.(err, items);
      } catch {
        // Flush failures are reported via onError, but this helper stays
        // non-throwing so keyed chains can continue processing later items.
      }
    }
  };

  const cancelItems = (items: T[]) => {
    try {
      params.onCancel?.(items);
    } catch {
      // Cancellation observers release caller-owned resources; debounce state
      // must still drain even if an observer fails.
    }
  };

  const resolveKeyGeneration = (key: string) => keyGenerations.get(key) ?? 0;

  const runQueuedFlush = async (key: string, generation: number, items: T[]) => {
    if (resolveKeyGeneration(key) !== generation) {
      cancelItems(items);
      return;
    }
    await runFlush(items);
  };

  const enqueueKeyTask = (key: string, task: () => Promise<void>) => {
    const previous = keyChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const settled = next.catch(() => undefined);
    keyChains.set(key, settled);
    const cleanup = () => {
      if (keyChains.get(key) === settled) {
        keyChains.delete(key);
        if (!buffers.has(key)) {
          keyGenerations.delete(key);
        }
      }
    };
    settled.then(cleanup, cleanup);
    return next;
  };

  const runKeyTaskNow = (key: string, task: () => Promise<void>) => {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    keyChains.set(key, settled);
    const cleanup = () => {
      resolveSettled();
      if (keyChains.get(key) === settled) {
        keyChains.delete(key);
        if (!buffers.has(key)) {
          keyGenerations.delete(key);
        }
      }
    };
    let next: Promise<void>;
    try {
      next = task();
    } catch (err) {
      cleanup();
      throw err;
    }
    next.then(cleanup, cleanup);
    return next;
  };

  const enqueueReservedKeyTask = (key: string, task: () => Promise<void>) => {
    let readyReleased = false;
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    return {
      task: enqueueKeyTask(key, async () => {
        await ready;
        await task();
      }),
      release: () => {
        if (readyReleased) {
          return;
        }
        readyReleased = true;
        releaseReady();
      },
    };
  };

  const releaseBuffer = (buffer: DebounceBuffer<T>) => {
    if (buffer.readyReleased) {
      return;
    }
    buffer.readyReleased = true;
    buffer.releaseReady();
  };

  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>) => {
    if (buffers.get(key) === buffer) {
      buffers.delete(key);
    }
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    // Reserve each key's execution slot as soon as the first buffered item
    // arrives, so later same-key work cannot overtake a timer-backed flush.
    releaseBuffer(buffer);
    await buffer.task;
  };

  const flushKey = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return;
    }
    await flushBuffer(key, buffer);
  };

  const cancelKey = (key: string): boolean => {
    const buffer = buffers.get(key);
    if (!buffer && !keyChains.has(key)) {
      return false;
    }
    // Invalidate released tasks still waiting behind an active same-key flush.
    // The active task has already crossed this check and remains caller-owned.
    keyGenerations.set(key, resolveKeyGeneration(key) + 1);
    if (!buffer) {
      return true;
    }
    if (buffers.get(key) === buffer) {
      buffers.delete(key);
    }
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    const canceledItems = buffer.items;
    buffer.items = [];
    cancelItems(canceledItems);
    releaseBuffer(buffer);
    return true;
  };

  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }
    buffer.timeout = setTimeout(() => {
      void flushBuffer(key, buffer);
    }, buffer.debounceMs);
    buffer.timeout.unref?.();
  };

  const canTrackKey = (key: string) => {
    if (buffers.has(key) || keyChains.has(key)) {
      return true;
    }
    return new Set([...buffers.keys(), ...keyChains.keys()]).size < maxTrackedKeys;
  };

  const enqueue = async (item: T) => {
    const key = params.buildKey(item);
    const debounceMs = resolveDebounceMs(item);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (key) {
        if (buffers.has(key)) {
          // Reserve the keyed immediate slot before forcing the pending buffer
          // to flush so fire-and-forget callers cannot be overtaken.
          const generation = resolveKeyGeneration(key);
          const reservedTask = enqueueReservedKeyTask(key, async () => {
            await runQueuedFlush(key, generation, [item]);
          });
          try {
            await flushKey(key);
          } finally {
            reservedTask.release();
          }
          await reservedTask.task;
          return;
        }
        if (keyChains.has(key)) {
          const generation = resolveKeyGeneration(key);
          await enqueueKeyTask(key, async () => {
            await runQueuedFlush(key, generation, [item]);
          });
          return;
        }
        if (params.serializeImmediate) {
          await runKeyTaskNow(key, async () => {
            await runFlush([item]);
          });
          return;
        }
        await runFlush([item]);
      } else {
        await runFlush([item]);
      }
      return;
    }

    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      existing.debounceMs = debounceMs;
      scheduleFlush(key, existing);
      return;
    }
    if (!canTrackKey(key)) {
      // When the debounce map is saturated, fall back to immediate keyed work
      // instead of buffering, but still preserve same-key ordering.
      const generation = resolveKeyGeneration(key);
      await enqueueKeyTask(key, async () => {
        await runQueuedFlush(key, generation, [item]);
      });
      return;
    }
    const generation = resolveKeyGeneration(key);
    const reservedTask = enqueueReservedKeyTask(key, async () => {
      if (buffer.items.length === 0) {
        return;
      }
      const items = buffer.items;
      if (resolveKeyGeneration(key) !== generation) {
        buffer.items = [];
      }
      await runQueuedFlush(key, generation, items);
    });
    const buffer: DebounceBuffer<T> = {
      items: [item],
      timeout: null,
      debounceMs,
      releaseReady: reservedTask.release,
      readyReleased: false,
      task: reservedTask.task,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  return { enqueue, flushKey, cancelKey };
}
