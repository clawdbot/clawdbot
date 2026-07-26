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
  deadlineAt?: number;
  releaseReady: () => void;
  readyReleased: boolean;
  task: Promise<void>;
};

const DEFAULT_MAX_TRACKED_KEYS = 2048;

export type InboundDebounceDecision =
  | { action: "debounce"; debounceMs?: number }
  | { action: "bypass" };

/** Options for creating a keyed inbound debouncer. */
export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  /** Optional async policy decision. An explicit result overrides the legacy callbacks. */
  resolveDecision?: (
    item: T,
  ) => InboundDebounceDecision | undefined | Promise<InboundDebounceDecision | undefined>;
  /** Return false to flush the current buffer before adding this item. */
  canCombine?: (bufferedItems: readonly T[], item: T) => boolean;
  /** Optional absolute batch lifetime introduced by this item. */
  resolveMaxBufferAgeMs?: (item: T) => number | undefined;
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
  const decisionChains = new Map<string, Promise<void>>();
  const pendingDecisionReleases = new Map<string, Set<() => void>>();
  const pendingDecisionCounts = new Map<string, number>();
  const defaultDebounceMs = resolveNonNegativeIntegerOption(params.debounceMs, 0);
  const maxTrackedKeys = Math.max(1, Math.trunc(params.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS));

  const resolveDebounceMs = (item: T) => {
    const resolved = params.resolveDebounceMs?.(item);
    return resolveNonNegativeIntegerOption(resolved, defaultDebounceMs);
  };

  const resolveItemDeadline = (item: T): number | undefined => {
    const maxAgeMs = params.resolveMaxBufferAgeMs?.(item);
    if (maxAgeMs === undefined) {
      return undefined;
    }
    return Date.now() + resolveNonNegativeIntegerOption(maxAgeMs, 0);
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
        if (!buffers.has(key) && !decisionChains.has(key)) {
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
        if (!buffers.has(key) && !decisionChains.has(key)) {
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
    if (!buffer && !keyChains.has(key) && !decisionChains.has(key)) {
      return false;
    }
    // Invalidate released tasks still waiting behind an active same-key flush.
    // The active task has already crossed this check and remains caller-owned.
    keyGenerations.set(key, resolveKeyGeneration(key) + 1);
    for (const release of pendingDecisionReleases.get(key) ?? []) {
      release();
    }
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
      buffer.timeout = null;
    }
    const hasPendingDecision = (pendingDecisionCounts.get(key) ?? 0) > 0;
    if (hasPendingDecision && buffer.deadlineAt === undefined) {
      return;
    }
    const remainingLifetime =
      buffer.deadlineAt === undefined
        ? buffer.debounceMs
        : Math.max(0, buffer.deadlineAt - Date.now());
    buffer.timeout = setTimeout(
      () => {
        void flushBuffer(key, buffer);
      },
      hasPendingDecision ? remainingLifetime : Math.min(buffer.debounceMs, remainingLifetime),
    );
    buffer.timeout.unref?.();
  };

  const canTrackKey = (key: string) => {
    if (buffers.has(key) || keyChains.has(key) || decisionChains.has(key)) {
      return true;
    }
    return (
      new Set([...buffers.keys(), ...keyChains.keys(), ...decisionChains.keys()]).size <
      maxTrackedKeys
    );
  };

  const enqueueResolved = async (
    item: T,
    key: string | null | undefined,
    resolvedDecision?: InboundDebounceDecision,
    markApplied: () => void = () => undefined,
    expectedGeneration?: number,
  ) => {
    if (
      key &&
      expectedGeneration !== undefined &&
      resolveKeyGeneration(key) !== expectedGeneration
    ) {
      cancelItems([item]);
      markApplied();
      return;
    }
    const decision =
      resolvedDecision?.action === "debounce" || resolvedDecision?.action === "bypass"
        ? resolvedDecision
        : undefined;
    const debounceMs =
      decision?.action === "debounce"
        ? resolveNonNegativeIntegerOption(decision.debounceMs, resolveDebounceMs(item))
        : resolveDebounceMs(item);
    const canDebounce =
      debounceMs > 0 &&
      (decision?.action === "debounce" ||
        (decision?.action !== "bypass" && (params.shouldDebounce?.(item) ?? true)));

    if (!canDebounce || !key) {
      if (key) {
        if (buffers.has(key)) {
          // Reserve the keyed immediate slot before forcing the pending buffer
          // to flush so fire-and-forget callers cannot be overtaken.
          const generation = resolveKeyGeneration(key);
          const reservedTask = enqueueReservedKeyTask(key, async () => {
            await runQueuedFlush(key, generation, [item]);
          });
          const flushTask = flushKey(key);
          try {
            await flushTask;
          } finally {
            reservedTask.release();
          }
          await reservedTask.task;
          markApplied();
          return;
        }
        if (keyChains.has(key)) {
          const generation = resolveKeyGeneration(key);
          const task = enqueueKeyTask(key, async () => {
            await runQueuedFlush(key, generation, [item]);
          });
          await task;
          markApplied();
          return;
        }
        if (params.serializeImmediate) {
          const task = runKeyTaskNow(key, async () => {
            await runFlush([item]);
          });
          await task;
          markApplied();
          return;
        }
        const task = runFlush([item]);
        await task;
        markApplied();
      } else {
        const task = runFlush([item]);
        await task;
        markApplied();
      }
      return;
    }

    const existing = buffers.get(key);
    let previousFlush: Promise<void> | undefined;
    if (existing) {
      if (params.canCombine && !params.canCombine(existing.items, item)) {
        previousFlush = flushKey(key);
      } else {
        existing.items.push(item);
        existing.debounceMs = debounceMs;
        const itemDeadline = resolveItemDeadline(item);
        if (itemDeadline !== undefined) {
          existing.deadlineAt =
            existing.deadlineAt === undefined
              ? itemDeadline
              : Math.min(existing.deadlineAt, itemDeadline);
        }
        scheduleFlush(key, existing);
        markApplied();
        return;
      }
    }
    if (!canTrackKey(key)) {
      // When the debounce map is saturated, fall back to immediate keyed work
      // instead of buffering, but still preserve same-key ordering.
      const generation = resolveKeyGeneration(key);
      const task = enqueueKeyTask(key, async () => {
        await runQueuedFlush(key, generation, [item]);
      });
      markApplied();
      await task;
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
      deadlineAt: resolveItemDeadline(item),
      releaseReady: reservedTask.release,
      readyReleased: false,
      task: reservedTask.task,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
    markApplied();
    // The new item is already retained in its own buffer. A preceding flush
    // failure must not reject this enqueue and invite a duplicate retry.
    await previousFlush?.catch(() => undefined);
  };

  const enqueue = async (item: T) => {
    const key = params.buildKey(item);
    if (!params.resolveDecision || !key) {
      return enqueueResolved(item, key);
    }
    if (!canTrackKey(key)) {
      // Saturated keys bypass policy evaluation but still need a short-lived
      // key chain so same-conversation work cannot run concurrently.
      const generation = resolveKeyGeneration(key);
      return enqueueKeyTask(key, async () => {
        await runQueuedFlush(key, generation, [item]);
      });
    }
    const generation = resolveKeyGeneration(key);
    const previous = decisionChains.get(key) ?? Promise.resolve();
    let rawDecision:
      | InboundDebounceDecision
      | undefined
      | Promise<InboundDebounceDecision | undefined>;
    try {
      rawDecision = params.resolveDecision(item);
    } catch (error) {
      rawDecision = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const synchronousBypass =
      rawDecision !== undefined && "action" in rawDecision && rawDecision.action === "bypass"
        ? rawDecision
        : undefined;
    if (synchronousBypass) {
      for (const release of pendingDecisionReleases.get(key) ?? []) {
        release();
      }
      // Synchronous bypass is the urgent control lane: /stop and /abort must
      // overtake active delivery so they can interrupt it. Ordinary decisions
      // stay on the serialized decision chain below.
      return enqueueResolved(item, key, synchronousBypass, undefined, generation);
    }
    const rawDecisionPromise = Promise.resolve(rawDecision);
    // Decisions start eagerly, so observe rejection before an earlier same-key
    // item finishes applying. The returned enqueue task still carries the error.
    void rawDecisionPromise.catch(() => undefined);
    let decision = rawDecisionPromise;
    pendingDecisionCounts.set(key, (pendingDecisionCounts.get(key) ?? 0) + 1);
    const heldBuffer = buffers.get(key);
    if (heldBuffer?.timeout) {
      clearTimeout(heldBuffer.timeout);
      heldBuffer.timeout = null;
    }
    if (heldBuffer) {
      // Pending policy work pauses trailing debounce, but never the absolute
      // lifetime of an existing batch (for example one retaining media).
      scheduleFlush(key, heldBuffer);
    }
    let releasePending!: () => void;
    const released = new Promise<undefined>((resolve) => {
      releasePending = () => resolve(undefined);
    });
    const releases = pendingDecisionReleases.get(key) ?? new Set<() => void>();
    releases.add(releasePending);
    pendingDecisionReleases.set(key, releases);
    decision = Promise.race([rawDecisionPromise, released]);
    void decision.then(
      () => {
        releases.delete(releasePending);
        if (releases.size === 0) {
          pendingDecisionReleases.delete(key);
        }
      },
      () => {
        releases.delete(releasePending);
        if (releases.size === 0) {
          pendingDecisionReleases.delete(key);
        }
      },
    );
    let releaseApplied!: () => void;
    const applied = new Promise<void>((resolve) => {
      releaseApplied = resolve;
    });
    let appliedReleased = false;
    const markApplied = () => {
      if (appliedReleased) {
        return;
      }
      appliedReleased = true;
      releaseApplied();
      const remaining = (pendingDecisionCounts.get(key) ?? 1) - 1;
      if (remaining > 0) {
        pendingDecisionCounts.set(key, remaining);
      } else {
        pendingDecisionCounts.delete(key);
        const buffer = buffers.get(key);
        if (buffer) {
          scheduleFlush(key, buffer);
        }
      }
    };
    const task = previous
      .catch(() => undefined)
      .then(async () => enqueueResolved(item, key, await decision, markApplied, generation))
      .finally(() => {
        markApplied();
      });
    decisionChains.set(key, applied);
    void applied.then(() => {
      if (decisionChains.get(key) === applied) {
        decisionChains.delete(key);
        if (!buffers.has(key) && !keyChains.has(key)) {
          keyGenerations.delete(key);
        }
      }
    });
    return task;
  };

  return { enqueue, flushKey, cancelKey };
}
