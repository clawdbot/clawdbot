// Managed gateway service lifecycle before and after an update.
import { confirm, isCancel } from "@clack/prompts";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import { runDaemonRestart } from "../daemon-cli.js";
import {
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
} from "../daemon-cli/restart-health.js";
import { runRestartScript } from "./restart-helper.js";
import type { UpdateCommandOptions } from "./shared.js";
import { createUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import {
  DEFINITION_DENIAL,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";
import {
  revalidateManagedGatewayServiceAfterUpdate,
  resolveUpdatedGatewayRestartPort,
  type ManagedGatewayUpdateVerdict,
} from "./update-command-service-maintenance.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  gatewayServiceCommandUsesRoot,
  resolveGatewayServiceManagementBlockMessageForUpdate,
} from "./update-command-service-plan.js";
import {
  formatPostUpdateGatewayRecoveryInstructions,
  hasLoadedLaunchdKeepAliveSupervisor,
  isPackageManagerUpdateMode,
  recoverLaunchAgentAndRecheckGatewayHealth,
  shouldUseLegacyProcessRestartAfterUpdate,
} from "./update-command-service-recovery.js";

export {
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  resolvePreparedGatewayUpdatePolicy,
  resolveUpdatedGatewayRestartPort,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service-maintenance.js";

const CLI_NAME = resolveCliName();
const POST_REFRESH_ALREADY_HEALTHY_ATTEMPTS = 10;
const POST_REFRESH_ALREADY_HEALTHY_DELAY_MS = 500;

export function shouldPrepareUpdatedInstallRestart(params: {
  updateMode: UpdateRunResult["mode"];
  serviceInstalled: boolean;
  serviceLoaded: boolean;
  serviceStoppedForUpdate?: boolean;
  serviceMatchesUpdateRoot?: boolean;
  requiresInstallRootRefresh?: boolean;
}): boolean {
  const useInstalledState =
    params.requiresInstallRootRefresh === true ||
    isPackageManagerUpdateMode(params.updateMode) ||
    (params.updateMode === "git" && params.serviceStoppedForUpdate);
  return useInstalledState
    ? params.serviceInstalled
    : params.serviceLoaded &&
        (params.updateMode !== "git" || params.serviceMatchesUpdateRoot === true);
}

export function resolvePostUpdateServiceStateReadEnv(params: {
  updateMode: UpdateRunResult["mode"];
  processEnv?: NodeJS.ProcessEnv;
  preManagedServiceEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const fallbackEnv = params.processEnv ?? process.env;
  const usesServiceEnv =
    params.updateMode === "git" || isPackageManagerUpdateMode(params.updateMode);
  return usesServiceEnv ? (params.preManagedServiceEnv ?? fallbackEnv) : fallbackEnv;
}

export async function tryInstallShellCompletion(opts: {
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  try {
    const status = await checkShellCompletionStatus(CLI_NAME);
    const generationOptions = { generationMode: "core-only" } as const;

    if (status.usesSlowPattern) {
      defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      await installCompletion(status.shell, true, CLI_NAME);
      return;
    }

    if (status.profileInstalled && !status.cacheExists) {
      defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      return;
    }

    if (!status.profileInstalled && !opts.skipPrompt) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Shell completion"));

      const shouldInstall = await confirm({
        message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
        initialValue: true,
      });

      if (isCancel(shouldInstall) || !shouldInstall) {
        defaultRuntime.log(
          theme.muted(
            `Skipped. Run \`${replaceCliName(formatCliCommand("openclaw completion --install"), CLI_NAME)}\` later to enable.`,
          ),
        );
        return;
      }

      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      await installCompletion(status.shell, false, CLI_NAME);
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    defaultRuntime.log(
      theme.warn(
        `Shell completion refresh failed: ${message}. Update will continue; retry with: ${replaceCliName(formatCliCommand("openclaw completion --write-state --install"), CLI_NAME)}`,
      ),
    );
  }
}

export async function maybeRestartService(params: {
  shouldRestart: boolean;
  result: UpdateRunResult;
  channel: UpdateChannel;
  opts: UpdateCommandOptions;
  refreshServiceEnv: boolean;
  serviceEnv?: NodeJS.ProcessEnv;
  serviceInstallEnv?: NodeJS.ProcessEnv | null;
  serviceUpdateVerdict?: ManagedGatewayUpdateVerdict;
  gatewayPort: number;
  restartScriptPath?: string | null;
  invocationCwd?: string;
  nodeRunner?: string;
  skipLegacyServiceRestart?: boolean;
  requireRunningServiceAfterRestart?: boolean;
  serviceMutationSkipMessage?: string;
  timeoutMs: number;
}): Promise<boolean> {
  const invocationEnv = resolveServiceRefreshEnv(process.env, params.invocationCwd);
  const serviceEnv = resolveServiceRefreshEnv(
    params.serviceEnv ?? invocationEnv,
    params.invocationCwd,
  );
  if (params.shouldRestart) {
    const message =
      resolveGatewayServiceManagementBlockMessageForUpdate(invocationEnv) ??
      resolveGatewayServiceManagementBlockMessageForUpdate(serviceEnv);
    if (message) {
      defaultRuntime.error(message);
      return false;
    }
  }
  let activation = { ...params, invocationEnv, serviceEnv };
  const verdict = activation.serviceUpdateVerdict;
  let preserveDefinition =
    verdict?.kind === "unresolved" || (verdict?.kind === "owned" && !verdict.refreshDefinition);
  const requiresInstallRootRefresh =
    verdict?.kind === "owned" && verdict.requiresInstallRootRefresh;
  const isPackageUpdate = isPackageManagerUpdateMode(activation.result.mode);
  const requiresVerifiedRestart = () =>
    preserveDefinition || isPackageUpdate || activation.requireRunningServiceAfterRestart;
  const canRestartUpdatedInstall = () =>
    preserveDefinition ||
    (isPackageUpdate &&
      (activation.refreshServiceEnv ||
        activation.serviceInstallEnv === null ||
        activation.requireRunningServiceAfterRestart));
  if (preserveDefinition) {
    defaultRuntime.error(
      "Gateway service definition left unchanged; ask its deployment owner to repair stale metadata if needed.",
    );
  }
  if (activation.serviceMutationSkipMessage) {
    defaultRuntime.error(activation.serviceMutationSkipMessage);
    return true;
  }
  const verifyRestartedGateway = async (
    expectedGatewayVersion: string | undefined,
    expectedGatewayBuildId: string | undefined,
    opts: { requireRunningService?: boolean } = {},
  ) => {
    const service = resolveGatewayService();
    const waitForHealthy = async () =>
      await waitForGatewayHealthyRestart({
        service,
        port: activation.gatewayPort,
        expectedVersion: expectedGatewayVersion,
        ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
        env: activation.serviceEnv,
        requireRunningService: opts.requireRunningService,
        supervisorKeepsAlive: await hasLoadedLaunchdKeepAliveSupervisor({
          service,
          env: activation.serviceEnv,
        }),
      });
    let health = await waitForHealthy();
    if (!health.healthy && health.staleGatewayPids.length > 0) {
      if (!activation.opts.json) {
        defaultRuntime.log(
          theme.warn(
            `Found stale gateway process(es) after restart: ${health.staleGatewayPids.join(", ")}. Cleaning up...`,
          ),
        );
      }
      await terminateStaleGatewayPids(health.staleGatewayPids);
      if (canRestartUpdatedInstall()) {
        await runUpdatedInstallGatewayCommand(activation, "restart", preserveDefinition);
      } else if (shouldUseLegacyProcessRestartAfterUpdate({ updateMode: activation.result.mode })) {
        await runDaemonRestart();
      }
      health = await waitForHealthy();
    }

    const recoveryVerification = await recoverLaunchAgentAndRecheckGatewayHealth({
      preserveDefinition,
      health,
      service,
      port: activation.gatewayPort,
      expectedVersion: expectedGatewayVersion,
      ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
      env: activation.serviceEnv,
    });
    health = recoveryVerification.health;
    const launchAgentRecovery = recoveryVerification.launchAgentRecovery;
    if (launchAgentRecovery?.attempted) {
      defaultRuntime.error(
        launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
      );
    }

    const serviceRuntimeHealthy =
      !opts.requireRunningService || health.runtime.status === "running";
    if (health.healthy && serviceRuntimeHealthy) {
      if (!activation.opts.json) {
        defaultRuntime.log(theme.success("Gateway: restarted and verified."));
      }
      return true;
    }

    const diagnosticLines = [
      "Gateway did not become healthy after restart.",
      ...(health.healthy && opts.requireRunningService
        ? ["Gateway responded, but the managed service did not report running after restart."]
        : []),
      ...renderRestartDiagnostics(health),
      ...(launchAgentRecovery?.attempted
        ? [
            launchAgentRecovery.recovered
              ? `LaunchAgent recovery: ${launchAgentRecovery.message}`
              : `LaunchAgent recovery failed: ${launchAgentRecovery.detail}`,
          ]
        : []),
      `Restart log: ${resolveGatewayRestartLogPath(activation.serviceEnv ?? process.env)}`,
      `Run \`${replaceCliName(formatCliCommand("openclaw gateway status --deep"), CLI_NAME)}\` for details.`,
      ...formatPostUpdateGatewayRecoveryInstructions(activation.result),
    ];
    if (activation.opts.json) {
      defaultRuntime.error(diagnosticLines.join("\n"));
    } else {
      defaultRuntime.log(theme.warn(diagnosticLines[0] ?? "Gateway did not become healthy."));
      for (const line of diagnosticLines.slice(1)) {
        defaultRuntime.log(theme.muted(line));
      }
    }

    if (requiresVerifiedRestart() || opts.requireRunningService || expectedGatewayBuildId) {
      return false;
    }

    return !(
      health.versionMismatch ||
      health.buildIdMismatch ||
      health.activatedPluginErrors?.length
    );
  };

  if (activation.shouldRestart) {
    if (
      requiresInstallRootRefresh &&
      (!activation.refreshServiceEnv || activation.serviceInstallEnv === null)
    ) {
      defaultRuntime.error(
        "The updated installation requires a writable gateway service definition.",
      );
      return false;
    }
    if (!activation.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      let expectedGatewayVersion = requiresVerifiedRestart()
        ? normalizeOptionalString(activation.result.after?.version)
        : undefined;
      const expectedGatewayBuildId =
        activation.channel === "dev" && activation.result.mode === "git"
          ? normalizeOptionalString(activation.result.after?.buildId)
          : undefined;
      const canVerifyUpdatedGatewayByVersion =
        expectedGatewayVersion !== undefined &&
        expectedGatewayVersion !== normalizeOptionalString(activation.result.before?.version);
      let restarted = false;
      let restartInitiated = false;
      let refreshedGatewayAlreadyHealthy = false;
      let updatedInstallRestartNeedsServiceRootProof = false;
      let restartScriptPath = preserveDefinition ? null : activation.restartScriptPath;
      if (activation.refreshServiceEnv && activation.serviceInstallEnv !== null) {
        try {
          await runUpdatedInstallGatewayCommand(activation, "install");
          if (expectedGatewayVersion && (isPackageUpdate || expectedGatewayBuildId)) {
            const health = await waitForGatewayHealthyRestart({
              service: resolveGatewayService(),
              port: activation.gatewayPort,
              expectedVersion: expectedGatewayVersion,
              ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
              env: activation.serviceEnv,
              requireRunningService: true,
              attempts: POST_REFRESH_ALREADY_HEALTHY_ATTEMPTS,
              delayMs: POST_REFRESH_ALREADY_HEALTHY_DELAY_MS,
            });
            refreshedGatewayAlreadyHealthy = health.healthy;
            if (refreshedGatewayAlreadyHealthy && !activation.opts.json) {
              defaultRuntime.log(
                theme.muted(
                  "Gateway already reports the updated version after service refresh; skipped redundant restart.",
                ),
              );
            }
          }
        } catch (err) {
          defaultRuntime.error(
            `Failed to refresh gateway service environment from updated install: ${String(err)}`,
          );
          if (DEFINITION_DENIAL.test(String(err))) {
            // A writer denial is not a lifecycle grant: revalidate the retained
            // command and manager before using native activation without repair.
            preserveDefinition = true;
            if (verdict?.kind !== "owned") {
              throw err;
            }
            const state = await readGatewayServiceState(resolveGatewayService(), {
              env: activation.serviceEnv,
              requireEffective: true,
              validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
              timeoutMs: activation.timeoutMs,
            });
            await revalidateManagedGatewayServiceAfterUpdate({
              state,
              root: activation.result.root ?? verdict.root,
              preManagedServiceStop: {
                serviceEnv: activation.serviceEnv,
                serviceUpdateVerdict: { ...verdict, refreshDefinition: false },
              },
            });
            activation = {
              ...activation,
              serviceEnv: state.env,
              gatewayPort: await resolveUpdatedGatewayRestartPort({
                serviceEnv: state.env,
                serviceCommand: state.command,
              }),
            };
            expectedGatewayVersion = normalizeOptionalString(activation.result.after?.version);
            restartScriptPath = null;
          }
          if (isPackageUpdate) {
            restartScriptPath = null;
            updatedInstallRestartNeedsServiceRootProof = !canVerifyUpdatedGatewayByVersion;
          }
        }
        if (
          requiresInstallRootRefresh &&
          (await gatewayServiceCommandUsesRoot({
            root: activation.result.root,
            env: activation.serviceEnv,
          })) !== true
        ) {
          defaultRuntime.error(
            "Gateway service did not point at the updated install after refresh.",
          );
          return false;
        }
      }
      // Refresh can start the service directly. Once its version and source
      // build are healthy, another restart only interrupts the new process.
      if (!refreshedGatewayAlreadyHealthy && restartScriptPath) {
        if (!preserveDefinition) {
          await createUpdateConfigSnapshot();
        }
        await runRestartScript(restartScriptPath);
        restartInitiated = true;
      } else if (!refreshedGatewayAlreadyHealthy && canRestartUpdatedInstall()) {
        if (!preserveDefinition) {
          await createUpdateConfigSnapshot();
        }
        restarted = await runUpdatedInstallGatewayCommand(
          activation,
          "restart",
          preserveDefinition,
        );
        if (
          updatedInstallRestartNeedsServiceRootProof &&
          (await gatewayServiceCommandUsesRoot({
            root: activation.result.root,
            env: activation.serviceEnv,
          })) !== true
        ) {
          if (!activation.opts.json) {
            defaultRuntime.log(
              theme.warn("Gateway service did not point at the updated install after restart."),
            );
          }
          return false;
        }
      } else if (
        !refreshedGatewayAlreadyHealthy &&
        shouldUseLegacyProcessRestartAfterUpdate({ updateMode: activation.result.mode }) &&
        !activation.skipLegacyServiceRestart
      ) {
        if (!preserveDefinition) {
          await createUpdateConfigSnapshot();
        }
        restarted = await runDaemonRestart();
      } else if (!refreshedGatewayAlreadyHealthy && !activation.opts.json) {
        defaultRuntime.log(theme.muted("Gateway: restart skipped (no installed service found)."));
      }

      const shouldVerifyRestart =
        refreshedGatewayAlreadyHealthy ||
        restartInitiated ||
        (restarted &&
          (preserveDefinition ||
            expectedGatewayVersion !== undefined ||
            activation.result.mode === "git")) ||
        activation.requireRunningServiceAfterRestart;
      if (shouldVerifyRestart) {
        const requireRunningService =
          updatedInstallRestartNeedsServiceRootProof ||
          activation.requireRunningServiceAfterRestart;
        const restartHealthy = await verifyRestartedGateway(
          expectedGatewayVersion,
          expectedGatewayBuildId,
          { requireRunningService },
        );
        if (!restartHealthy) {
          if (!activation.opts.json) {
            defaultRuntime.log("");
          }
          return false;
        }
        if (!activation.opts.json && restartInitiated) {
          defaultRuntime.log(theme.success("Daemon restart completed."));
          defaultRuntime.log("");
        }
      }

      if (!activation.opts.json && restarted && !preserveDefinition) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
      }
    } catch (err) {
      defaultRuntime.error(
        `Gateway: restart failed: ${String(err)}. Code update remains installed; a service stopped for update may still be stopped. ` +
          "Run `openclaw gateway status --deep` and ask its service owner to restart it manually.",
      );
      if (requiresVerifiedRestart()) {
        return false;
      }
    }
    return true;
  }

  if (!activation.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.muted("Gateway: restart skipped (--no-restart)."));
    if (activation.result.mode === "npm" || activation.result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\`, then \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }
  return true;
}
