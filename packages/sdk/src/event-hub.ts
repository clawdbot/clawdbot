import type { GatewayEvent } from "./types.js";

// Async event hub with bounded replay for SDK event streams.
type Listener<T> = (event: T) => void;

/** Replay settings for EventHub streams. */
type EventHubOptions = {
  replayLimit?: number;
};

/** Per-stream options for including replayed events. */
type EventStreamOptions = {
  replay?: boolean;
};

/** Small publish/subscribe hub used by SDK transports and normalized events. */
export class EventHub<T> {
  private readonly replayLimit: number;
  private readonly replayEvents: T[] = [];
  private closed = false;
  private closeError: unknown;
  private hasCloseError = false;
  private readonly listeners = new Set<Listener<T>>();
  private readonly waiters = new Set<() => void>();

  constructor(options: EventHubOptions = {}) {
    this.replayLimit = options.replayLimit ?? 0;
  }

  publish(event: T): void {
    if (this.closed) {
      return;
    }
    if (this.replayLimit > 0) {
      this.replayEvents.push(event);
      const overflow = this.replayEvents.length - this.replayLimit;
      if (overflow > 0) {
        this.replayEvents.splice(0, overflow);
      }
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  close(error?: unknown): void {
    const hasError = arguments.length > 0;
    if (hasError) {
      this.closeError = error;
      this.hasCloseError = true;
    }
    this.closed = true;
    this.replayEvents.length = 0;
    this.listeners.clear();
    for (const wake of this.waiters) {
      wake();
    }
    this.waiters.clear();
  }

  snapshot(filter?: (event: T) => boolean): T[] {
    return filter ? this.replayEvents.filter(filter) : [...this.replayEvents];
  }

  stream(filter?: (event: T) => boolean, options: EventStreamOptions = {}): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => {
        let queue: (T | undefined)[] = options.replay ? this.snapshot(filter) : [];
        let queueHead = 0;
        let stopped = false;
        let streamError: unknown;
        let hasStreamError = false;
        type PendingRead = {
          resolve: (result: IteratorResult<T>) => void;
          reject: (error: unknown) => void;
          wake: () => void;
        };
        const pendingReads: PendingRead[] = [];
        const finishPendingReads = () => {
          for (const pending of pendingReads.splice(0)) {
            this.waiters.delete(pending.wake);
            if (hasStreamError) {
              pending.reject(streamError);
            } else if (this.hasCloseError) {
              pending.reject(this.closeError);
            } else {
              pending.resolve({ done: true, value: undefined });
            }
          }
        };
        const cleanup = () => {
          if (stopped) {
            return;
          }
          stopped = true;
          // Iterator retirement discards its backlog; hub close alone still permits draining.
          queue.length = 0;
          this.listeners.delete(listener);
          finishPendingReads();
        };
        const listener = (event: T) => {
          let matches: boolean;
          try {
            matches = !filter || filter(event);
          } catch (error) {
            streamError = error;
            hasStreamError = true;
            cleanup();
            return;
          }
          // A filter can synchronously return this iterator before publication resumes.
          if (!matches || stopped) {
            return;
          }
          const pending = pendingReads.shift();
          if (pending) {
            this.waiters.delete(pending.wake);
            pending.resolve({ done: false, value: event });
            return;
          }
          queue.push(event);
        };

        this.listeners.add(listener);

        return {
          next: async (): Promise<IteratorResult<T>> => {
            if (stopped) {
              if (hasStreamError) {
                throw streamError;
              }
              if (this.hasCloseError) {
                throw this.closeError;
              }
              return { done: true, value: undefined };
            }
            if (queueHead < queue.length) {
              const value = queue[queueHead] as T;
              // Release consumed payloads immediately; lagging consumers compact only
              // after a substantial prefix reaches half the buffer, amortizing dequeue.
              queue[queueHead++] = undefined;
              if (queueHead >= 1024 && queueHead * 2 >= queue.length) {
                queue = queue.slice(queueHead);
                queueHead = 0;
              }
              return { done: false, value };
            }
            if (!this.closed) {
              return await new Promise<IteratorResult<T>>((resolve, reject) => {
                const pending: PendingRead = {
                  resolve,
                  reject,
                  wake: () => cleanup(),
                };
                pendingReads.push(pending);
                this.waiters.add(pending.wake);
              });
            }
            cleanup();
            if (this.hasCloseError) {
              throw this.closeError;
            }
            return { done: true, value: undefined };
          },
          return: async (): Promise<IteratorResult<T>> => {
            cleanup();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
}

export function isGatewayEvent(value: unknown): value is GatewayEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { event?: unknown }).event === "string"
  );
}
