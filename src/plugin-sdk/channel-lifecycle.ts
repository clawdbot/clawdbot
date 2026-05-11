/**
 * @deprecated Broad public SDK barrel. Prefer focused channel-message and
 * channel lifecycle subpaths, and avoid adding new imports here.
 */

export * from "./channel-lifecycle.core.js";
export * from "../channels/draft-preview-finalizer.js";
export * from "../channels/draft-stream-controls.js";
export * from "../channels/draft-stream-loop.js";
export { createRunStateMachine } from "../channels/run-state-machine.js";
export {
  createArmableStallWatchdog,
  type ArmableStallWatchdog,
  type StallWatchdogTimeoutMeta,
} from "../channels/transport/stall-watchdog.js";
