// Keyed inbound-message debouncer that preserves same-key delivery order.
import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";

/** Resolve effective inbound debounce milliseconds from explicit, channel, and global config. */
export function resolveInboundDebounceMs(params: {
  cfg: OpenClawConfig;
  channel: string;
  overrideMs?: number;
}): number {
  const inbound = params.cfg.messages?.inbound;
  for (const value of [
    params.overrideMs,
    inbound?.byChannel?.[params.channel],
    inbound?.debounceMs,
  ]) {
    const resolved = resolveOptionalIntegerOption(value, { min: 0 });
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return 0;
}

type DebounceBuffer<T> = {
  items: T[];
  timeout: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  flushDeadlineMs: number;
  releaseReady: () => void;
  readyReleased: boolean;
  task: Promise<void>;
};

/** A flush releases its debounce lane at admission while completion remains drainable. */
type InboundDebounceFlush = {
  admission: Promise<void>;
  completion: Promise<void>;
};

type InboundDebounceAdmissionLifecycleInput = {
  abortSignal?: AbortSignal;
  onAdopted?: () => void | Promise<void>;
  onDeferred?: () => boolean | void;
  onDeferredHeartbeat?: () => void;
  onAdoptionFinalizing?: () => void;
  onFailed?: (error: unknown) => void | Promise<void>;
  onAbandoned?: () => void | Promise<void>;
};

/** Lifecycle shape passed to a channel dispatch so it can signal session-lane admission. */
type InboundDebounceAdmissionLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => Promise<void>;
  onDeferred: () => boolean | void;
  onDeferredHeartbeat?: () => void;
  onAdoptionFinalizing: () => void;
  onFailed?: (error: unknown) => Promise<void>;
  onAbandoned: () => Promise<void>;
};

/**
 * Start one flush and bind its admission signal to the turn lifecycle.
 * Completion also releases admission for gated work that never enters a session lane.
 */
function createInboundDebounceFlush(params: {
  lifecycle?: InboundDebounceAdmissionLifecycleInput;
  dispatch: (lifecycle: InboundDebounceAdmissionLifecycle) => Promise<void>;
}): InboundDebounceFlush {
  let resolveAdmission!: () => void;
  let admitted = false;
  const admission = new Promise<void>((resolve) => {
    resolveAdmission = resolve;
  });
  const markAdmitted = () => {
    if (admitted) {
      return;
    }
    admitted = true;
    resolveAdmission();
  };
  const source = params.lifecycle;
  const lifecycle: InboundDebounceAdmissionLifecycle = {
    abortSignal: source?.abortSignal ?? new AbortController().signal,
    onAdopted: async () => {
      await source?.onAdopted?.();
      markAdmitted();
    },
    onDeferred: () => {
      const accepted = source?.onDeferred?.();
      if (accepted !== false) {
        markAdmitted();
      }
      return accepted;
    },
    onDeferredHeartbeat: () => source?.onDeferredHeartbeat?.(),
    onAdoptionFinalizing: () => source?.onAdoptionFinalizing?.(),
    onFailed: source?.onFailed
      ? async (error) => {
          try {
            await source.onFailed?.(error);
          } finally {
            markAdmitted();
          }
        }
      : undefined,
    onAbandoned: async () => {
      await source?.onAbandoned?.();
    },
  };
  let completion: Promise<void>;
  try {
    completion = params.dispatch(lifecycle);
  } catch (error) {
    completion = Promise.reject(toErrorObject(error, "Inbound debounce dispatch failed"));
  }
  // A failed dispatch must settle its source claim before releasing the keyed
  // lane; an already-admitted turn owns its later completion failure.
  completion = completion.then(markAdmitted).catch(async (error: unknown) => {
    if (!admitted && lifecycle.onFailed) {
      await Promise.allSettled([lifecycle.onFailed(error)]);
    }
    markAdmitted();
    throw error;
  });
  return { admission, completion };
}

const DEFAULT_MAX_TRACKED_KEYS = 2048;
const MAX_DEBOUNCE_WINDOW_MULTIPLIER = 5;

/** Options for creating a keyed inbound debouncer. */
export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  serializeImmediate?: boolean;
  onFlush: (items: T[], createFlush: typeof createInboundDebounceFlush) => InboundDebounceFlush;
  onError?: (err: unknown, items: T[]) => void;
  onCancel?: (items: T[]) => void;
};

/** Create a keyed debouncer with flush/cancel controls and same-key serialization. */
export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const keyChains = new Map<string, Promise<void>>();
  const keyGenerations = new Map<string, number>();
  const activeCompletions = new Set<Promise<void>>();
  const defaultDebounceMs = resolveNonNegativeIntegerOption(params.debounceMs, 0);
  const maxTrackedKeys = Math.max(1, Math.trunc(params.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS));

  const resolveDebounceMs = (item: T) => {
    const resolved = params.resolveDebounceMs?.(item);
    return resolveNonNegativeIntegerOption(resolved, defaultDebounceMs);
  };

  const reportFlushError = (err: unknown, items: T[]) => {
    try {
      params.onError?.(err, items);
    } catch {
      // Flush failures are reported via onError, but this helper stays
      // non-throwing so keyed chains can continue processing later items.
    }
  };

  const runFlush = async (items: T[]) => {
    let flush: InboundDebounceFlush;
    try {
      flush = params.onFlush(items, createInboundDebounceFlush);
    } catch (err) {
      reportFlushError(err, items);
      return;
    }
    let reported = false;
    const reportOnce = (err: unknown) => {
      if (reported) {
        return;
      }
      reported = true;
      reportFlushError(err, items);
    };
    const admission = flush.admission.catch(reportOnce);
    const completion = flush.completion.catch(reportOnce);
    activeCompletions.add(completion);
    const cleanup = () => activeCompletions.delete(completion);
    void completion.then(cleanup, cleanup);
    await Promise.race([admission, completion]);
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
    // Keep the first item's monotonic deadline fixed so continuous arrivals
    // and wall-clock changes cannot hold a reserved ingress lane indefinitely.
    const delayMs = Math.min(
      buffer.debounceMs,
      Math.max(0, buffer.flushDeadlineMs - performance.now()),
    );
    buffer.timeout = setTimeout(() => {
      void flushBuffer(key, buffer);
    }, delayMs);
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
      flushDeadlineMs: performance.now() + debounceMs * MAX_DEBOUNCE_WINDOW_MULTIPLIER,
      releaseReady: reservedTask.release,
      readyReleased: false,
      task: reservedTask.task,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  const drain = async () => {
    // Callers flush or cancel buffers first. Waiting both registries closes the
    // handoff gap before a queued same-key task registers its completion.
    while (keyChains.size > 0 || activeCompletions.size > 0) {
      await Promise.all([...keyChains.values(), ...activeCompletions]);
    }
  };

  return { enqueue, flushKey, cancelKey, drain };
}
