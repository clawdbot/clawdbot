// Co-located runtime entry for subagent-announce continuation drain.
//
// `subagent-announce.ts` lazy-loads
// `../auto-reply/continuation/delegate-dispatch.js` via
// `importRuntimeModule(import.meta.url, [...])`. The bundler does not rewrite
// the path expression inside `importRuntimeModule`, and the flat-dist emission
// drops the source-tree subdirectory, so at runtime the import resolves to a
// non-existent nested path and fails with `ERR_MODULE_NOT_FOUND`.
//
// The fix mirrors `subagent-registry.runtime.ts`: declare a co-located runtime
// entry whose path resolves cleanly post-bundle, and route the dynamic import
// through it. This keeps the cycle-avoidance property of the lazy import
// (delegate-dispatch never enters the static graph of subagent-announce)
// while giving the bundler a stable on-disk target.
//
// Registered as a tsdown bundler entry: `subagent-announce.continuation.runtime`
// in `tsdown.config.ts`.
export { dispatchToolDelegates } from "../auto-reply/continuation/delegate-dispatch.js";
export {
  loadContinuationChainState,
  persistContinuationChainState,
} from "../auto-reply/continuation/state.js";
// Same-session continue_work wake scheduling + liveness check. A subagent's
// bare CONTINUE_WORK token is a self-continuation (the child claims its own next
// turn), normally armed by the spawn-init/turn-1 path from the run payloads.
// Routing it through the same durable scheduler here lets the completion flow
// arm the wake from the canonical transcript findings when the payload-based
// path could not (#952), guarded by the liveness check to avoid double-arming.
export { scheduleContinuationWorkBatch } from "../auto-reply/continuation/work-dispatch.js";
export { hasLiveOrRecentlyDispatchedContinuationWork } from "../auto-reply/continuation/work-store.js";
export { updateSessionEntry } from "../config/sessions/session-accessor.js";
export { resolveStorePath, resolveAgentIdFromSessionKey } from "../config/sessions.js";
