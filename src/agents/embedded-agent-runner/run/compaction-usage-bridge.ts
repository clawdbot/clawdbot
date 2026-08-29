import type { ContextEngineRuntimeContext } from "../../../context-engine/types.js";
import type { NormalizedUsage } from "../../usage.js";

export type CompactionUsageRecorder = (usage: NormalizedUsage) => void;

// The legacy context-engine delegate carries identity, not a public callback.
const recorderByRuntimeContext = new WeakMap<object, CompactionUsageRecorder>();

export function attachCompactionUsageRecorder(
  runtimeContext: ContextEngineRuntimeContext,
  recorder: CompactionUsageRecorder,
): void {
  recorderByRuntimeContext.set(runtimeContext, recorder);
}

export function readCompactionUsageRecorder(
  runtimeContext: object | undefined,
): CompactionUsageRecorder | undefined {
  return runtimeContext ? recorderByRuntimeContext.get(runtimeContext) : undefined;
}
