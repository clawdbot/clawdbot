import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveManagedGatewayServiceProcessEnv } from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  readControlPlaneUpdateSentinelMeta,
} from "../../infra/update-control-plane-sentinel.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../../runtime.js";
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
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  shouldResumePostCoreUpdateInFreshProcess,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-post-core.js";
import { POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON } from "./update-command-post-plugin-validation.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  GatewayServiceUpdateOwnershipError,
  isGatewayServiceManagementAllowedForUpdate,
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  resolveGatewayServiceManagementBlockMessageForUpdate,
  resolvePostUpdateServiceStateReadEnv,
  resolveUpdatedGatewayRestartPort,
  restoreWindowsTaskAutoStartOrExit,
  shouldPrepareUpdatedInstallRestart,
  stripGatewayServiceMarkerEnv,
  tryInstallShellCompletion,
  type PreManagedServiceStop,
} from "./update-command-service.js";

const CLI_NAME = resolveCliName();

const UPDATE_QUIPS = [
  "Leveled up! New skills unlocked. You're welcome.",
  "Fresh code, same lobster. Miss me?",
  "Back and better. Did you even notice I was gone?",
  "Update complete. I learned some new tricks while I was out.",
  "Upgraded! Now with 23% more sass.",
  "I've evolved. Try to keep up.",
  "New version, who dis? Oh right, still me but shinier.",
  "Patched, polished, and ready to pinch. Let's go.",
  "The lobster has molted. Harder shell, sharper claws.",
  "Update done! Check the changelog or just trust me, it's good.",
  "Reborn from the boiling waters of npm. Stronger now.",
  "I went away and came back smarter. You should try it sometime.",
  "Update complete. The bugs feared me, so they left.",
  "New version installed. Old version sends its regards.",
  "Firmware fresh. Brain wrinkles: increased.",
  "I've seen things you wouldn't believe. Anyway, I'm updated.",
  "Back online. The changelog is long but our friendship is longer.",
  "Upgraded! Peter fixed stuff. Blame him if it breaks.",
  "Molting complete. Please don't look at my soft shell phase.",
  "Version bump! Same chaos energy, fewer crashes (probably).",
];

function pickUpdateQuip(): string {
  return UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ?? "Update complete.";
}

export async function finishUpdate(params: {
  result: UpdateRunResult;
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
  if (params.result.status !== "ok") {
    printResult(params.result, { ...params.opts, hideSteps: params.showProgress });
  }

  if (params.result.status === "error") {
    if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
      return;
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: params.result,
      jsonMode: Boolean(params.opts.json),
    });
    if (params.result.recovery?.serviceRestartSafe === false) {
      if (!params.opts.json) {
        defaultRuntime.log(
          theme.warn(
            `Managed gateway remains stopped because update recovery could not prove a runnable installation (${params.result.recovery.reason}).`,
          ),
        );
      }
    } else {
      await maybeRestartServiceAfterFailedMutableUpdate({
        root: params.result.root,
        preManagedServiceStop: params.preManagedServiceStop,
        jsonMode: Boolean(params.opts.json),
      });
    }
    defaultRuntime.exit(1);
    return;
  }

  if (params.result.status === "skipped") {
    if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
      return;
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: params.result,
      jsonMode: Boolean(params.opts.json),
    });
    await maybeRestartServiceAfterFailedMutableUpdate({
      root: params.result.root,
      preManagedServiceStop: params.preManagedServiceStop,
      jsonMode: Boolean(params.opts.json),
    });
    if (params.result.reason === "dirty") {
      defaultRuntime.error(theme.error("Update blocked: local files are edited in this checkout."));
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
    defaultRuntime.exit(params.result.reason === "dirty" ? 1 : 0);
    return;
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
      if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
        return;
      }
      defaultRuntime.exit(freshProcessResult.exitCode);
      throw new Error(`post-update process exited with code ${freshProcessResult.exitCode}`);
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
            versionComparison != null && versionComparison > 0 ? postUpdateInstalledVersion : null;
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
            opts: params.opts,
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
          ...(params.packageUpdateNodeRunner ? { nodeRunner: params.packageUpdateNodeRunner } : {}),
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
    if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
      return;
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: resultWithPostUpdate,
      jsonMode: Boolean(params.opts.json),
    });
    // If strict config became valid despite a fresh-doctor process failure, restore the service
    // stopped by this update. Invalid post-migration config intentionally remains stopped.
    if (postCorePluginUpdate.reason === POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON) {
      await maybeRestartServiceAfterFailedMutableUpdate({
        root: params.result.root,
        preManagedServiceStop: params.preManagedServiceStop,
        jsonMode: Boolean(params.opts.json),
      });
    }
    printResult(resultWithPostUpdate, { ...params.opts, hideSteps: params.showProgress });
    defaultRuntime.exit(1);
    return;
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
  const serviceStateReadEnv = resolvePostUpdateServiceStateReadEnv({
    updateMode: resultWithPostUpdate.mode,
    processEnv: process.env,
    preManagedServiceEnv: params.preManagedServiceStop?.serviceEnv,
  });
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
        defaultRuntime.exit(1);
        return;
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

  if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
    return;
  }
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
    await markControlPlaneUpdateRestartSentinelFailureBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      reason: "restart-unhealthy",
      jsonMode: Boolean(params.opts.json),
    });
    defaultRuntime.exit(1);
    return;
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
      const failedResult: UpdateRunResult = {
        ...resultWithPostUpdate,
        status: "error",
        reason: "wrapper-retirement-failed",
      };
      printResult(failedResult, { ...params.opts, hideSteps: params.showProgress });
      defaultRuntime.exit(1);
      return;
    }
  }

  await writeControlPlaneUpdateRestartSentinelBestEffort({
    meta: params.controlPlaneUpdateSentinelMeta,
    result: resultWithPostUpdate,
    jsonMode: Boolean(params.opts.json),
  });

  printResult(resultWithPostUpdate, { ...params.opts, hideSteps: params.showProgress });
  if (!params.opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  }
}
