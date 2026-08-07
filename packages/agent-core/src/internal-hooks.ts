import type { InternalBeforeToolBatchContext, InternalBeforeToolBatchResult } from "./types.js";

export type InternalBeforeToolBatchHook = (
  context: InternalBeforeToolBatchContext,
  signal?: AbortSignal,
) => Promise<InternalBeforeToolBatchResult | undefined>;

const beforeToolBatchByAgent = new WeakMap<object, InternalBeforeToolBatchHook>();

/** Install OpenClaw-owned loop control without adding a plugin-facing Agent option. */
export function setInternalBeforeToolBatch(
  agent: object,
  hook: InternalBeforeToolBatchHook | undefined,
): void {
  if (hook) {
    beforeToolBatchByAgent.set(agent, hook);
  } else {
    beforeToolBatchByAgent.delete(agent);
  }
}

export function getInternalBeforeToolBatch(agent: object): InternalBeforeToolBatchHook | undefined {
  return beforeToolBatchByAgent.get(agent);
}
