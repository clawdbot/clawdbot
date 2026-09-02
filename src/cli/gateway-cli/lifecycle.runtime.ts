// Lazy lifecycle runtime export hub used by gateway run-loop restart paths.
// run-loop.ts primes this hub before the HTTP listener binds, so each re-export
// must target the module that defines the symbol rather than a re-export facade;
// a facade also evaluates its siblings and drags their graphs onto cold start.
export { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
export {
  respawnGatewayProcessForUpdate,
  restartGatewayProcessWithFreshPid,
} from "../../infra/process-respawn.js";
export {
  resolveGatewayRestartDeferralTimeoutMs,
  consumeGatewaySigusr1RestartIntent,
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  peekGatewaySigusr1RestartReason,
  resetGatewayRestartStateForInProcessRestart,
  requestGatewayRestartWithSignalAdmission,
  rollbackGatewayRestartSignalAdmission,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
export {
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewayRestartIntentSync,
} from "../../infra/restart-intent.js";
export { writeGatewayRestartHandoffSync } from "../../infra/restart-handoff.js";
export {
  cancelManagedServiceUpdateHandoff,
  claimManagedServiceUpdateHandoff,
  commitManagedServiceUpdateHandoff,
  requestManagedServiceUpdateHandoffPark,
} from "../../infra/update-managed-service-handoff.js";
export { resetGatewaySuspendCoordinatorForLifecycleRestart } from "../../infra/gateway-suspend-coordinator.js";
export { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
export { markUpdateRestartSentinelFailure } from "../../infra/restart-sentinel.js";
export {
  detectGatewayRespawnSupervisor,
  detectRespawnSupervisor,
} from "../../infra/supervisor-markers.js";
export { writeDiagnosticStabilityBundleForFailureSync } from "../../logging/diagnostic-stability-bundle.js";
export {
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
} from "../../infra/gateway-active-work.js";
export {
  advanceCronActiveJobGeneration,
  resetCronActiveJobs,
  waitForActiveCronJobs,
} from "../../cron/active-jobs.js";
export {
  abortActiveCronTaskRuns,
  retireActiveCronTaskRunTracking,
  waitForActiveCronTaskRuns,
} from "../../cron/service/active-run-cancellation.js";
export { markGatewayDraining, resetAllLanes } from "../../process/command-queue.js";
export { reloadTaskRuntimeStateFromStore } from "../../tasks/runtime-internal.js";
export { abortPendingChannelReloads } from "../../gateway/server-reload-contracts.js";

export async function stopGatewayManagedProviderLocalServices(): Promise<void> {
  const { hasManagedProviderLocalServices } =
    await import("../../agents/provider-runtime-lifecycle.js");
  if (!hasManagedProviderLocalServices()) {
    return;
  }
  const { stopManagedProviderLocalServices } =
    await import("../../agents/provider-local-service.js");
  await stopManagedProviderLocalServices();
}
