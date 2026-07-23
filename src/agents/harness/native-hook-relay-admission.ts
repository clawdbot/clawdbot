const DEFAULT_MAX_ACTIVE = 4;
const DEFAULT_MAX_QUEUED = 32;

export type NativeHookRelayAdmissionSnapshot = {
  active: number;
  queued: number;
  accepted: number;
  completed: number;
  rejected: number;
  cancelled: number;
  coalesced: number;
  peakActive: number;
  peakQueued: number;
};

type QueuedAdmission<T> = {
  operation: (signal?: AbortSignal) => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

type SharedAdmission<T> = {
  abortController: AbortController;
  promise: Promise<T>;
  waiters: number;
};

export class NativeHookRelayAdmissionOverloadedError extends Error {
  constructor() {
    super("native hook relay overloaded");
    this.name = "NativeHookRelayAdmissionOverloadedError";
  }
}

export class NativeHookRelayAdmissionClosedError extends Error {
  constructor() {
    super("native hook relay admission closed");
    this.name = "NativeHookRelayAdmissionClosedError";
  }
}

export class NativeHookRelayAdmissionCancelledError extends Error {
  constructor() {
    super("native hook relay admission cancelled");
    this.name = "NativeHookRelayAdmissionCancelledError";
  }
}

export function isNativeHookRelayAdmissionOverloadedError(
  error: unknown,
): error is NativeHookRelayAdmissionOverloadedError {
  return (
    error instanceof NativeHookRelayAdmissionOverloadedError ||
    (error instanceof Error && error.message === "native hook relay overloaded")
  );
}

/**
 * Bounds policy work for one native relay. Active operations and queued waiters
 * are both hard-capped; queued work starts in arrival order.
 */
export class NativeHookRelayAdmissionController {
  readonly maxActive: number;
  readonly maxQueued: number;

  private active = 0;
  private closed = false;
  private queue: QueuedAdmission<unknown>[] = [];
  private inFlight = new Map<string, SharedAdmission<unknown>>();
  private accepted = 0;
  private completed = 0;
  private rejected = 0;
  private cancelled = 0;
  private coalesced = 0;
  private peakActive = 0;
  private peakQueued = 0;

  constructor(options: { maxActive?: number; maxQueued?: number } = {}) {
    this.maxActive = normalizeLimit(options.maxActive, DEFAULT_MAX_ACTIVE, "maxActive", 1);
    this.maxQueued = normalizeLimit(options.maxQueued, DEFAULT_MAX_QUEUED, "maxQueued", 0);
  }

  run<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; key?: string } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new NativeHookRelayAdmissionClosedError());
    }
    if (options.signal?.aborted) {
      this.cancelled += 1;
      return Promise.reject(new NativeHookRelayAdmissionCancelledError());
    }
    const key = options.key?.trim();
    if (key) {
      const existing = this.inFlight.get(key) as SharedAdmission<T> | undefined;
      if (existing) {
        this.coalesced += 1;
        return this.waitForShared(key, existing, options.signal);
      }
      const abortController = new AbortController();
      const promise = this.runUnique(operation, { signal: abortController.signal });
      const shared: SharedAdmission<T> = { abortController, promise, waiters: 0 };
      this.inFlight.set(key, shared);
      const clear = () => {
        if (this.inFlight.get(key) === shared) {
          this.inFlight.delete(key);
        }
      };
      void promise.then(clear, clear);
      return this.waitForShared(key, shared, options.signal);
    }
    return this.runUnique(operation, options);
  }

  private runUnique<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal },
  ): Promise<T> {
    if (this.active < this.maxActive) {
      this.accepted += 1;
      return this.start(operation, options.signal);
    }
    if (this.queue.length >= this.maxQueued) {
      this.rejected += 1;
      return Promise.reject(new NativeHookRelayAdmissionOverloadedError());
    }
    this.accepted += 1;
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedAdmission<T> = {
        operation,
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      this.queue.push(queued as QueuedAdmission<unknown>);
      this.peakQueued = Math.max(this.peakQueued, this.queue.length);
      if (options.signal) {
        queued.abort = () => {
          const index = this.queue.indexOf(queued as QueuedAdmission<unknown>);
          if (index < 0) {
            return;
          }
          this.queue.splice(index, 1);
          if (!(options.signal?.reason instanceof NativeHookRelayAdmissionCancelledError)) {
            this.cancelled += 1;
          }
          reject(new NativeHookRelayAdmissionCancelledError());
        };
        options.signal.addEventListener("abort", queued.abort, { once: true });
        if (options.signal.aborted) {
          queued.abort();
        }
      }
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      this.detachAbort(entry);
      entry.reject(new NativeHookRelayAdmissionClosedError());
    }
  }

  snapshot(): NativeHookRelayAdmissionSnapshot {
    return {
      active: this.active,
      queued: this.queue.length,
      accepted: this.accepted,
      completed: this.completed,
      rejected: this.rejected,
      cancelled: this.cancelled,
      peakActive: this.peakActive,
      peakQueued: this.peakQueued,
      coalesced: this.coalesced,
    };
  }

  private start<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    let observedAbort = false;
    const onAbort = () => {
      if (!observedAbort) {
        observedAbort = true;
        if (!(signal?.reason instanceof NativeHookRelayAdmissionCancelledError)) {
          this.cancelled += 1;
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    return Promise.resolve()
      .then(() => operation(signal))
      .catch((error: unknown) => {
        if (signal?.aborted) {
          throw new NativeHookRelayAdmissionCancelledError();
        }
        throw error;
      })
      .finally(() => {
        signal?.removeEventListener("abort", onAbort);
        this.active -= 1;
        this.completed += 1;
        this.drain();
      });
  }

  private drain(): void {
    while (!this.closed && this.active < this.maxActive && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) {
        return;
      }
      this.detachAbort(entry);
      if (entry.signal?.aborted) {
        this.cancelled += 1;
        entry.reject(new NativeHookRelayAdmissionCancelledError());
        continue;
      }
      void this.start(entry.operation, entry.signal).then(entry.resolve, entry.reject);
    }
  }

  private detachAbort(entry: QueuedAdmission<unknown>): void {
    if (entry.signal && entry.abort) {
      entry.signal.removeEventListener("abort", entry.abort);
    }
  }

  private async waitForShared<T>(
    key: string,
    shared: SharedAdmission<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    shared.waiters += 1;
    let abort: (() => void) | undefined;
    try {
      if (!signal) {
        return await shared.promise;
      }
      const abortPromise = new Promise<never>((_, reject) => {
        abort = () => {
          this.cancelled += 1;
          reject(new NativeHookRelayAdmissionCancelledError());
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      });
      return await Promise.race([shared.promise, abortPromise]);
    } finally {
      if (abort) {
        signal?.removeEventListener("abort", abort);
      }
      shared.waiters -= 1;
      if (shared.waiters === 0 && this.inFlight.get(key) === shared) {
        shared.abortController.abort(new NativeHookRelayAdmissionCancelledError());
      }
    }
  }
}

function normalizeLimit(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return selected;
}
