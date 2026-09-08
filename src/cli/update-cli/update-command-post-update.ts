import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import type { UpdateStateSchemaVersion } from "../../infra/update-candidate-state.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  readControlPlaneUpdateSentinelMeta,
  resolveManagedServiceUpdateFailureExitCode,
} from "../../infra/update-control-plane-sentinel.js";
import {
  getUpdateRun,
  finishUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { formatCliCommand } from "../command-format.js";
import { printResult } from "./progress.js";
import { tryWriteCompletionCache, type UpdateCommandOptions } from "./shared.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { repairUpdateService } from "./update-command-repair-service.js";
import {
  prepareUpdateRestart,
  type UpdateRestartParams,
} from "./update-command-restart-context.js";
import {
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  UpdateCommandFailure,
  resolveAutomaticUpdateTriage,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  GatewayServiceUpdateOwnershipError,
} from "./update-command-service-plan.js";
import {
  recordFailedUpdateGatewayState,
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  resolveUpdatedGatewayRestartPort,
  tryInstallShellCompletion,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

export type FinishUpdateParams = UpdateRestartParams & {
  failure?: { cause: unknown; detail: string };
  mutationStarted: boolean;
  expectedVersion?: string;
  previousInstallRoot?: string;
  installKindChanged: boolean;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  channel: UpdateChannel;
  downgradeRisk: boolean;
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: Awaited<ReturnType<typeof readControlPlaneUpdateSentinelMeta>>;
  preUpdatePluginInstallRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  startedAt: number;
  packageUpdateNodeRunner?: string;
  packageTransaction?: PackageUpdateTransaction;
  schemaVersions?: UpdateStateSchemaVersion[];
  candidateSchemaVersions?: OpenClawSchemaVersions;
  previousSchemaVersions?: OpenClawSchemaVersions;
  previousVerified?: boolean;
  activationConfig?: import("./update-command-config-snapshot.js").UpdateConfigSnapshot;
  rollbackBlockedReason?: "state-migrated-no-rollback" | "rollback-state-unverified";
};

export async function finishUpdate(params: FinishUpdateParams): Promise<UpdateRunResult> {
  let gateway: TriageFailureContext["gateway"] = "preserve";
  let triageAllowed = true;
  const createFailure = (
    result: UpdateRunResult,
    exitCode = 1,
    detail?: string,
    options?: ErrorOptions,
  ) =>
    new UpdateCommandFailure(result, exitCode, detail, {
      ...options,
      automaticTriage: triageAllowed
        ? resolveAutomaticUpdateTriage(result, detail, { ...params, gateway })
        : undefined,
    });
  let rollbackAttempted = false;
  let postVerificationRepairAttempted = false;
  let rollbackStopState: PreManagedServiceStop | undefined;
  // Rollback and later plugin maintenance can replace the suspension owner.
  const currentServiceStop = () => rollbackStopState ?? params.preManagedServiceStop;
  const resumeWindowsAutoStart = async (result: UpdateRunResult) => {
    const stopped = currentServiceStop();
    await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
      stopped,
      true,
      stopped
        ? createWindowsTaskAutoStartGuard({
            root: result.root ?? params.root,
            before: stopped,
            timeoutMs: params.updateStepTimeoutMs,
          })
        : undefined,
    );
  };
  let rolledBack = false;
  let completedDowntimeMs: number | undefined;
  let pendingRestartAtMs =
    params.preManagedServiceStop?.stoppedAtMs ??
    params.controlPlaneUpdateSentinelMeta?.serviceStoppedAtMs;
  // Health resets replace ledger verification. Keep completed outages here so
  // recovery never counts the online plugin work between service stops.
  const recordVerifiedDowntime = (verifiedAtMs: number) => {
    if (pendingRestartAtMs !== undefined) {
      completedDowntimeMs =
        (completedDowntimeMs ?? 0) + Math.max(0, verifiedAtMs - pendingRestartAtMs);
      pendingRestartAtMs = undefined;
    }
  };
  // Finalization owns the complete outcome, including recovery, restart, and completion work.
  const completedResult = (result: UpdateRunResult): UpdateRunResult => ({
    ...result,
    ...(result.status === "error" && params.rollbackBlockedReason
      ? { reason: params.rollbackBlockedReason }
      : {}),
    durationMs: Math.max(0, Date.now() - params.startedAt),
  });
  const recordNextAction = (result: UpdateRunResult) => {
    const run = params.opts.run;
    const active = run ? getUpdateRun(run.runId, { env: run.env }) : undefined;
    const nextAction = resolveUpdateResultNextAction({
      result,
      serviceRunning: active?.verification.serviceRunning,
      runningVersion: active?.verification.runningVersion,
      verificationFailure: active?.steps.findLast(
        (step) => step.step === "gateway verification" && step.status === "failed",
      )?.detail,
      env: run?.env ?? params.ownedManagedUpdateEnv ?? process.env,
    });
    if (run && active?.status === "running" && active.origin.nextAction !== nextAction) {
      recordUpdateRunPhase(run.runId, active.phase, { origin: { nextAction } }, { env: run.env });
    }
    return nextAction;
  };
  // Restart can let the new Gateway finish the row before CLI finalization resumes.
  // Store the next action before that handoff, and refresh it if recovery changes the outcome.
  recordNextAction(params.result);
  const printFinalResult = (input: UpdateRunResult) => {
    const nextAction = recordNextAction(input);
    const run = params.opts.run;
    const downtimeMs = pendingRestartAtMs === undefined ? completedDowntimeMs : undefined;
    if (run && rolledBack) {
      finishUpdateRun(
        run.runId,
        { status: "rolled-back", reason: input.reason, after: input.after, downtimeMs },
        { env: run.env },
      );
    }
    const result = completeUpdateCommandRun(input, run, downtimeMs);
    printResult(result, params.opts, { nextAction });
    return result;
  };
  const recoverFailedResult = async (
    initialResult: UpdateRunResult,
    initialRecoverService: boolean,
    repair?: (result: UpdateRunResult) => Promise<UpdateRunResult>,
  ) => {
    let result = initialResult;
    let recoverService = initialRecoverService;
    if (
      result.status === "error" &&
      (params.packageTransaction || params.rollbackBlockedReason) &&
      !rollbackAttempted
    ) {
      rollbackAttempted = true;
      const rollback = await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, () =>
        rollbackFailedUpdate({
          result,
          previousRoot: params.root,
          packageTransaction: params.packageTransaction,
          rollbackBlockedReason: params.rollbackBlockedReason,
          schemaVersions: params.schemaVersions,
          candidateSchemaVersions: params.candidateSchemaVersions,
          previousSchemaVersions: params.previousSchemaVersions,
          previousVerified: params.previousVerified,
          configSnapshot: params.configSnapshot,
          activationConfig: params.activationConfig,
          opts: params.opts,
          preManagedServiceStop: params.preManagedServiceStop,
          timeoutMs: params.updateStepTimeoutMs,
          nodeRunner: params.packageUpdateNodeRunner,
          invocationCwd: params.invocationCwd,
        }),
      );
      result = rollback.result;
      rollbackStopState = rollback.stoppedForRollback;
      rolledBack = rollback.rolledBack;
      pendingRestartAtMs ??= rollbackStopState?.stoppedAtMs;
      if (rollback.verifiedAtMs !== undefined) {
        recordVerifiedDowntime(rollback.verifiedAtMs);
      }
      recoverService = false;
    }
    if (
      result.status === "error" &&
      params.rollbackBlockedReason &&
      !postVerificationRepairAttempted
    ) {
      result = { ...result, reason: params.rollbackBlockedReason };
      recoverService = false;
    } else if (
      result.status === "error" &&
      params.result.status === "ok" &&
      !params.packageTransaction &&
      params.opts.run
    ) {
      recordUpdateRunStep(
        params.opts.run.runId,
        {
          step: "package rollback",
          status: "skipped",
          endedAtMs: Date.now(),
          detail:
            "No retained previous package transaction is available; automatic package restoration was not attempted.",
        },
        { env: params.opts.run.env },
      );
    }
    if (result.status === "error" && !rolledBack && repair) {
      postVerificationRepairAttempted = true;
      const previousRestored = result.recovery?.packageRollbackVerified === true;
      result = await repair(result);
      if (previousRestored && result.status === "ok") {
        // Repair verified the restored release; the requested update still failed.
        rolledBack = true;
        result = { ...result, status: "error", reason: initialResult.reason };
      }
      recoverService = false;
    }
    return { result, recoverService };
  };
  const reportResult = async (
    initialResult: UpdateRunResult,
    initialRecoverService = false,
    initialRestoreFailure?: { cause: unknown },
    notify = true,
  ): Promise<UpdateRunResult> => {
    const { result, recoverService } = await recoverFailedResult(
      initialResult,
      initialRecoverService,
    );
    let restoreFailure = initialRestoreFailure;
    const finalResult = completedResult({
      ...result,
      ...(result.status === "error" && !recoverService && !rolledBack
        ? {
            recovery:
              result.recovery?.serviceRestartSafe === false ||
              result.recovery?.packageRollbackVerified
                ? result.recovery
                : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          }
        : {}),
    });
    if (!restoreFailure) {
      try {
        if (
          !rolledBack &&
          finalResult.status !== "ok" &&
          finalResult.recovery?.serviceRestartSafe !== true
        ) {
          await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(false);
        } else {
          await resumeWindowsAutoStart(finalResult);
        }
      } catch (cause) {
        restoreFailure = { cause };
      }
    }
    if (restoreFailure) {
      rolledBack = false;
      try {
        await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(false);
      } catch (cause) {
        restoreFailure = {
          cause: new AggregateError(
            [restoreFailure.cause, cause],
            `Windows task restoration and compensation failed: ${formatErrorMessage(restoreFailure.cause)}; ${formatErrorMessage(cause)}`,
          ),
        };
      }
      defaultRuntime.error(
        `Failed to restore Windows Scheduled Task autostart: ${String(restoreFailure.cause)}`,
      );
      finalResult.status = "error";
      finalResult.reason =
        result.status === "error" ? result.reason : "windows-task-autostart-restore-failed";
      finalResult.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
      finalResult.steps = [
        ...finalResult.steps,
        {
          name: "Windows task autostart recovery",
          command: "openclaw update",
          cwd: finalResult.root ?? params.root,
          durationMs: 0,
          exitCode: 1,
          stderrTail: formatErrorMessage(restoreFailure.cause),
        },
      ];
    }
    const retireBackup =
      finalResult.status === "ok" || finalResult.recovery?.packageRollbackVerified === true;
    if (params.packageTransaction && !retireBackup) {
      const retained = await params.packageTransaction.complete({ activationVerified: false });
      if (retained) {
        finalResult.steps = [...finalResult.steps, retained];
      }
    }
    if (finalResult.status === "error" && !rolledBack && params.preManagedServiceStop?.stopped) {
      await recordFailedUpdateGatewayState(
        params.opts.run,
        currentServiceStop()?.serviceEnv ?? process.env,
      );
    }
    recordNextAction(finalResult);
    if (notify) {
      await writeControlPlaneUpdateRestartSentinelBestEffort({
        meta: params.controlPlaneUpdateSentinelMeta,
        result: finalResult,
        jsonMode: Boolean(params.opts.json),
      });
    }
    // The recovering Gateway reads this notification at startup. Persist once
    // before restarting; rewriting a consumed sentinel could deliver it twice.
    if (recoverService && finalResult.recovery?.serviceRestartSafe === true) {
      const service = await maybeRestartServiceAfterFailedMutableUpdate({
        recovery: result.recovery,
        preManagedServiceStop: params.preManagedServiceStop,
        jsonMode: Boolean(params.opts.json),
        nodeRunner: params.packageUpdateNodeRunner,
        timeoutMs: params.updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
      });
      if (service) {
        finalResult.recovery = { ...finalResult.recovery, service };
        if (service === "healthy" && params.shouldRestart) {
          gateway = "verify-running";
        }
        if (service === "failed") {
          finalResult.status = "error";
          try {
            await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(false);
          } catch (cause) {
            return await reportResult(finalResult, false, { cause }, false);
          }
        }
      }
    }
    await currentServiceStop()?.windowsTaskAutoStartRecovery?.complete(
      rolledBack ||
        finalResult.status === "ok" ||
        (finalResult.recovery?.serviceRestartSafe === true &&
          finalResult.recovery.service === "healthy"),
    );
    // Only recovery advances the outcome after persistence; ordinary reports share one snapshot.
    const reportedResult = printFinalResult(
      recoverService ? completedResult(finalResult) : finalResult,
    );
    if (retireBackup) {
      await params.packageTransaction
        ?.complete({ activationVerified: finalResult.status === "ok" })
        .catch((error: unknown) => {
          defaultRuntime.error(`Update backup cleanup failed: ${formatErrorMessage(error)}`);
        });
    }
    if (restoreFailure) {
      // Persist the unsafe outcome before unwinding. Keep both failures for
      // recovery diagnostics, with the failed compensation as the primary cause.
      const priorDetail = [result.reason, params.failure?.detail].filter(Boolean).join(": ");
      const detail =
        `${priorDetail ? `${priorDetail}; ` : ""}Windows Scheduled Task autostart recovery failed: ` +
        formatErrorMessage(restoreFailure.cause);
      const cause = params.failure
        ? new AggregateError([params.failure.cause, restoreFailure.cause], detail, {
            cause: restoreFailure.cause,
          })
        : restoreFailure.cause;
      throw createFailure(
        reportedResult,
        resolveManagedServiceUpdateFailureExitCode(reportedResult),
        detail,
        { cause },
      );
    }
    return reportedResult;
  };
  const restoreWindowsAutoStart = async (result: UpdateRunResult) => {
    try {
      await resumeWindowsAutoStart(result);
    } catch (cause) {
      // The attempted restore already failed; reporting must not attempt it again.
      await reportResult(result, false, { cause });
    }
  };

  try {
    if (params.result.status === "error" || params.result.recovery?.serviceRestartSafe === false) {
      const reported = await reportResult(
        { ...params.result, status: "error" },
        params.result.recovery?.serviceRestartSafe === true,
      );
      throw createFailure(
        reported,
        resolveManagedServiceUpdateFailureExitCode(reported),
        params.failure?.detail,
        params.failure,
      );
    }

    if (params.result.status === "skipped") {
      const reported = await reportResult(
        params.result,
        params.result.recovery?.serviceRestartSafe === true,
      );
      throw createFailure(
        reported,
        classifyUpdateOutcome(reported) === "failed"
          ? resolveManagedServiceUpdateFailureExitCode(reported)
          : 0,
      );
    }

    const postUpdateRoot = params.result.root ?? params.root;
    const convergePlugins = async (beforeDoctor?: () => Promise<void>) => {
      const convergence = await convergeUpdatePlugins({ ...params, beforeDoctor });
      if (convergence.resultWithPostUpdate.status === "error") {
        triageAllowed = !convergence.cancelled;
        const reported = await reportResult(convergence.resultWithPostUpdate);
        throw createFailure(
          reported,
          resolveManagedServiceUpdateFailureExitCode(reported),
          convergence.detail,
        );
      }
      return convergence;
    };
    // Plugin install/sync changes shared payloads, config, and the installed index.
    // Start the rehearsed core first; a changed plugin snapshot gets one later restart.
    const deferPluginConvergence =
      params.shouldRestart && params.preManagedServiceStop?.stopped === true;
    let resultWithPostUpdate = params.result;
    let postUpdateConfigSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | undefined;
    if (!deferPluginConvergence) {
      ({ resultWithPostUpdate, postUpdateConfigSnapshot } = await convergePlugins());
    }
    const restartConfigSnapshot =
      postUpdateConfigSnapshot ??
      (await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () =>
        readConfigFileSnapshot({
          skipPluginValidation: true,
          suppressFutureVersionWarning: true,
        }),
      ));
    let restartContext;
    try {
      restartContext = await prepareUpdateRestart(
        { ...params, result: resultWithPostUpdate },
        restartConfigSnapshot,
      );
    } catch (error) {
      const message =
        error instanceof GatewayServiceUpdateOwnershipError
          ? error.message
          : formatErrorMessage(error);
      defaultRuntime.error(message);
      const reported = await reportResult({
        ...resultWithPostUpdate,
        status: "error",
        reason: "service-revalidation-failed",
      });
      throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported), message, {
        cause: error,
      });
    }
    let { restartScriptPath, refreshGatewayServiceEnv, gatewayServiceEnv, serviceUpdateVerdict } =
      restartContext;
    const {
      gatewayServiceInstallEnv,
      skipLegacyServiceRestart,
      serviceStateReadEnv,
      serviceMutationAllowed,
      serviceMutationSkipMessage,
    } = restartContext;
    let { gatewayPort } = restartContext;

    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: buildControlPlaneUpdateRestartHealthPendingResult(resultWithPostUpdate),
      jsonMode: Boolean(params.opts.json),
    });

    await restoreWindowsAutoStart(resultWithPostUpdate);
    let verificationFailure = "restart-unhealthy";
    const restart = async () => {
      const restarted = await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () =>
        maybeRestartService({
          shouldRestart: params.shouldRestart && serviceMutationAllowed,
          result: resultWithPostUpdate,
          opts: params.opts,
          refreshServiceEnv: refreshGatewayServiceEnv,
          serviceUpdateVerdict,
          serviceEnv: gatewayServiceEnv,
          serviceInstallEnv: gatewayServiceInstallEnv,
          gatewayPort,
          restartScriptPath,
          invocationCwd: params.invocationCwd,
          nodeRunner: params.packageUpdateNodeRunner,
          skipLegacyServiceRestart,
          requireRunningServiceAfterRestart: params.preManagedServiceStop?.stopped === true,
          serviceMutationSkipMessage,
          timeoutMs: params.updateStepTimeoutMs,
          onVerificationFailure: (reason) => {
            verificationFailure = reason;
          },
          onVerified: recordVerifiedDowntime,
        }),
      );
      if (restarted === "ok") {
        return;
      }
      triageAllowed = serviceMutationAllowed;
      if (
        restarted === "restart-health-failed" &&
        params.shouldRestart &&
        serviceMutationAllowed &&
        (params.preManagedServiceStop?.running !== false || params.preManagedServiceStop.stopped) &&
        !skipLegacyServiceRestart
      ) {
        gateway = "verify-running";
      }
      const failure: UpdateRunResult = {
        ...resultWithPostUpdate,
        status: "error",
        reason: verificationFailure,
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      };
      const recovered = await recoverFailedResult(
        failure,
        false,
        serviceMutationAllowed && !skipLegacyServiceRestart && !postVerificationRepairAttempted
          ? (result) =>
              repairUpdateService({
                result,
                root: postUpdateRoot,
                env:
                  params.ownedManagedUpdateEnv ??
                  params.opts.run?.env ??
                  gatewayServiceEnv ??
                  serviceStateReadEnv,
                opts: params.opts,
                gatewayPort,
                nodeRunner: params.packageUpdateNodeRunner,
                timeoutMs: params.updateStepTimeoutMs,
                invocationCwd: params.invocationCwd,
                expectedService: rollbackStopState ?? {
                  serviceEnv: gatewayServiceEnv ?? serviceStateReadEnv,
                  serviceUpdateVerdict,
                },
                recoveryStop: currentServiceStop(),
                onVerified: recordVerifiedDowntime,
              })
          : undefined,
      );
      if (recovered.result.status === "ok") {
        resultWithPostUpdate = recovered.result;
      } else {
        // The Gateway may have consumed its sentinel. Update only the existing
        // receipt so a failed repair cannot deliver a duplicate notification.
        await markControlPlaneUpdateRestartSentinelFailureBestEffort({
          meta: params.controlPlaneUpdateSentinelMeta,
          reason: recovered.result.reason ?? verificationFailure,
          jsonMode: Boolean(params.opts.json),
        });
        const reported = await reportResult(recovered.result, false, undefined, false);
        throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported));
      }
    };
    await restart();
    if (deferPluginConvergence) {
      ({ resultWithPostUpdate, postUpdateConfigSnapshot } = await convergePlugins(async () => {
        const before = currentServiceStop();
        if (!before) {
          throw new Error("Plugin maintenance lost its update service owner.");
        }
        await before.windowsTaskAutoStartRecovery?.complete(true);
        // Package work finished online. Full Doctor owns state migrations, so
        // park only now and retain this suspension through verified activation.
        const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
          updateRun: params.opts.run,
          updateInstallKind: resultWithPostUpdate.mode === "git" ? "git" : "package",
          root: postUpdateRoot,
          shouldRestart: true,
          jsonMode: Boolean(params.opts.json),
          expectedService: { serviceEnv: gatewayServiceEnv, serviceUpdateVerdict },
          activatedInstall: params,
          timeoutMs: params.updateStepTimeoutMs,
        });
        before.windowsTaskAutoStartRecovery = stopped.windowsTaskAutoStartRecovery;
        if (stopped.blockMessage || !stopped.stopped) {
          throw new Error(
            stopped.blockMessage ?? "Gateway could not be parked for plugin maintenance.",
          );
        }
        stopped.windowsTaskAutoStartRecovery?.beginMutation();
        pendingRestartAtMs ??= stopped.stoppedAtMs;
      }));
      if (resultWithPostUpdate.postUpdate?.plugins?.changed) {
        // Convergence awaited package managers and plugin hooks. Revalidate the
        // exact native owner again before a changed plugin snapshot is activated.
        const state = await readGatewayServiceState(resolveGatewayService(), {
          env: gatewayServiceEnv ?? serviceStateReadEnv,
          requireEffective: true,
          validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
          timeoutMs: params.updateStepTimeoutMs,
        });
        serviceUpdateVerdict = await revalidateManagedGatewayServiceAfterUpdate({
          state,
          root: postUpdateRoot,
          preManagedServiceStop: {
            serviceEnv: gatewayServiceEnv ?? serviceStateReadEnv,
            serviceUpdateVerdict,
          },
        });
        gatewayServiceEnv = state.env;
        gatewayPort = await resolveUpdatedGatewayRestartPort({
          serviceEnv: state.env,
          serviceCommand: state.command,
        });
        pendingRestartAtMs ??= Date.now();
        restartScriptPath = null;
        refreshGatewayServiceEnv = false;
        await restoreWindowsAutoStart(resultWithPostUpdate);
        await restart();
      }
    }
    // Restart and health verification own recovery of the service stopped for this update.
    // Optional completion refresh must run only after that lifecycle boundary settles.
    try {
      await tryWriteCompletionCache(postUpdateRoot, Boolean(params.opts.json));
    } catch (err) {
      if (!params.opts.json) {
        const completionCacheRefreshCommand = formatCliCommand("openclaw completion --write-state");
        defaultRuntime.log(
          theme.warn(
            `Completion cache update failed: ${formatErrorMessage(err)}. Update will continue; retry with: ${completionCacheRefreshCommand}`,
          ),
        );
      }
    }
    await tryInstallShellCompletion({
      jsonMode: Boolean(params.opts.json),
      skipPrompt: Boolean(params.opts.yes),
    });

    if (params.installKindChanged && resultWithPostUpdate.mode !== "git") {
      const retirement = await retireStandaloneGitWrapper({
        previousRoot: params.previousInstallRoot ?? params.root,
      });
      if (retirement.error) {
        defaultRuntime.error(retirement.error);
        await markControlPlaneUpdateRestartSentinelFailureBestEffort({
          meta: params.controlPlaneUpdateSentinelMeta,
          reason: "wrapper-retirement-failed",
          jsonMode: Boolean(params.opts.json),
        });
        const reported = await reportResult(
          {
            ...resultWithPostUpdate,
            status: "error",
            reason: "wrapper-retirement-failed",
          },
          false,
          undefined,
          false,
        );
        throw createFailure(reported, 1, retirement.error);
      }
    }

    return await reportResult(resultWithPostUpdate);
  } catch (error) {
    if (error instanceof UpdateCommandFailure) {
      throw error;
    }
    const message = formatErrorMessage(error);
    defaultRuntime.error(`Post-update verification failed: ${message}`);
    const reported = await reportResult({
      ...params.result,
      status: "error",
      reason: "post-update-failed",
      steps: [
        ...params.result.steps,
        {
          name: "post-update verification",
          command: "openclaw update",
          cwd: params.result.root ?? params.root,
          durationMs: Math.max(0, Date.now() - params.startedAt),
          exitCode: 1,
          stderrTail: message,
        },
      ],
    });
    throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported), message, {
      cause: error,
    });
  }
}
