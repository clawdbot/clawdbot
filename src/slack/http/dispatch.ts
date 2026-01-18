import type { SlackHttpEventHandler } from "./events.js";

const slackHttpDispatchers = new Set<SlackHttpEventHandler>();

export function registerSlackHttpDispatcher(dispatcher: SlackHttpEventHandler): () => void {
  slackHttpDispatchers.add(dispatcher);
  return () => {
    slackHttpDispatchers.delete(dispatcher);
  };
}

export async function dispatchSlackHttpEvent(payload: unknown): Promise<void> {
  if (slackHttpDispatchers.size === 0) return;
  const dispatches = Array.from(slackHttpDispatchers).map((dispatcher) =>
    Promise.resolve(dispatcher(payload)),
  );
  await Promise.all(dispatches);
}
