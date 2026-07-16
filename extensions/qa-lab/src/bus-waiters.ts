import type {
  QaBusEvent,
  QaBusMessage,
  QaBusStateSnapshot,
  QaBusThread,
  QaBusWaitForInput,
} from "./runtime-api.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

export type QaBusWaitMatch = QaBusEvent | QaBusMessage | QaBusThread;

type Waiter = {
  resolve: (event: QaBusWaitMatch) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  matcher: (snapshot: QaBusStateSnapshot) => QaBusWaitMatch | null;
};

function createQaBusMatcher(
  input: QaBusWaitForInput,
): (snapshot: QaBusStateSnapshot) => QaBusWaitMatch | null {
  return (snapshot) => {
    if (input.kind === "event-kind") {
      return snapshot.events.find((event) => event.kind === input.eventKind) ?? null;
    }
    if (input.kind === "thread-id") {
      return snapshot.threads.find((thread) => thread.id === input.threadId) ?? null;
    }
    return (
      snapshot.messages.find(
        (message) =>
          (!input.direction || message.direction === input.direction) &&
          message.text.includes(input.textIncludes),
      ) ?? null
    );
  };
}

export function createQaBusWaiterStore(getSnapshot: () => QaBusStateSnapshot) {
  const waiters = new Set<Waiter>();

  return {
    reset(reason = "qa-bus reset") {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      waiters.clear();
    },
    settle() {
      if (waiters.size === 0) {
        return;
      }
      const snapshot = getSnapshot();
      for (const waiter of Array.from(waiters)) {
        const match = waiter.matcher(snapshot);
        if (!match) {
          continue;
        }
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(match);
      }
    },
    async waitFor(input: QaBusWaitForInput) {
      const matcher = createQaBusMatcher(input);
      const immediate = matcher(getSnapshot());
      if (immediate) {
        return immediate;
      }
      return await new Promise<QaBusWaitMatch>((resolve, reject) => {
        const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        const waiter: Waiter = {
          resolve,
          reject,
          matcher,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`qa-bus wait timeout after ${timeoutMs}ms`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}
