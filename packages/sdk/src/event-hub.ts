import type { GatewayEvent } from "./types.js";

type Listener<T> = (event: T) => void;

export type EventHubOptions = {
  replayLimit?: number;
};

export type EventStreamOptions = {
  replay?: boolean;
};

export class EventHub<T> {
  private readonly replayLimit: number;
  private readonly replayEvents: T[] = [];
  private closed = false;
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

  close(): void {
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
        const queue: T[] = options.replay ? this.snapshot(filter) : [];
        let stopped = false;
        let wake: (() => void) | null = null;
        const wakePending = () => {
          const pending = wake;
          if (!pending) {
            return;
          }
          wake = null;
          this.waiters.delete(pending);
          pending();
        };
        const listener = (event: T) => {
          if (!filter || filter(event)) {
            queue.push(event);
            wakePending();
          }
        };
        const cleanup = () => {
          if (stopped) {
            return;
          }
          stopped = true;
          this.listeners.delete(listener);
          wakePending();
        };

        this.listeners.add(listener);

        return {
          next: async (): Promise<IteratorResult<T>> => {
            while (true) {
              if (stopped) {
                break;
              }
              if (queue.length > 0) {
                return { done: false, value: queue.shift() as T };
              }
              if (this.closed) {
                break;
              }
              await new Promise<void>((resolve) => {
                const wakeCurrent = () => {
                  if (wake === wakeCurrent) {
                    wake = null;
                  }
                  this.waiters.delete(wakeCurrent);
                  resolve();
                };
                wake = wakeCurrent;
                this.waiters.add(wakeCurrent);
              });
            }
            cleanup();
            return { done: true, value: undefined as never };
          },
          return: async (): Promise<IteratorResult<T>> => {
            cleanup();
            return { done: true, value: undefined as never };
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
