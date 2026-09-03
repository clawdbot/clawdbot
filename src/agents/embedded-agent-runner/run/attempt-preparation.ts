import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";

let nextPreparationStart = Promise.resolve();

/** Dispatches attempt stages without letting concurrent starts monopolize the event loop. */
export function createEmbeddedAttemptPreparation(options: {
  config?: OpenClawConfig;
  assertCurrent: () => void;
}) {
  return async <T>(stage: string, run: () => Promise<T> | T): Promise<T> => {
    // Only start turns are serialized. Async work overlaps, and a failed or cancelled
    // attempt cannot reject the shared tail or inherit another caller's async context.
    const start = nextPreparationStart.then(() => yieldToEventLoop());
    nextPreparationStart = start;
    await start;
    // Check before acquisition; the caller must receive each result before another
    // checkpoint can throw so its existing finally blocks own every acquired resource.
    options.assertCurrent();
    return measureEmbeddedAgentPreparation(stage, run, { config: options.config });
  };
}
