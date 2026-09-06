import { getRuntimeConfig } from "../../config/io.js";
import { getGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime-context.js";
import type { MainSessionRecoveryPendingTarget } from "./main-session-recovery-store.js";

/** Schedules exact-row recovery only after the caller releases its lifecycle admission. */
export function scheduleMainSessionRecoveryPendingTarget(
  target: MainSessionRecoveryPendingTarget | undefined,
): void {
  if (!target) {
    return;
  }
  void import("./main-session-restart-recovery.js").then(
    ({ scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease: schedule }) =>
      schedule({
        ...target,
        expectedSessionId: target.sessionId,
        getConfig: getRuntimeConfig,
        getGatewayRuntime: getGatewayRecoveryRuntime,
      }),
    () => {}, // Startup recovery remains the fallback if this optional module cannot load.
  );
}
