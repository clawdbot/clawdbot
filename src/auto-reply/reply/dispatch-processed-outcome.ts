// Channel-internal seam carrying a dispatch's terminal processed outcome to the turn kernel.
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { DispatchProcessedOutcome } from "./dispatch-from-config.audit.js";

/** Terminal outcome recorded while dispatching; names the branch that ended the turn. */
export type DispatchProcessedNote = {
  outcome: DispatchProcessedOutcome;
  reason?: string;
};

type DispatchProcessedOutcomeSink = { current?: DispatchProcessedNote };

const DISPATCH_PROCESSED_OUTCOME_SINK_KEY: unique symbol = Symbol.for(
  "openclaw.dispatchProcessedOutcomeSink",
);

const dispatchProcessedOutcomeSink = resolveGlobalSingleton<
  AsyncLocalStorage<DispatchProcessedOutcomeSink>
>(DISPATCH_PROCESSED_OUTCOME_SINK_KEY, () => new AsyncLocalStorage<DispatchProcessedOutcomeSink>());

/**
 * Runs a channel turn's dispatch under a sink so its terminal outcome can attribute
 * zero-count warnings without widening the plugin-visible dispatch result contract.
 */
export async function withDispatchProcessedOutcomeSink<T>(
  run: () => Promise<T>,
): Promise<{ result: T; processedOutcome?: DispatchProcessedNote }> {
  const sink: DispatchProcessedOutcomeSink = {};
  const result = await dispatchProcessedOutcomeSink.run(sink, run);
  return { result, processedOutcome: sink.current };
}

/** Records the dispatch's terminal outcome for the surrounding channel turn, if any. */
export function noteDispatchProcessedOutcome(note: DispatchProcessedNote): void {
  const sink = dispatchProcessedOutcomeSink.getStore();
  if (sink) {
    sink.current = note;
  }
}
