import type {
  AgentLoopConfig,
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
  InternalBeforeToolBatchContext,
  InternalBeforeToolBatchResult,
} from "./types.js";

export type InternalBeforeToolBatchHook = (
  context: InternalBeforeToolBatchContext,
  signal?: AbortSignal,
) => Promise<InternalBeforeToolBatchResult | undefined>;

const beforeToolBatchByAgent = new WeakMap<object, InternalBeforeToolBatchHook>();

type InternalReadyToolCall = { toolCallId: string; args: unknown };

export type InternalToolBatchLifecycle = {
  /** Commit admitted calls whose tool implementations are about to start. May throw before launch. */
  commitReadyCalls: (calls: readonly InternalReadyToolCall[]) => void;
  /** Release admission state for admitted prepared calls that will not launch. */
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

export type InternalToolExecutionPreparation =
  | {
      kind: "immediate";
      outcome:
        | { kind: "result"; result: AgentToolResult<unknown>; isError: boolean }
        | { kind: "error"; error: unknown };
      dispose: () => void;
    }
  | {
      kind: "ready";
      args: unknown;
      execute: (onImplementationStart?: () => void) => Promise<AgentToolResult<unknown>>;
      dispose: () => void;
    };

export type InternalToolExecutionPreparer = (params: {
  toolCallId: string;
  args: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  executionArgs?: unknown[];
}) => Promise<InternalToolExecutionPreparation>;

const toolExecutionPreparerByTool = new WeakMap<object, InternalToolExecutionPreparer>();

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

/** Attach OpenClaw-owned two-phase execution without changing the public AgentTool shape. */
export function attachInternalToolExecutionPreparer<T extends object>(
  tool: T,
  preparer: InternalToolExecutionPreparer,
): T {
  toolExecutionPreparerByTool.set(tool, preparer);
  return tool;
}

export function getInternalToolExecutionPreparer(
  tool: object,
): InternalToolExecutionPreparer | undefined {
  return toolExecutionPreparerByTool.get(tool);
}

/** Preserve private execution ownership when an adapter replaces a tool object. */
export function copyInternalToolExecutionPreparer<T extends object>(source: object, target: T): T {
  const preparer = toolExecutionPreparerByTool.get(source);
  if (preparer) {
    toolExecutionPreparerByTool.set(target, preparer);
  }
  return target;
}
