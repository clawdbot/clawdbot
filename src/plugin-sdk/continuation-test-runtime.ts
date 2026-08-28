// Focused continuation runtime controls for bundled plugin integration tests.

export {
  createContinueWorkTool,
  type ContinueWorkRequest,
} from "../agents/tools/continue-work-tool.js";
export {
  cancelPendingDelegates,
  consumePendingDelegates,
} from "../auto-reply/continuation/delegate-store.js";
export { resetContinueDelegateTurnAdmissionForTests } from "../auto-reply/continuation/delegate-turn-admission.js";
export type { ContinuationRuntimeConfig } from "../auto-reply/continuation/types.js";
export { executePendingContinuationWork } from "../auto-reply/continuation/work-dispatch-execution.js";
export {
  classifyContinuationWorkReason,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWorkBatch,
} from "../auto-reply/continuation/work-dispatch.js";
export { decodeWorkState } from "../auto-reply/continuation/work-flow-state.js";
export { consumePendingWork } from "../auto-reply/continuation/work-store.js";
export {
  emitContinuationDelegateFireSpan,
  emitContinuationDelegateSpan,
  emitContinuationWorkFireSpan,
  emitContinuationWorkSpan,
} from "../infra/continuation-tracer.js";
