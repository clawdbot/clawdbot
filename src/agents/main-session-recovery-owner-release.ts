import { getRuntimeConfig } from "../config/io.js";
import { getGatewayRecoveryRuntime } from "../gateway/server-recovery-runtime-context.js";
import type { MainSessionRecoveryPendingTarget } from "./main-session-recovery-store.js";

/** Schedules exact-row recovery only after the caller releases its lifecycle admission. */
export function scheduleMainSessionRecoveryPendingTarget(
  target: MainSessionRecoveryPendingTarget | undefined,
): void {
  if (!target) {
    return;
  }
  void import("./main-session-restart-recovery.js").then(
    ({ scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease }) => {
      scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease({
        expectedSessionId: target.sessionId,
        getConfig: getRuntimeConfig,
        getGatewayRuntime: getGatewayRecoveryRuntime,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      });
    },
    () => {
      // Startup recovery remains the fallback if the optional recovery module cannot load.
    },
  );
}
