import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import {
  readUpdateStateSchemaVersions,
  updateStateSchemaVersionsMatch,
  type UpdateStateSchemaVersion,
} from "../../infra/update-candidate-state.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { confirmGatewayReachable } from "../daemon-cli/restart-health-probe.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  maybeRestartService,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolveUpdatedGatewayRestartPort,
  type PreManagedServiceStop,
} from "./update-command-service.js";

/** Restore retained bytes only across unchanged schemas; restart needs prior service proof. */
export async function rollbackFailedUpdate(params: {
  result: UpdateRunResult;
  previousRoot: string;
  packageTransaction?: PackageUpdateTransaction;
  rollbackBlockedReason?: "state-migrated-no-rollback" | "rollback-state-unverified";
  schemaVersions?: UpdateStateSchemaVersion[];
  previousVerified?: boolean;
  config: OpenClawConfig;
  opts: UpdateCommandOptions;
  preManagedServiceStop?: PreManagedServiceStop;
  timeoutMs: number;
  nodeRunner?: string;
  invocationCwd?: string;
}): Promise<{
  result: UpdateRunResult;
  rolledBack: boolean;
  downtimeMs?: number;
  verifiedAtMs?: number;
}> {
  const { result, preManagedServiceStop: before, packageTransaction, opts } = params;
  const env = before?.serviceEnv ?? opts.run?.env ?? process.env;
  const state = { stateDir: resolveStateDir(env), config: params.config, env };
  const port = before?.stopped
    ? await resolveUpdatedGatewayRestartPort({ config: params.config, serviceEnv: env })
    : undefined;
  const failed = (reason: string) => {
    stoppedForRollback?.windowsTaskAutoStartRecovery?.complete(false);
    return { result: { ...result, status: "error" as const, reason }, rolledBack: false };
  };
  const schemasUnchanged = async () => {
    const baseline = params.schemaVersions;
    const current = await readUpdateStateSchemaVersions(state);
    return baseline !== undefined && updateStateSchemaVersionsMatch(baseline, current);
  };
  let stoppedForRollback: PreManagedServiceStop | undefined;
  let failureReason = "rollback-state-unverified";
  const stop = async () => {
    failureReason = "service-revalidation-failed";
    const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
      updateRun: opts.run,
      updateInstallKind: "package",
      root: result.root ?? params.previousRoot,
      shouldRestart: true,
      jsonMode: opts.json === true,
      expectedService: before,
      timeoutMs: params.timeoutMs,
    });
    stoppedForRollback = stopped;
    if (
      stopped.blockMessage ||
      stopped.serviceMutationAllowed === false ||
      (stopped.running && !stopped.stopped)
    ) {
      throw new Error(stopped.blockMessage ?? "Candidate service could not be stopped safely.");
    }
    return stopped;
  };
  const stopIfUnreachable = async () => {
    if (port !== undefined && !(await confirmGatewayReachable({ port, env })).reachable) {
      await stop();
    }
  };
  try {
    if (params.rollbackBlockedReason) {
      await stopIfUnreachable();
      return failed(params.rollbackBlockedReason);
    }
    if (!params.schemaVersions) {
      await stopIfUnreachable();
      return failed("rollback-state-unverified");
    }
    if (!(await schemasUnchanged())) {
      await stopIfUnreachable();
      return failed("state-migrated-no-rollback");
    }
    const stopped = before?.stopped ? await stop() : undefined;
    // Recheck after stop so a final startup migration cannot race the first read.
    failureReason = "rollback-state-unverified";
    if (!(await schemasUnchanged())) {
      stopped?.windowsTaskAutoStartRecovery?.complete(false);
      return failed("state-migrated-no-rollback");
    }
    failureReason = "source-rollback-failed";
    if (!packageTransaction) {
      throw new Error("The retained package transaction is unavailable.");
    }
    const restored = await packageTransaction.rollback();
    if (opts.run) {
      recordUpdateRunStep(
        opts.run.runId,
        {
          step: "package rollback",
          status: restored.exitCode === 0 ? "completed" : "failed",
          endedAtMs: Date.now(),
        },
        { env: opts.run.env },
      );
    }
    const restoredResult: UpdateRunResult = {
      ...result,
      root: params.previousRoot,
      after: result.before,
      steps: [...result.steps, restored],
    };
    if (restored.exitCode !== 0) {
      stopped?.windowsTaskAutoStartRecovery?.complete(false);
      return { result: { ...restoredResult, reason: "source-rollback-failed" }, rolledBack: false };
    }
    restoredResult.recovery = {
      serviceRestartSafe: false,
      packageRollbackVerified: true,
      reason: "runtime-verification-failed",
    };
    // A no-service or --no-restart update owns file restoration only. Preserve
    // its original failure without claiming or changing a Gateway generation.
    if (!stopped || port === undefined) {
      return { result: restoredResult, rolledBack: false };
    }
    if (!params.previousVerified || !result.before?.version) {
      // Restoring retained bytes is safe after the schema fence. Starting the
      // previous runtime additionally requires its pre-activation verification.
      stopped.windowsTaskAutoStartRecovery?.complete(false);
      return {
        result: { ...restoredResult, reason: "previous-version-unverified" },
        rolledBack: false,
      };
    }
    await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(stopped, true);
    // A failed candidate does not authorize its restart. The previous package's
    // pre-activation verification authorizes restarting this schema-neutral restoration.
    const verdict = stopped.serviceUpdateVerdict ?? before?.serviceUpdateVerdict;
    let verifiedAtMs: number | undefined;
    failureReason = "restart-unhealthy";
    const healthy = await maybeRestartService({
      shouldRestart: true,
      result: restoredResult,
      channel: "stable",
      opts,
      refreshServiceEnv: verdict?.kind === "owned" && verdict.refreshDefinition,
      serviceUpdateVerdict: verdict,
      serviceEnv: env,
      serviceInstallEnv: before?.serviceDefinitionEnv,
      gatewayPort: port,
      requireRunningServiceAfterRestart: true,
      timeoutMs: params.timeoutMs,
      // Prior verification covers this executable too; refreshing with the
      // candidate's newer Node would not restore the previously serving runtime.
      nodeRunner: before?.serviceNodeRunner ?? params.nodeRunner,
      invocationCwd: params.invocationCwd,
      onVerified: (at) => {
        verifiedAtMs = at;
      },
    });
    return {
      result: {
        ...restoredResult,
        recovery: healthy
          ? { serviceRestartSafe: true, version: result.before.version, service: "healthy" }
          : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        ...(healthy ? {} : { reason: "restart-unhealthy" }),
      },
      rolledBack: healthy,
      ...(verifiedAtMs === undefined ? {} : { verifiedAtMs }),
      ...(verifiedAtMs !== undefined && stopped.stoppedAtMs !== undefined
        ? { downtimeMs: Math.max(0, verifiedAtMs - stopped.stoppedAtMs) }
        : {}),
    };
  } catch (error) {
    let detail = formatErrorMessage(error);
    if (failureReason === "rollback-state-unverified") {
      try {
        await stopIfUnreachable();
        failureReason = "rollback-state-unverified";
      } catch (stopError) {
        detail += `; ${formatErrorMessage(stopError)}`;
      }
    }
    stoppedForRollback?.windowsTaskAutoStartRecovery?.complete(false);
    if (opts.run) {
      recordUpdateRunStep(
        opts.run.runId,
        {
          step: "package rollback",
          status: "failed",
          endedAtMs: Date.now(),
          detail,
        },
        { env: opts.run.env },
      );
    }
    return failed(failureReason);
  }
}
