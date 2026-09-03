import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveManagedGatewayServiceProcessEnv } from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  readControlPlaneUpdateSentinelMeta,
  resolveManagedServiceUpdateFailureExitCode,
} from "../../infra/update-control-plane-sentinel.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import { VERSION } from "../../version.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { printResult } from "./progress.js";
import { prepareRestartScript } from "./restart-helper.js";
import {
  readPackageVersion,
  tryWriteCompletionCache,
  type UpdateCommandOptions,
} from "./shared.js";
import {
  persistRequestedUpdateChannel,
  restoreDroppedPreUpdateChannels,
} from "./update-command-config.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  didCoreUpdateChangeInstall,
  shouldResumePostCoreUpdateInFreshProcess,
} from "./update-command-post-core.js";
import {
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  UpdateCommandFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import {
  resolveServiceRefreshEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  GatewayServiceUpdateOwnershipError,
  isGatewayServiceManagementAllowedForUpdate,
  resolveGatewayServiceManagementBlockMessageForUpdate,
} from "./update-command-service-plan.js";
import {
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  resolvePostUpdateServiceStateReadEnv,
  resolveUpdatedGatewayRestartPort,
  shouldPrepareUpdatedInstallRestart,
  tryInstallShellCompletion,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import { resolveUnsafeUpdateRecoveryGuidance } from "./update-recovery-guidance.js";

const CLI_NAME = resolveCliName();

export async function finishUpdate(params: {
  result: UpdateRunResult;
  failure?: { cause: unknown; detail: string };
  root: string;
  previousInstallRoot?: string;
  installKindChanged: boolean;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  channel: UpdateChannel;
  downgradeRisk: boolean;
  shouldRestart: boolean;
  opts: UpdateCommandOptions;
  showProgress: boolean;
  preManagedServiceStop?: PreManagedServiceStop;
  ownedManagedUpdateEnv?: NodeJS.ProcessEnv;
  controlPlaneUpdateSentinelMeta: Awaited<ReturnType<typeof readControlPlaneUpdateSentinelMeta>>;
  preUpdatePluginInstallRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  startedAt: number;
  packageUpdateNodeRunner?: string;
  updateStepTimeoutMs: number;
  invocationCwd?: string;
}): Promise<void> {
  // Finalization owns the complete outcome, including recovery, restart, and completion work.
  const completedResult = (result: UpdateRunResult): UpdateRunResult => ({
    ...result,
    durationMs: Math.max(0, Date.now() - params.startedAt),
  });
  const printFinalResult = (result: UpdateRunResult) => {
    printResult(result, { ...params.opts, hideSteps: params.showProgress });
    if (result.status === "error" && !params.opts.json) {
      const reason =
        result.recovery?.serviceRestartSafe === false ? result.recovery.reason : undefined;
      defaultRuntime.log(theme.muted(resolveUnsafeUpdateRecoveryGuidance(reason)));
    }
    return result;
  };
  const reportResult = async (
    result: UpdateRunResult,
    recoverService = false,
    initialRestoreFailure?: { cause: unknown },
  ) => {
    let restoreFailure = initialRestoreFailure;
    const finalResult = completedResult({
      ...result,
      ...(result.status === "error" && !recoverService
        ? {
            recovery:
              result.recovery?.serviceRestartSafe === false
                ? result.recovery
                : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          }
        : {}),
    });
    if (!restoreFailure) {
      try {
        if (finalResult.status !== "ok" && finalResult.recovery?.serviceRestartSafe !== true) {
          params.preManagedServiceStop?.windowsTaskAutoStartRecovery?.complete(false);
        } else {
          await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
            params.preManagedServiceStop,
            true,
          );
        }
      } catch (cause) {
        restoreFailure = { cause };
      }
    }
    if (restoreFailure) {
      defaultRuntime.error(
        `Failed to restore Windows Scheduled Task autostart: ${String(restoreFailure.cause)}`,
      );
      finalResult.status = "error";
      finalResult.reason = "windows-task-autostart-restore-failed";
      finalResult.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
      params.preManagedServiceStop?.windowsTaskAutoStartRecovery?.complete(false);
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: finalResult,
      jsonMode: Boolean(params.opts.json),
    });
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
        if (service === "failed") {
          finalResult.status = "error";
        }
      }
    }
    // Only recovery advances the outcome after persistence; ordinary reports share one snapshot.
    const reportedResult = recoverService ? completedResult(finalResult) : finalResult;
    printFinalResult(reportedResult);
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
      throw new UpdateCommandFailure(
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
      await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(params.preManagedServiceStop, true);
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
      if (params.result.recovery?.serviceRestartSafe !== true) {
        const recoveryReason = params.result.recovery?.reason ?? "runtime-verification-failed";
        if (!params.opts.json) {
          const managedGatewayStopped = params.preManagedServiceStop?.stopped === true;
          defaultRuntime.log(
            theme.warn(
              managedGatewayStopped
                ? `Managed gateway remains stopped because update recovery could not prove a runnable installation (${recoveryReason}).`
                : `Update recovery could not prove a runnable installation (${recoveryReason}).`,
            ),
          );
          if (managedGatewayStopped) {
            defaultRuntime.log(theme.muted("Keep the gateway stopped until the update succeeds."));
          }
        }
      }
      throw new UpdateCommandFailure(
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
      if (params.result.reason === "dirty") {
        defaultRuntime.error(
          theme.error("Update blocked: local files are edited in this checkout."),
        );
        defaultRuntime.log(
          theme.warn(
            "Git-based updates need a clean working tree before they can switch commits, fetch, or rebase.",
          ),
        );
        defaultRuntime.log(
          theme.muted("Commit, stash, or discard the local changes, then rerun `openclaw update`."),
        );
      }
      if (params.result.reason === "not-git-install") {
        defaultRuntime.log(
          theme.warn(
            `Skipped: this OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\` and \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\`.`,
          ),
        );
        defaultRuntime.log(
          theme.muted(
            `Examples: \`${replaceCliName("npm i -g openclaw@latest", CLI_NAME)}\` or \`${replaceCliName("pnpm add -g openclaw@latest", CLI_NAME)}\``,
          ),
        );
      }
      throw new UpdateCommandFailure(
        reported,
        classifyUpdateOutcome(reported) === "failed"
          ? resolveManagedServiceUpdateFailureExitCode(reported)
          : 0,
      );
    }

    const shouldResumePostCoreInFreshProcess = shouldResumePostCoreUpdateInFreshProcess({
      result: params.result,
      downgradeRisk: params.downgradeRisk,
      installKindChanged: params.installKindChanged,
    });

    let postUpdateConfigSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | undefined;
    if (
      params.requestedChannel &&
      params.configSnapshot.valid &&
      params.requestedChannel !== params.storedChannel &&
      !shouldResumePostCoreInFreshProcess &&
      !params.opts.json
    ) {
      defaultRuntime.log(theme.muted(`Update channel set to ${params.requestedChannel}.`));
    } else if (
      params.requestedChannel &&
      params.configSnapshot.valid &&
      params.requestedChannel !== params.storedChannel &&
      shouldResumePostCoreInFreshProcess &&
      !params.opts.json
    ) {
      defaultRuntime.log(theme.muted(`Update channel will be set to ${params.requestedChannel}.`));
    }

    const postUpdateRoot = params.result.root ?? params.root;

    let postCorePluginUpdate;
    let pluginsUpdatedInFreshProcess = false;
    if (shouldResumePostCoreInFreshProcess) {
      const freshProcessResult = await withOwnedManagedUpdateEnv(
        params.ownedManagedUpdateEnv,
        async () =>
          await continuePostCoreUpdateInFreshProcess({
            root: postUpdateRoot,
            channel: params.channel,
            requestedChannel: params.requestedChannel,
            opts: params.opts,
            pluginInstallRecords: params.preUpdatePluginInstallRecords,
            updateStartedAtMs: params.startedAt,
            timeoutMs: params.updateStepTimeoutMs,
            nodeRunner: params.packageUpdateNodeRunner,
            preUpdateConfig: params.configSnapshot.valid
              ? {
                  sourceConfig: params.configSnapshot.sourceConfig,
                  authoredConfig: isRecord(params.configSnapshot.parsed)
                    ? (params.configSnapshot.parsed as OpenClawConfig)
                    : params.configSnapshot.sourceConfig,
                }
              : undefined,
          }),
      );
      if (freshProcessResult.exitCode !== undefined) {
        const reported = await reportResult({
          ...params.result,
          status: "error",
          reason: "post-core-update-failed",
        });
        // A nested child status cannot authorize recovery. Only the final
        // owner may emit the unsafe recovery code.
        throw new UpdateCommandFailure(
          reported,
          resolveManagedServiceUpdateFailureExitCode(reported),
          freshProcessResult.error,
        );
      }
      pluginsUpdatedInFreshProcess = freshProcessResult.resumed;
      postCorePluginUpdate = freshProcessResult.pluginUpdate;
    }

    if (!pluginsUpdatedInFreshProcess) {
      await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () => {
        const previousCompatibilityHostVersion = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
        let compatibilityDowngradeTarget: string | null = null;
        try {
          const initialPluginUpdate = await withPluginLifecycleLease({}, async () => {
            postUpdateConfigSnapshot = await readConfigFileSnapshot({
              skipPluginValidation: true,
              suppressFutureVersionWarning: shouldResumePostCoreInFreshProcess,
            });
            postUpdateConfigSnapshot = await persistRequestedUpdateChannel({
              configSnapshot: postUpdateConfigSnapshot,
              requestedChannel: params.requestedChannel,
            });
            const restoredConfig = restoreDroppedPreUpdateChannels(
              postUpdateConfigSnapshot,
              params.configSnapshot.valid
                ? {
                    sourceConfig: params.configSnapshot.sourceConfig,
                    authoredConfig: isRecord(params.configSnapshot.parsed)
                      ? (params.configSnapshot.parsed as OpenClawConfig)
                      : params.configSnapshot.sourceConfig,
                  }
                : undefined,
            );
            postUpdateConfigSnapshot = restoredConfig.snapshot;
            // Current-process post-core convergence still reports the pre-update
            // VERSION. During downgrades, pin compatibility checks to the installed
            // target so incompatible newer plugins are disabled before restart.
            const postUpdateInstalledVersion = await readPackageVersion(postUpdateRoot);
            const versionComparison =
              postUpdateInstalledVersion && VERSION
                ? compareSemverStrings(VERSION, postUpdateInstalledVersion)
                : null;
            compatibilityDowngradeTarget =
              versionComparison != null && versionComparison > 0
                ? postUpdateInstalledVersion
                : null;
            if (compatibilityDowngradeTarget) {
              process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = compatibilityDowngradeTarget;
            }
            const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
            return await updatePluginsAfterCoreUpdate({
              root: postUpdateRoot,
              channel: params.channel,
              configSnapshot: postUpdateConfigSnapshot,
              configChanged: restoredConfig.changed,
              restoredAuthoredChannels: restoredConfig.authoredChannels,
              json: params.opts.json,
              acceptCapabilities: params.opts.acceptCapabilities,
              timeoutMs: params.updateStepTimeoutMs,
              pluginInstallRecords,
            });
          });
          // Fresh doctor acquires this same cross-process lease; completion must run after release.
          const completedPluginUpdate = await completePostCorePluginUpdate({
            root: postUpdateRoot,
            pluginUpdate: initialPluginUpdate,
            // Aggregate plugin changes and core install changes independently require fresh doctor.
            freshDoctorRequired:
              didCoreUpdateChangeInstall(params.result) || initialPluginUpdate.changed,
            yes: params.opts.yes === true,
            json: params.opts.json === true,
            timeoutMs: params.updateStepTimeoutMs,
            ...(params.packageUpdateNodeRunner
              ? { nodeRunner: params.packageUpdateNodeRunner }
              : {}),
          });
          postCorePluginUpdate = completedPluginUpdate.pluginUpdate;
          postUpdateConfigSnapshot = completedPluginUpdate.configSnapshot;
        } finally {
          if (compatibilityDowngradeTarget) {
            if (previousCompatibilityHostVersion === undefined) {
              delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
            } else {
              process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = previousCompatibilityHostVersion;
            }
          }
        }
      });
    }

    const resultWithPostUpdate: UpdateRunResult = postCorePluginUpdate
      ? {
          ...params.result,
          status: postCorePluginUpdate.status === "error" ? "error" : params.result.status,
          ...(postCorePluginUpdate.status === "error" ? { reason: "post-update-plugins" } : {}),
          postUpdate: {
            ...params.result.postUpdate,
            plugins: postCorePluginUpdate,
          },
        }
      : params.result;

    if (postCorePluginUpdate?.status === "error") {
      // Post-core validation can mutate config and state. Only its complete success
      // permits activation; a healthy-looking config cannot override Doctor failure.
      const reported = await reportResult(resultWithPostUpdate);
      throw new UpdateCommandFailure(
        reported,
        resolveManagedServiceUpdateFailureExitCode(reported),
      );
    }

    const restartConfigSnapshot =
      postUpdateConfigSnapshot ??
      (await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () =>
        readConfigFileSnapshot({
          skipPluginValidation: true,
          suppressFutureVersionWarning: shouldResumePostCoreInFreshProcess,
        }),
      ));
    let restartScriptPath: string | null = null;
    let refreshGatewayServiceEnv = false;
    let gatewayServiceEnv: NodeJS.ProcessEnv | undefined;
    let gatewayServiceInstallEnv: NodeJS.ProcessEnv | null | undefined;
    let serviceUpdateVerdict = params.preManagedServiceStop?.serviceUpdateVerdict;
    let skipLegacyServiceRestart = serviceUpdateVerdict?.kind === "absent";
    const serviceStateReadEnv = resolveServiceRefreshEnv(
      resolvePostUpdateServiceStateReadEnv({
        updateMode: resultWithPostUpdate.mode,
        processEnv: process.env,
        preManagedServiceEnv: params.preManagedServiceStop?.serviceEnv,
      }),
      params.invocationCwd,
    );
    let serviceMutationAllowed =
      params.preManagedServiceStop?.serviceMutationAllowed !== false &&
      isGatewayServiceManagementAllowedForUpdate(process.env) &&
      isGatewayServiceManagementAllowedForUpdate(serviceStateReadEnv);
    let serviceMutationSkipMessage = !serviceMutationAllowed
      ? (params.preManagedServiceStop?.serviceMutationSkipMessage ??
        resolveGatewayServiceManagementBlockMessageForUpdate(process.env) ??
        resolveGatewayServiceManagementBlockMessageForUpdate(serviceStateReadEnv))
      : undefined;
    let gatewayPort = await resolveUpdatedGatewayRestartPort({
      config: restartConfigSnapshot.valid ? restartConfigSnapshot.config : undefined,
      processEnv: process.env,
      serviceEnv: params.ownedManagedUpdateEnv,
    });
    if (params.shouldRestart && serviceMutationAllowed && !skipLegacyServiceRestart) {
      try {
        const serviceState = await readGatewayServiceState(resolveGatewayService(), {
          env: serviceStateReadEnv,
          requireEffective: true,
          validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
          timeoutMs: params.updateStepTimeoutMs,
        });
        serviceUpdateVerdict = await revalidateManagedGatewayServiceAfterUpdate({
          state: serviceState,
          root: postUpdateRoot,
          preManagedServiceStop: params.preManagedServiceStop,
          allowInstallRootChange: true,
        });
        gatewayServiceEnv = serviceState.env;
        skipLegacyServiceRestart =
          serviceUpdateVerdict.kind === "foreign" || serviceUpdateVerdict.kind === "absent";
        if (serviceUpdateVerdict.kind === "unavailable") {
          serviceMutationAllowed = false;
          serviceMutationSkipMessage = serviceUpdateVerdict.message;
        } else if (serviceUpdateVerdict.kind === "foreign") {
          serviceMutationAllowed = false;
          serviceMutationSkipMessage =
            "Gateway service management skipped: the service belongs to a different OpenClaw installation and was left untouched.";
        } else if (
          !skipLegacyServiceRestart &&
          shouldPrepareUpdatedInstallRestart({
            updateMode: resultWithPostUpdate.mode,
            serviceInstalled: serviceState.installed,
            serviceLoaded: serviceState.loadState.status === "loaded",
            serviceStoppedForUpdate: params.preManagedServiceStop?.stopped,
            serviceMatchesUpdateRoot: serviceUpdateVerdict.kind === "owned",
            requiresInstallRootRefresh:
              serviceUpdateVerdict.kind === "owned" &&
              serviceUpdateVerdict.requiresInstallRootRefresh,
          })
        ) {
          gatewayServiceInstallEnv = resolveManagedGatewayServiceProcessEnv(
            serviceState.command,
            params.ownedManagedUpdateEnv ?? process.env,
          );
          if (gatewayServiceInstallEnv) {
            gatewayServiceInstallEnv = stripGatewayServiceMarkerEnv(gatewayServiceInstallEnv);
          }
          refreshGatewayServiceEnv =
            serviceUpdateVerdict.kind === "owned" && serviceUpdateVerdict.refreshDefinition;
          if (serviceUpdateVerdict.kind === "owned" && gatewayServiceInstallEnv === null) {
            refreshGatewayServiceEnv = false;
            serviceUpdateVerdict = { ...serviceUpdateVerdict, refreshDefinition: false };
          }
        }
        gatewayPort = await resolveUpdatedGatewayRestartPort({
          config: restartConfigSnapshot.valid ? restartConfigSnapshot.config : undefined,
          serviceEnv: gatewayServiceEnv,
          serviceCommand:
            serviceUpdateVerdict.kind === "unresolved" ||
            (serviceUpdateVerdict.kind === "owned" && !serviceUpdateVerdict.refreshDefinition)
              ? serviceState.command
              : undefined,
        });
        if (refreshGatewayServiceEnv) {
          restartScriptPath = await prepareRestartScript(
            serviceState.env,
            gatewayPort,
            serviceState.command?.programArguments,
          );
        }
      } catch (err) {
        if (params.preManagedServiceStop?.stopped) {
          const message =
            err instanceof GatewayServiceUpdateOwnershipError
              ? formatErrorMessage(err)
              : "Stopped gateway service could not be revalidated; inspect it before restarting manually.";
          defaultRuntime.error(message);
          const reported = await reportResult({
            ...resultWithPostUpdate,
            status: "error",
            reason: "service-revalidation-failed",
          });
          throw new UpdateCommandFailure(
            reported,
            resolveManagedServiceUpdateFailureExitCode(reported),
            message,
            { cause: err },
          );
        }
        serviceMutationAllowed = false;
        serviceMutationSkipMessage =
          "Code update completed; gateway service management skipped because its current ownership could not be inspected. " +
          "Run `openclaw gateway status --deep` before restarting it manually.";
      }
    }

    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: buildControlPlaneUpdateRestartHealthPendingResult(resultWithPostUpdate),
      jsonMode: Boolean(params.opts.json),
    });

    await restoreWindowsAutoStart(resultWithPostUpdate);
    const restartOk = await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () =>
      maybeRestartService({
        shouldRestart: params.shouldRestart && serviceMutationAllowed,
        result: resultWithPostUpdate,
        channel: params.channel,
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
      }),
    );
    if (!restartOk) {
      // The Gateway may already have consumed the notification. Mark only an
      // existing sentinel; recreating it would deliver the update twice.
      await markControlPlaneUpdateRestartSentinelFailureBestEffort({
        meta: params.controlPlaneUpdateSentinelMeta,
        reason: "restart-unhealthy",
        jsonMode: Boolean(params.opts.json),
      });
      const reported = printFinalResult(
        completedResult({
          ...resultWithPostUpdate,
          status: "error",
          reason: "restart-unhealthy",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        }),
      );
      throw new UpdateCommandFailure(
        reported,
        resolveManagedServiceUpdateFailureExitCode(reported),
      );
    }

    // Restart and health verification own recovery of the service stopped for this update.
    // Optional completion refresh must run only after that lifecycle boundary settles.
    try {
      await tryWriteCompletionCache(postUpdateRoot, Boolean(params.opts.json));
    } catch (err) {
      if (!params.opts.json) {
        const completionCacheRefreshCommand = replaceCliName(
          formatCliCommand("openclaw completion --write-state"),
          CLI_NAME,
        );
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
        const reported = printFinalResult(
          completedResult({
            ...resultWithPostUpdate,
            status: "error",
            reason: "wrapper-retirement-failed",
          }),
        );
        throw new UpdateCommandFailure(reported, 1, retirement.error);
      }
    }

    await reportResult(resultWithPostUpdate);
    if (!params.opts.json) {
      const recoveryEnv = params.ownedManagedUpdateEnv ?? process.env;
      defaultRuntime.log(
        theme.muted(
          `After verifying your history, preview recovery rollback retirement with ${formatCliCommand("openclaw update cleanup --dry-run", recoveryEnv)} for state ${resolveStateDir(recoveryEnv)}. Keep the same state/config overrides.`,
        ),
      );
    }
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
    throw new UpdateCommandFailure(
      reported,
      resolveManagedServiceUpdateFailureExitCode(reported),
      message,
      { cause: error },
    );
  }
}
