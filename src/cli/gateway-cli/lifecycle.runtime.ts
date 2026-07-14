// Lazy lifecycle runtime export hub used by gateway run-loop restart paths.
export {
  abortEmbeddedAgentRun,
  getActiveEmbeddedRunCount,
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
  waitForActiveEmbeddedRuns,
} from "../../agents/embedded-agent-runner/runs.js";
export { markRestartAbortedMainSessions } from "../../agents/main-session-restart-recovery.js";
export { getRuntimeConfig } from "../../config/config.js";
export {
  respawnGatewayProcessForUpdate,
  restartGatewayProcessWithFreshPid,
} from "../../infra/process-respawn.js";
export {
  resolveGatewayRestartDeferralTimeoutMs,
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewaySigusr1RestartIntent,
  consumeGatewayRestartIntentSync,
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  peekGatewaySigusr1RestartReason,
  resetGatewayRestartStateForInProcessRestart,
  requestGatewayRestartWithSignalAdmission,
  rollbackGatewayRestartSignalAdmission,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
export { writeGatewayRestartHandoffSync } from "../../infra/restart-handoff.js";
export { resetGatewaySuspendCoordinatorForLifecycleRestart } from "../../infra/gateway-suspend-coordinator.js";
export { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
export { markUpdateRestartSentinelFailure } from "../../infra/restart-sentinel.js";
export { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
export { writeDiagnosticStabilityBundleForFailureSync } from "../../logging/diagnostic-stability-bundle.js";
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
export {
  getActiveTaskCount,
  markGatewayDraining,
  resetAllLanes,
  waitForActiveTasks,
} from "../../process/command-queue.js";
export { waitForActiveGatewayRootWork } from "../../process/gateway-work-admission.js";
export { getInspectableActiveTaskRestartBlockers } from "../../tasks/task-registry.maintenance.js";
export { reloadTaskRuntimeStateFromStore } from "../../tasks/runtime-internal.js";
export { abortPendingChannelReloads } from "../../gateway/server-reload-handlers.js";
