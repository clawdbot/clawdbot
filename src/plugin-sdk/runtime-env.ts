// Shared process/runtime utilities for plugins. This is the public boundary for
// logger wiring, runtime env shims, and global verbose console helpers.

export type { RuntimeEnv } from "../runtime.js";
export { createNonExitingRuntime, defaultRuntime } from "../runtime.js";
export {
  danger,
  info,
  isVerbose,
  logVerbose,
  shouldLogVerbose,
  success,
  warn,
} from "../globals.js";
export { sleep } from "../utils/sleep.js";

export { isTruthyEnvValue } from "../infra/env.js";
export { getChildLogger, resetLogger, setLoggerOverride, toPinoLikeLogger } from "../logging.js";
export { waitForAbortSignal } from "../infra/abort-signal.js";
export { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
export type { BackoffPolicy } from "../infra/backoff.js";
export {
  formatDurationPrecise,
  formatDurationSeconds,
} from "../infra/format-time/format-duration.ts";
export { retryAsync } from "../infra/retry.js";
export { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
export {
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
} from "../infra/unhandled-rejections.js";
export { isWSL2Sync } from "../infra/wsl.js";

export { createSubsystemLogger } from "../logging/subsystem.js";
