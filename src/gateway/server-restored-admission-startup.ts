import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

export function createRestoredAdmissionBeforeReady(params: {
  runtime: GatewayKernelRuntime;
  log: GatewayLogger;
}) {
  const {
    restoredStartup,
    getRestoredOwnerReadiness,
    cronReconciliation,
    cfgAtStart,
    runtimeState,
    cronStartState,
    startupState,
  } = params.runtime;
  if (!restoredStartup) {
    return {};
  }
  return {
    beforeReady: async () => {
      const completed = await restoredStartup.complete({
        descriptor: restoredStartup.descriptor,
        startScheduler: async () => {
          const reconciliation = cronReconciliation.arm({
            reason: "startup",
            config: cfgAtStart,
            cronState: runtimeState.cronState,
          });
          await runtimeState.cronState.cron.start();
          cronStartState.handled = true;
          await reconciliation.complete();
        },
        getOwnerReadiness: getRestoredOwnerReadiness,
        setHeldReason: restoredStartup.status.setHeldReason,
      });
      if (!restoredStartup.release()) {
        throw new Error("restored Gateway startup lost work admission");
      }
      restoredStartup.status.markReady(completed.record);
      startupState.restoredAdmissionReady = true;
      params.log.info("restored admission opened", {
        readinessIdentity: completed.record.readinessIdentity,
        replayed: completed.replayed,
      });
    },
  };
}
