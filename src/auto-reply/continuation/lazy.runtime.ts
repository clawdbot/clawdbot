// Lazy-load boundary for the continuation subsystem.
//
// Callers that need continuation helpers on a cold/lazy path import THIS
// module via `await import("../continuation/lazy.runtime.js")` instead of
// directly importing `./config.js`, `./delegate-store.js`, etc. That
// routes every dynamic continuation load through a single module boundary
// which the bundler can dedupe with the static graph — eliminating the
// static+dynamic import mix that has bitten this tree multiple times.
//
// Rule: never statically import from this file. A static `import`
// defeats the boundary's purpose by re-entering the underlying modules
// in the main chunk. Dynamic-only. `pnpm build` surfaces drift via
// `INEFFECTIVE_DYNAMIC_IMPORT` warnings.
//
// Registered as a tsdown bundler entry:
// `auto-reply/continuation/lazy.runtime` in `tsdown.config.ts`.

export { resolveContinuationRuntimeConfig } from "./config.js";
export { checkContextPressure, clearContextPressureState } from "./context-pressure.js";
export { dispatchToolDelegates } from "./delegate-dispatch.js";
export { scheduleContinuationWork, scheduleContinuationWorkBatch } from "./work-dispatch.js";
export { pendingDelegateCount } from "./delegate-store.js";
export {
  assertStagedPostCompactionFinalizationComplete,
  claimStagedPostCompactionTaskFlowDelegates,
  finalizeStagedPostCompactionDelegates,
  stagedPostCompactionDelegateCount,
} from "./delegate-store-post-compaction.js";
export { hasLiveOrRecentlyDispatchedContinuationWork } from "./work-store.js";
export { loadContinuationChainState, persistContinuationChainState } from "./state.js";
