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
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
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
  private inFlight = new Map<string, Promise<unknown>>();
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
    operation: () => Promise<T>,
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
      const existing = this.inFlight.get(key) as Promise<T> | undefined;
      if (existing) {
        this.coalesced += 1;
        return this.waitForShared(existing, options.signal);
      }
      const promise = this.runUnique(operation, options);
      this.inFlight.set(key, promise);
      const clear = () => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      };
      void promise.then(clear, clear);
      return promise;
    }
    return this.runUnique(operation, options);
  }

  private runUnique<T>(operation: () => Promise<T>, options: { signal?: AbortSignal }): Promise<T> {
    if (this.active < this.maxActive) {
      this.accepted += 1;
      return this.start(operation);
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
          this.cancelled += 1;
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

  private start<T>(operation: () => Promise<T>): Promise<T> {
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    return Promise.resolve()
      .then(operation)
      .finally(() => {
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
      void this.start(entry.operation).then(entry.resolve, entry.reject);
    }
  }

  private detachAbort(entry: QueuedAdmission<unknown>): void {
    if (entry.signal && entry.abort) {
      entry.signal.removeEventListener("abort", entry.abort);
    }
  }

  private waitForShared<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return promise;
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        cleanup();
        this.cancelled += 1;
        reject(new NativeHookRelayAdmissionCancelledError());
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
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
