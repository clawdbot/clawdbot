import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import {
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceVersion } from "../version.js";

/** The booting Gateway records only its own observations; the CLI owns pending handoffs. */
export function finalizeRestartUpdateRun(payload: RestartSentinelPayload, pendingExpired = false) {
  const updateRunId = payload.stats?.runId;
  let updateRun = updateRunId ? getUpdateRun(updateRunId) : undefined;
  if (updateRun) {
    const runningVersion = resolveRuntimeServiceVersion();
    const runningBuildId = resolveRuntimeServiceBuildId();
    const expectedVersion = updateRun.after.version ?? updateRun.target.version;
    const expectedBuildId = updateRun.after.buildId;
    const pluginErrors = getActivePluginRegistry()
      ?.diagnostics.filter((entry) => entry.level === "error")
      .map((entry) => entry.message);
    updateRun = recordUpdateRunVerification(updateRun.runId, {
      booted: true,
      serviceRunning: true,
      pid: process.pid,
      runningVersion,
      ...(runningBuildId ? { runningBuildId } : {}),
      ...(expectedVersion
        ? {
            versionMatch:
              expectedVersion === runningVersion &&
              (!expectedBuildId || expectedBuildId === runningBuildId),
          }
        : {}),
      ...(pluginErrors ? { pluginErrors } : {}),
      ...(payload.doctorHint ? { doctorHint: payload.doctorHint } : {}),
    });
    // The CLI still owns a pending handoff. A boot proves liveness, not that
    // its validation finished; preserve the sentinel's existing retry flow.
    if (pendingExpired || !isPendingControlPlaneUpdateRestartSentinel(payload)) {
      updateRun = finishUpdateRun(updateRun.runId, {
        status:
          pendingExpired ||
          payload.status === "error" ||
          updateRun.verification.versionMatch === false
            ? "failed"
            : payload.status === "ok"
              ? "succeeded"
              : "skipped",
        reason:
          pendingExpired || updateRun.verification.versionMatch === false
            ? "restart-unhealthy"
            : (payload.stats?.reason ?? undefined),
        after: { version: runningVersion, ...(runningBuildId ? { buildId: runningBuildId } : {}) },
      });
    }
  }
  return updateRun;
}
