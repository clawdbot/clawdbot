import "./enqueue.js";

type QueueEnqueueTestApi = {
  resetRecentQueuedMessageIdDedupe(): void;
};

function getTestApi(): QueueEnqueueTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.queueEnqueueTestApi")
  ];
  if (!api) {
    throw new Error("queue enqueue test API is unavailable");
  }
  return api as QueueEnqueueTestApi;
}

export function resetRecentQueuedMessageIdDedupe(): void {
  getTestApi().resetRecentQueuedMessageIdDedupe();
}
