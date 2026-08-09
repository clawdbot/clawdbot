import { AsyncLocalStorage } from "node:async_hooks";
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.types.js";

const preparedReplyDispatchRuntime = new AsyncLocalStorage<
  PreparedReplyDispatchRuntime | undefined
>();

/** Keeps the configured Gateway generation request-scoped without widening the public resolver. */
export function runWithPreparedReplyDispatchRuntime<T>(
  runtime: PreparedReplyDispatchRuntime | undefined,
  run: () => T,
): T {
  return preparedReplyDispatchRuntime.run(runtime, run);
}

export function getPreparedReplyDispatchRuntime(): PreparedReplyDispatchRuntime | undefined {
  return preparedReplyDispatchRuntime.getStore();
}
