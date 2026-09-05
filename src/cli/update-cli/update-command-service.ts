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
import {
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import { runDaemonRestart } from "../daemon-cli.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import {
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import { runRestartScript } from "./restart-helper.js";
import type { UpdateCommandOptions } from "./shared.js";
import { createUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { runUpdateInferenceProbe } from "./update-command-inference.js";
import {
  DEFINITION_DENIAL,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";
import {
  revalidateManagedGatewayServiceAfterUpdate,
  type ManagedGatewayUpdateVerdict,
} from "./update-command-service-maintenance.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  gatewayServiceCommandUsesRoot,
  resolveGatewayServiceManagementBlockMessageForUpdate,
  resolveUpdatedGatewayRestartPort,
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
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service-maintenance.js";
export { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";

const CLI_NAME = resolveCliName();

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
        `Shell completion refresh failed: ${message}. Update will continue. Resolve the reported error before retrying: ${replaceCliName(formatCliCommand("openclaw completion --write-state --install"), CLI_NAME)}`,
      ),
    );
  }
}

/** A restart command can throw before health probes; replace pre-activation facts at that boundary. */
export async function recordFailedUpdateGatewayState(
  run: UpdateCommandOptions["run"],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!run) {
    return;
  }
  const runtime = await resolveGatewayService()
    .readRuntime(env)
    .catch(() => undefined);
  recordUpdateRunVerification(
    run.runId,
    {
      serviceRunning:
        runtime?.status === "running" ? true : runtime?.status === "stopped" ? false : undefined,
      pid: typeof runtime?.pid === "number" ? runtime.pid : undefined,
      runningVersion: undefined,
      runningBuildId: undefined,
      versionMatch: undefined,
      readyz: false,
      settled: false,
      channelsReady: false,
    },
    { env: run.env },
  );
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
  onVerificationFailure?: (reason: string) => void;
  onVerified?: (verifiedAtMs: number) => void;
}): Promise<boolean> {
  const invocationEnv = resolveServiceRefreshEnv(process.env, params.invocationCwd);
  const serviceEnv = resolveServiceRefreshEnv(
    params.serviceEnv ?? invocationEnv,
    params.invocationCwd,
  );
  const failed = async () => {
    await recordFailedUpdateGatewayState(params.opts.run, serviceEnv);
    return false;
  };
  if (params.shouldRestart) {
    const message =
      resolveGatewayServiceManagementBlockMessageForUpdate(invocationEnv) ??
      resolveGatewayServiceManagementBlockMessageForUpdate(serviceEnv);
    if (message) {
      defaultRuntime.error(message);
      return await failed();
    }
  }
  let activation = { ...params, invocationEnv, serviceEnv };
  const verdict = activation.serviceUpdateVerdict;
  let preserveDefinition =
    verdict?.kind === "unresolved" || (verdict?.kind === "owned" && !verdict.refreshDefinition);
  const requiresInstallRootRefresh =
    verdict?.kind === "owned" && verdict.requiresInstallRootRefresh;
  const isPackageUpdate = isPackageManagerUpdateMode(activation.result.mode);
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
  const recordPhase = (phase: "restarting" | "verifying") => {
    if (params.opts.run) {
      recordUpdateRunPhase(params.opts.run.runId, phase, undefined, { env: params.opts.run.env });
    }
  };
  const recordHealth = (health: GatewayRestartSnapshot, readyz = false) => {
    if (!params.opts.run) {
      return;
    }
    recordUpdateRunVerification(
      params.opts.run.runId,
      {
        serviceRunning: health.runtime.status === "running",
        ...(typeof health.runtime.pid === "number" ? { pid: health.runtime.pid } : {}),
        port: activation.gatewayPort,
        ...(health.gatewayVersion ? { runningVersion: health.gatewayVersion } : {}),
        ...(health.gatewayBuildId ? { runningBuildId: health.gatewayBuildId } : {}),
        ...(health.expectedVersion
          ? {
              versionMatch:
                health.gatewayVersion === health.expectedVersion && !health.buildIdMismatch,
            }
          : {}),
        pluginErrors: health.activatedPluginErrors?.map((error) => JSON.stringify(error)) ?? [],
        channelsReady: health.healthy && !health.channelProbeErrors?.length,
        settled: health.healthy,
        readyz,
      },
      { env: params.opts.run.env },
    );
  };
  const verifyRestartedGateway = async (
    expectedGatewayVersion: string | undefined,
    expectedGatewayBuildId: string | undefined,
    opts: { requireRunningService?: boolean; health?: GatewayRestartSnapshot } = {},
  ) => {
    recordPhase("verifying");
    const service = resolveGatewayService();
    const waitForHealthy = async () =>
      await waitForGatewayHealthyRestart({
        service,
        port: activation.gatewayPort,
        expectedVersion: expectedGatewayVersion,
        ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
        env: activation.serviceEnv,
        requireRunningService: opts.requireRunningService,
        settle: { probes: 12 },
        supervisorKeepsAlive: await hasLoadedLaunchdKeepAliveSupervisor({
          service,
          env: activation.serviceEnv,
        }),
      });
    let health = opts.health ?? (await waitForHealthy());
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
      updateRun: params.opts.run,
      preserveDefinition,
      health,
      service,
      port: activation.gatewayPort,
      expectedVersion: expectedGatewayVersion,
      ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
      env: activation.serviceEnv,
    });
    health = recoveryVerification.health;
    const context = await resolveGatewayRestartProbeContext(activation.serviceEnv);
    const http = await waitForGatewayHttpReadiness({
      config: context.config,
      port: activation.gatewayPort,
      attempts: 3,
      deadlineAt: Date.now() + 10_000,
      delayMs: 500,
    });
    const readyz = http.readyz === 200;
    recordHealth(health, readyz);
    const launchAgentRecovery = recoveryVerification.launchAgentRecovery;
    if (launchAgentRecovery?.attempted) {
      defaultRuntime.error(
        launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
      );
    }

    const serviceRuntimeHealthy =
      !opts.requireRunningService || health.runtime.status === "running";
    if (health.healthy && serviceRuntimeHealthy && readyz) {
      params.onVerified?.(Date.now());
      const inference = await runUpdateInferenceProbe({
        root: activation.result.root,
        env: activation.serviceEnv,
        nodeRunner: activation.nodeRunner,
      });
      if (params.opts.run) {
        recordUpdateRunVerification(
          params.opts.run.runId,
          { inferenceProbe: inference ? "passed" : "unavailable" },
          { env: params.opts.run.env },
        );
      }
      if (!inference && !activation.opts.json) {
        defaultRuntime.log(
          theme.warn("Inference: unavailable (advisory; Gateway verification passed)."),
        );
      }
      if (!activation.opts.json) {
        defaultRuntime.log(theme.success("Gateway: restarted and verified."));
      }
      return true;
    }

    const diagnosticLines = [
      "Gateway did not become healthy after restart.",
      ...(!readyz ? ["Gateway /readyz did not return HTTP 200."] : []),
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
    const reason = health.versionMismatch
      ? "version-mismatch"
      : health.buildIdMismatch
        ? "build-id-mismatch"
        : health.activatedPluginErrors?.length
          ? "plugin-errors"
          : health.channelProbeErrors?.length
            ? "channel-errors"
            : !readyz
              ? "readyz-unhealthy"
              : !serviceRuntimeHealthy
                ? "service-not-running"
                : (health.waitOutcome ?? "restart-unhealthy");
    params.onVerificationFailure?.(reason);
    if (params.opts.run) {
      recordUpdateRunStep(
        params.opts.run.runId,
        {
          step: "gateway verification",
          status: "failed",
          endedAtMs: Date.now(),
          detail: !readyz ? "Gateway /readyz did not return HTTP 200." : reason,
        },
        { env: params.opts.run.env },
      );
    }
    if (activation.opts.json) {
      defaultRuntime.error(diagnosticLines.join("\n"));
    } else {
      defaultRuntime.log(theme.warn(diagnosticLines[0] ?? "Gateway did not become healthy."));
      for (const line of diagnosticLines.slice(1)) {
        defaultRuntime.log(theme.muted(line));
      }
    }

    return false;
  };

  if (activation.shouldRestart) {
    if (
      requiresInstallRootRefresh &&
      (!activation.refreshServiceEnv || activation.serviceInstallEnv === null)
    ) {
      defaultRuntime.error(
        "The updated installation requires a writable gateway service definition.",
      );
      return await failed();
    }
    if (!activation.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      let expectedGatewayVersion = normalizeOptionalString(activation.result.after?.version);
      const expectedGatewayBuildId = normalizeOptionalString(activation.result.after?.buildId);
      const canVerifyUpdatedGatewayByVersion =
        expectedGatewayVersion !== undefined &&
        expectedGatewayVersion !== normalizeOptionalString(activation.result.before?.version);
      let restarted = false;
      let restartInitiated = false;
      let refreshedGatewayHealth: GatewayRestartSnapshot | undefined;
      let updatedInstallRestartNeedsServiceRootProof = false;
      let restartScriptPath = preserveDefinition ? null : activation.restartScriptPath;
      if (activation.refreshServiceEnv && activation.serviceInstallEnv !== null) {
        try {
          recordPhase("restarting");
          await runUpdatedInstallGatewayCommand(activation, "install");
          if (expectedGatewayVersion && (isPackageUpdate || expectedGatewayBuildId)) {
            recordPhase("verifying");
            const service = resolveGatewayService();
            const health = await waitForGatewayHealthyRestart({
              service,
              port: activation.gatewayPort,
              expectedVersion: expectedGatewayVersion,
              ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
              env: activation.serviceEnv,
              requireRunningService: true,
              settle: { probes: 12 },
              supervisorKeepsAlive: await hasLoadedLaunchdKeepAliveSupervisor({
                service,
                env: activation.serviceEnv,
              }),
            });
            refreshedGatewayHealth = health.healthy ? health : undefined;
            recordHealth(health);
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
          return await failed();
        }
      }
      // Refresh already started and settled this process. Keep its health snapshot
      // while completing HTTP readiness and inference without another restart.
      if (refreshedGatewayHealth) {
        return await verifyRestartedGateway(expectedGatewayVersion, expectedGatewayBuildId, {
          requireRunningService: true,
          health: refreshedGatewayHealth,
        });
      }
      if (restartScriptPath) {
        if (!preserveDefinition) {
          await createUpdateConfigSnapshot();
        }
        recordPhase("restarting");
        await runRestartScript(restartScriptPath);
        restartInitiated = true;
      } else if (canRestartUpdatedInstall()) {
        if (!preserveDefinition) {
          await createUpdateConfigSnapshot();
        }
        recordPhase("restarting");
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
          return await failed();
        }
      } else if (
        shouldUseLegacyProcessRestartAfterUpdate({ updateMode: activation.result.mode }) &&
        !activation.skipLegacyServiceRestart
      ) {
        if (!preserveDefinition) {
          await createUpdateConfigSnapshot();
        }
        recordPhase("restarting");
        restarted = await runDaemonRestart();
      } else if (!activation.opts.json) {
        defaultRuntime.log(theme.muted("Gateway: restart skipped (no installed service found)."));
      }

      const shouldVerifyRestart =
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
          return await failed();
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
      return await failed();
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
