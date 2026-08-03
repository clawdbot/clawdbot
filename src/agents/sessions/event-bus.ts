/**
 * Tiny event bus abstraction for session UI/runtime notifications.
 *
 * Isolates handler failures so one bad subscriber cannot break later listeners.
 */
import { EventEmitter } from "node:events";

/** Minimal publish/subscribe interface used by session components. */
export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Event bus plus lifecycle control for tests and teardown. */
export interface EventBusController extends EventBus {
  clear(): void;
}

/** Creates an in-process event bus with unsubscribe and clear support. */
export function createEventBus(): EventBusController {
  const emitter = new EventEmitter();
  return {
    emit: (channel, data) => {
      emitter.emit(channel, data);
    },
    on: (channel, handler) => {
      const safeHandler = (data: unknown) => {
        try {
          handler(data);
        } catch (err) {
          // Session event handlers are observers; log and keep the bus alive.
          console.error(`Event handler error (${channel}):`, err);
        }
      };
      emitter.on(channel, safeHandler);
      return () => emitter.off(channel, safeHandler);
    },
    clear: () => {
      emitter.removeAllListeners();
    },
  };
}
