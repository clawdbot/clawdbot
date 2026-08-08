import type {
  AgentLoopConfig,
  AgentMessage,
  InternalBeforeToolBatchContext,
  InternalBeforeToolBatchResult,
} from "./types.js";

export type InternalBeforeToolBatchHook = (
  context: InternalBeforeToolBatchContext,
  signal?: AbortSignal,
) => Promise<InternalBeforeToolBatchResult | undefined>;

const beforeToolBatchByAgent = new WeakMap<object, InternalBeforeToolBatchHook>();

export type InternalToolBatchLifecycle = {
  /** Commit admitted calls whose tool implementations are about to start. May throw before launch. */
  commitReadyCalls: (toolCallIds: readonly string[]) => void;
  /** Release admission state for admitted prepared calls suppressed by steering. */
  releaseSkippedCalls: (toolCallIds: readonly string[]) => void;
};

const toolBatchLifecycleByResult = new WeakMap<
  InternalBeforeToolBatchResult,
  InternalToolBatchLifecycle
>();

type InternalSteeringGetter = NonNullable<AgentLoopConfig["getSteeringMessages"]>;
type InternalSyncSteeringGetter = () => AgentMessage[];
const syncSteeringGetterByCallback = new WeakMap<
  InternalSteeringGetter,
  InternalSyncSteeringGetter
>();

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

/** Attach scheduler lifecycle ownership without widening the public admission result. */
export function attachInternalToolBatchLifecycle(
  result: InternalBeforeToolBatchResult,
  lifecycle: InternalToolBatchLifecycle,
): InternalBeforeToolBatchResult {
  toolBatchLifecycleByResult.set(result, lifecycle);
  return result;
}

export function takeInternalToolBatchLifecycle(
  result: InternalBeforeToolBatchResult,
): InternalToolBatchLifecycle | undefined {
  const lifecycle = toolBatchLifecycleByResult.get(result);
  toolBatchLifecycleByResult.delete(result);
  return lifecycle;
}

/** Attach Agent-owned synchronous draining to the exact public async callback identity. */
export function attachInternalSyncSteeringGetter(
  callback: InternalSteeringGetter,
  syncGetter: InternalSyncSteeringGetter,
): InternalSteeringGetter {
  syncSteeringGetterByCallback.set(callback, syncGetter);
  return callback;
}

export function getInternalSyncSteeringGetter(
  callback: InternalSteeringGetter,
): InternalSyncSteeringGetter | undefined {
  return syncSteeringGetterByCallback.get(callback);
}
