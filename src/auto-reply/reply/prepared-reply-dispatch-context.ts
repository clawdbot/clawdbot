import { AsyncLocalStorage } from "node:async_hooks";
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.types.js";

const preparedReplyDispatchRuntime = new AsyncLocalStorage<
  PreparedReplyDispatchRuntime | undefined
>();

/** Keeps the configured Gateway generation request-scoped without widening the public resolver. */
function runWithPreparedReplyDispatchRuntime<T>(
  runtime: PreparedReplyDispatchRuntime | undefined,
  run: () => T,
): T {
  return preparedReplyDispatchRuntime.run(runtime, run);
}

export function bindPreparedReplyDispatchRuntime<Args extends unknown[], Result>(
  runtime: PreparedReplyDispatchRuntime | undefined,
  run: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => runWithPreparedReplyDispatchRuntime(runtime, () => run(...args));
}

export function getPreparedReplyDispatchRuntime(): PreparedReplyDispatchRuntime | undefined {
  return preparedReplyDispatchRuntime.getStore();
}
