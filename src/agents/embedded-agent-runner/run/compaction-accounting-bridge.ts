import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import type { ContextEngineRuntimeContext } from "../../../context-engine/types.js";
import type { CompactionRequestConstraints } from "../../sessions/compaction/request-budget.js";
import type { SessionManager } from "../../sessions/session-manager.js";
import type { NormalizedUsage } from "../../usage.js";

type CompactionAccountingRecorder = CompactionRequestConstraints & {
  /** The caller's buffer owns recovery; its portable identity grants no durable access. */
  memoryTranscript?: {
    sessionManager: SessionManager;
    sessionTarget: SessionTranscriptRuntimeTarget;
    assertActive: () => void;
  };
  recordUsage?: (usage: NormalizedUsage) => void;
  recordCompaction?: (tokensAfter: number | undefined) => void;
};

// Bind to the actual invocation context after watchdog projection. Public
// metadata cannot supply billing or committed-context facts for the owning run.
const recorderByRuntimeContext = new WeakMap<object, CompactionAccountingRecorder>();

export function attachCompactionAccountingRecorder(
  runtimeContext: ContextEngineRuntimeContext,
  recorder: CompactionAccountingRecorder,
): void {
  recorderByRuntimeContext.set(runtimeContext, recorder);
}

export function readCompactionAccountingRecorder(
  runtimeContext: object | undefined,
): CompactionAccountingRecorder | undefined {
  return runtimeContext ? recorderByRuntimeContext.get(runtimeContext) : undefined;
}
