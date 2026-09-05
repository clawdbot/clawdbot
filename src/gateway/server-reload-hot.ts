import { reloadSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { refreshContextWindowCache } from "../agents/context.js";
import {
  markPreparedModelRuntimeSnapshotsStale,
  rejectPendingPreparedModelRuntimeReplacement,
  type PreparedModelRuntimeReplacementGateId,
} from "../agents/prepared-model-runtime.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import { setGatewaySigusr1RestartPolicy } from "../infra/restart.js";
import { PluginRuntimeApplicationError, getPluginRuntimeGeneration } from "../plugins/lifecycle.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload-plan.js";
import { shouldRefreshContextWindowCache } from "./config-reload-recovery.js";
import type { GatewayHotReloadApplication } from "./config-reload-status.types.js";
import { commitHooksConfigReload, resolveHooksConfig } from "./hooks.js";
import { buildGatewayCronService, type GatewayCronExitWatcherHandoff } from "./server-cron.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";
import { createGatewayActiveWorkTracker } from "./server-reload-active-work.js";
import { restartGatewayChannels } from "./server-reload-channel-restart.js";
import {
  assertReloadPublicationCurrent,
  createReloadCancellationError,
  GatewayHotReloadRecoveryError,
  type GatewayHotReloadPublication,
  type GatewayPluginReloadResult,
  type GatewayReloadHandlerParams,
  type GatewayRestartTransactionResult,
  type GatewayRuntimePublication,
} from "./server-reload-contracts.js";
import {
  isCurrentGatewayReloadGeneration,
  isGatewayReloadGenerationAborted,
  nextGatewayReloadGeneration,
} from "./server-reload-generation.js";
import * as mrReload from "./server-reload-model-runtime-scope.js";
import { createGatewayRestartCoordinator } from "./server-reload-restart.js";
import {
  assertIrreversibleReloadPlanHasRecoveryOwner,
  disposeMcpRuntimesWithTimeout,
  resetPreparedModelRuntimeStateForHotReload,
  revokeActiveSkillReviewsBeforeConfigPublication,
} from "./server-reload-utils.js";
import { startGatewayCronWithLogging } from "./server-runtime-services.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";

const MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS = 5_000;

export function createGatewayReloadHandlers(params: GatewayReloadHandlerParams) {
  const myGeneration = nextGatewayReloadGeneration();
  const restartRecoveryAvailable =
    params.restartRecoveryAvailable !== false && params.requestRecoveryRestart !== undefined;

  const {
    formatActiveDetails,
    formatDeferredWorkStatus,
    formatTaskBlockers,
    getActiveCounts,
    waitForActiveWorkBeforeChannelReload,
  } = createGatewayActiveWorkTracker({ params, myGeneration });

  const {
    acceptRestartConfig,
    beginGatewayRestartLifecycle,
    deferGatewayRestartDebt,
    getLatestAcceptedRestartTarget,
    hasOutstandingGatewayRestart,
    hasConfigCandidatePending,
    hasRestartRequestTransaction,
    isRestartRetryStopped,
    pauseGatewayRestartForConfigCandidate,
    publishAcceptedRestartTarget,
    publishAppliedConfigHash,
    publishDeferredAppliedConfigHash,
    recordAcceptedRestartTarget,
    requestGatewayRestart,
    restoreConservativeRestartDebt,
    retireRejectedRestartRequest,
    stopRestartRetries,
  } = createGatewayRestartCoordinator({
    params,
    myGeneration,
    restartRecoveryAvailable,
    getActiveCounts,
    formatActiveDetails,
    formatDeferredWorkStatus,
    formatTaskBlockers,
  });

  const applyHotReload = async (
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    publication?: GatewayHotReloadPublication,
  ): Promise<GatewayHotReloadApplication> => {
    publication?.assertInvokerOwned?.();
    assertIrreversibleReloadPlanHasRecoveryOwner(plan, restartRecoveryAvailable);
    const isCurrent = () => !isRestartRetryStopped() && (publication?.isCurrent?.() ?? true);
    const state = params.getState();
    const nextState = { ...state };
    const candidateEnv = publication?.runtimeEnv ?? process.env;
    const modelRuntimeAgentIds = mrReload.resolveReloadAgentIds(plan.changedPaths);
    const modelRuntimeRefreshScope = modelRuntimeAgentIds ? { agentIds: modelRuntimeAgentIds } : {};

    // Revalidate auth on demand; preparing every plugin can starve config RPCs.
    resetPreparedModelRuntimeStateForHotReload();

    if (plan.reloadHooks || plan.refreshHooksPolicy) {
      try {
        nextState.hooksConfig = resolveHooksConfig(nextConfig);
      } catch (err) {
        params.logHooks.warn(`hooks config reload failed: ${String(err)}`);
        throw err;
      }
    }
    nextState.hookClientIpConfig = resolveHookClientIpConfig(nextConfig);
    const internalHooks =
      plan.reloadInternalHooks || plan.reloadPlugins
        ? await (
            await import("../hooks/loader.js")
          ).prepareInternalHooks(
            nextConfig,
            tryResolveConfiguredAgentWorkspaceDir(nextConfig, candidateEnv) ??
              resolveDefaultAgentWorkspaceDir(candidateEnv),
          )
        : undefined;
    assertReloadPublicationCurrent(publication?.isCurrent() ?? true, isRestartRetryStopped());

    let cronExitWatcherHandoff:
      | { previous: GatewayCronExitWatcherHandoff; next: GatewayCronExitWatcherHandoff }
      | undefined;
    if (plan.restartCron) {
      nextState.cronState = buildGatewayCronService({
        cfg: nextConfig,
        deps: params.deps,
        broadcast: params.broadcast,
        env: publication?.runtimeEnv ?? process.env,
        // Without this a cron hot reload silently drops scheduler gateway
        // context, so scheduled runs regress to contextless after any reload.
        ...(params.resolveGatewayContext
          ? { resolveGatewayContext: params.resolveGatewayContext }
          : {}),
      });
      if (
        state.cronState.cronEnabled &&
        nextState.cronState.cronEnabled &&
        state.cronState.storePath === nextState.cronState.storePath
      ) {
        const [previous, next] = await Promise.all([
          state.cronState.prepareExitWatcherHandoff?.(),
          nextState.cronState.prepareExitWatcherHandoff?.(),
        ]);
        if (previous && next) {
          cronExitWatcherHandoff = { previous, next };
        }
      }
    }

    resetDirectoryCache();

    const channelsToRestart = new Set(plan.restartChannels);
    const restartChannelAccounts = new Map<ChannelKind, Set<string>>(
      [...(plan.restartChannelAccounts ?? [])].map(([channel, accountIds]) => [
        channel,
        new Set(accountIds),
      ]),
    );
    let activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null = null;
    let pluginReloadAborted = false;
    let runtimeCommitted = false;
    const isLifecycleReloadAborted = () => isGatewayReloadGenerationAborted(myGeneration);
    const ownsCron = () =>
      isCurrentGatewayReloadGeneration(myGeneration) &&
      !isLifecycleReloadAborted() &&
      !isRestartRetryStopped() &&
      params.getState().cronState === nextState.cronState;
    const isPluginReloadAborted = () =>
      pluginReloadAborted ||
      (!runtimeCommitted && !isCurrent()) ||
      isRestartRetryStopped() ||
      isLifecycleReloadAborted();
    let preparedModelRuntimeReplacementGateId: PreparedModelRuntimeReplacementGateId | undefined;
    let recoveryRestartScheduled = false;
    const laneConcurrency = resolveGatewayLaneConcurrency(nextConfig);
    // Use one candidate env snapshot before publication and through later channel starts.
    const shouldSkipChannelRestart =
      isTruthyEnvValue(candidateEnv.OPENCLAW_SKIP_CHANNELS) ||
      isTruthyEnvValue(candidateEnv.OPENCLAW_SKIP_PROVIDERS);
    const channelReloadTargets = () =>
      new Set<ChannelKind>([...channelsToRestart, ...restartChannelAccounts.keys()]);
    const getChannelAutostartSuppression = () => params.getChannelAutostartSuppression?.() ?? null;
    const logSuppressedChannelRestart = (
      channels: ReadonlySet<ChannelKind>,
      action: string,
    ): void => {
      const suppression = getChannelAutostartSuppression();
      if (!suppression) {
        return;
      }
      params.logChannels.info(
        `${action} suppressed by crash-loop breaker for channels: ${[...channels].join(", ")}`,
      );
    };
    const commitRuntime = async (runtime?: GatewayRuntimePublication) => {
      if (runtimeCommitted) {
        return;
      }
      const commit = async () => {
        // Plugin publication can reject its prepared registry. Keep config and
        // secret rollback available until that selection succeeds.
        publication?.assertInvokerOwned?.();
        runtime?.publish();
        if (runtime) {
          params.setState(nextState);
          runtimeCommitted = true;
        }
        if (plan.restartHeartbeat) {
          nextState.heartbeatRunner.updateConfig(nextConfig);
        }
        revokeActiveSkillReviewsBeforeConfigPublication(nextConfig);
        // Config, plugin hooks, and prepared stores publish as one generation. Synchronously
        // retire the prior stores at the commit edge so no request can mix generations.
        preparedModelRuntimeReplacementGateId = markPreparedModelRuntimeSnapshotsStale(
          "prepared model runtime owner is stale before config publication",
          { waitForReplacement: true, ...modelRuntimeRefreshScope },
        );
        if (!runtime) {
          params.setState(nextState);
          runtimeCommitted = true;
        }
        // Accepted config owns the remaining effects. A failure here must retain
        // its secrets and report a committed operation instead of restoring old state.
        if (plan.reloadHooks) {
          commitHooksConfigReload();
        }
        internalHooks?.commit();
        applyGatewayLaneConcurrency(laneConcurrency);
        runtime?.afterCommit?.();
        setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
      };
      try {
        await (publication ? publication.publish(commit, () => runtimeCommitted) : commit());
      } finally {
        // Commit removes the predecessor from runtime state. Drain it even if
        // later publication fails or the replacement loses lifecycle ownership.
        if (runtimeCommitted && plan.restartCron) {
          if (ownsCron()) {
            params.cronReconciliation.invalidate();
            params.onCronRestart?.();
          }
          if (cronExitWatcherHandoff && ownsCron()) {
            await cronExitWatcherHandoff.next.adopt(cronExitWatcherHandoff.previous.current());
            await cronExitWatcherHandoff.previous.stopOwner();
          } else if (state.cronState.cron.stopAndDrain) {
            await state.cronState.cron.stopAndDrain();
          } else {
            state.cronState.cron.stop();
            await state.cronState.stopStreamWatchers();
          }
        }
      }
      if (!ownsCron()) {
        return;
      }
      // Only accepted runtime state may own monitor writes and emitted events.
      if (
        plan.reconcileSystemJobs &&
        (await nextState.cronState.reconcileSystemJobs()) === "retry-scheduled"
      ) {
        throw new GatewayHotReloadRecoveryError("cron monitor");
      }
      if (plan.restartCron && ownsCron()) {
        startGatewayCronWithLogging({
          cronState: nextState.cronState,
          cronReconciliation: params.cronReconciliation,
          reason: "reload",
          config: nextConfig,
          afterStart: async () => {
            await Promise.all([
              nextState.cronState.reconcileExitWatchers(),
              nextState.cronState.reconcileStreamWatchers(),
            ]);
          },
          logCron: params.logCron,
          onStartError: (err) => {
            if (!ownsCron()) {
              return;
            }
            try {
              scheduleRecoveryRestart("cron reload", err);
            } catch (recoveryError) {
              params.logCron.error(formatErrorMessage(recoveryError));
            }
          },
        });
      }
    };
    const settleRecoveryRestart = (
      restartTransaction: GatewayRestartTransactionResult,
      surface: string,
    ) => {
      if (restartTransaction.status === "recovery-pending" && !restartRecoveryAvailable) {
        restartTransaction.settle("rejected");
        throw new GatewayHotReloadRecoveryError(surface);
      }
      restartTransaction.settle("committed");
      recoveryRestartScheduled = true;
    };
    const scheduleRecoveryRestart = (surface: string, err?: unknown) => {
      rejectPendingPreparedModelRuntimeReplacement(
        preparedModelRuntimeReplacementGateId,
        err ?? new Error(`prepared model runtime replacement stopped during ${surface}`),
      );
      if (plan.pluginLifecycle) {
        throw new PluginRuntimeApplicationError(
          `Plugin runtime application failed during ${surface}: ${formatErrorMessage(err)}`,
          {
            ...plan.pluginLifecycle,
            pluginIds: [...plan.pluginLifecycle.pluginIds],
            generation: getPluginRuntimeGeneration(),
            phase: runtimeCommitted ? "activate" : "prepare",
            committed: runtimeCommitted,
          },
          { cause: err },
        );
      }
      const detail = err === undefined ? "" : `: ${formatErrorMessage(err)}`;
      if (isRestartRetryStopped()) {
        params.logReload.warn(`${surface} failed during gateway shutdown${detail}`);
        return;
      }
      if (!restartRecoveryAvailable || !params.requestRecoveryRestart) {
        const message = runtimeCommitted
          ? `config hot reload committed with unrecovered ${surface} failure${detail}; gateway restart recovery is unavailable; runtime may be inconsistent`
          : `config hot reload failed before commit during ${surface}${detail}; gateway restart recovery is unavailable`;
        if (params.logReload.error) {
          params.logReload.error(message);
        } else {
          params.logReload.warn(message);
        }
        if (runtimeCommitted) {
          throw new GatewayHotReloadRecoveryError(surface);
        }
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(`config hot reload failed before commit during ${surface}${detail}`);
      }
      const recoveryPlan = {
        ...plan,
        restartGateway: true,
        restartReasons: [`hot reload recovery: ${surface}`],
      };
      if (!isCurrent()) {
        params.logReload.warn(
          `${surface} failed after config supersession${detail}; recovery deferred to the newer config`,
        );
        const target = getLatestAcceptedRestartTarget();
        if (!hasConfigCandidatePending() && !hasRestartRequestTransaction() && target) {
          const restartTransaction = requestGatewayRestart(recoveryPlan, target.runtimeConfig, {
            retainDebtAcrossConfigChanges: true,
            debtConfig: target.sourceConfig,
            prepareRuntimeConfig: target.prepareRuntimeConfig,
          });
          settleRecoveryRestart(restartTransaction, surface);
          return;
        }
        deferGatewayRestartDebt(recoveryPlan, nextConfig, {
          retainDebtAcrossConfigChanges: true,
          debtConfig: publication?.sourceConfig ?? nextConfig,
        });
        return;
      }
      const commitState = runtimeCommitted ? "after config commit" : "before config commit";
      params.logReload.warn(`${surface} failed ${commitState}${detail}; restarting gateway`);
      if (recoveryRestartScheduled) {
        return;
      }
      try {
        // Reuse the config-restart path to drain other work and fence restart delivery.
        const restartTransaction = requestGatewayRestart(
          recoveryPlan,
          nextConfig,
          // Recovery debt represents a failed runtime surface, not every path
          // in the hot plan. Keep it until a replacement restart commits.
          {
            retainDebtAcrossConfigChanges: true,
            debtConfig: publication?.sourceConfig ?? nextConfig,
            ...(publication?.prepareRestartRuntimeConfig
              ? { prepareRuntimeConfig: publication.prepareRestartRuntimeConfig }
              : {}),
          },
        );
        settleRecoveryRestart(restartTransaction, surface);
        // Keep the committed transaction accepted while emission recovery retries.
      } catch (restartError) {
        params.logReload.warn(
          `failed to schedule post-commit gateway restart: ${formatErrorMessage(restartError)}`,
        );
        if (restartError instanceof GatewayHotReloadRecoveryError) {
          throw restartError;
        }
        throw new GatewayHotReloadRecoveryError(surface);
      }
    };
    let pluginRuntimeApplication: GatewayPluginReloadResult["runtime"];
    try {
      if (plan.reloadPlugins) {
        // The plugin lifecycle owner drains and restores its own channel/service instances.
        // This config transaction owns only publication and unrelated config effects.
        const result = await params.reloadPlugins({
          nextConfig,
          sourceConfig: publication ? publication.sourceConfig : nextConfig,
          changedPaths: plan.changedPaths,
          pluginLifecycle: plan.pluginLifecycle,
          commitRuntime,
          env: publication?.runtimeEnv ?? process.env,
          isAborted: isPluginReloadAborted,
          assertInvokerOwned: publication?.assertInvokerOwned,
        });
        pluginReloadAborted = result.cancelled === true || isPluginReloadAborted();
        if (!pluginReloadAborted) {
          pluginRuntimeApplication = result.runtime;
          if (plan.pluginLifecycle && !pluginRuntimeApplication) {
            throw new Error("Plugin lifecycle completed without a runtime application receipt.");
          }
          activePluginChannelsAfterReload = result.activeChannels;
          for (const channel of result.restartChannels) {
            channelsToRestart.delete(channel);
            restartChannelAccounts.delete(channel);
          }
          params.pruneInactiveChannelAccountState(result.activeChannels);
          resetPreparedModelRuntimeStateForHotReload();
        }
      }

      const channelTargets = channelReloadTargets();
      // Plugin replacement can admit new agent work while an account monitor stays live.
      // Recheck that work here; durable ingress replay remains owned by the fresh monitor drain.
      if (!pluginReloadAborted && channelTargets.size > 0 && !shouldSkipChannelRestart) {
        const waitCancelled = await waitForActiveWorkBeforeChannelReload(channelTargets, isCurrent);
        // A committed owner must finish its model/channel tail before the next config runs.
        // Supersession ends this wait: a newer writer may itself be awaiting that next reload.
        pluginReloadAborted = waitCancelled && isPluginReloadAborted();
      }
      if (pluginReloadAborted) {
        // Only an uncommitted reload can transfer its receipt to the watcher. After
        // commit, same-content replay may be a no-op and cannot finish the interrupted tail.
        throw createReloadCancellationError(
          !runtimeCommitted && publication?.isCurrent() === false,
        );
      }
    } catch (error) {
      // Model refresh has not taken ownership yet; a failed exit must release its waiting readers.
      if (preparedModelRuntimeReplacementGateId) {
        rejectPendingPreparedModelRuntimeReplacement(preparedModelRuntimeReplacementGateId, error);
      }
      throw error;
    }
    try {
      await commitRuntime();
    } catch (err) {
      if (!runtimeCommitted) {
        throw err;
      }
      scheduleRecoveryRestart("runtime commit", err);
      return "applied-restart-required";
    }

    if (plan.restartServices?.size) {
      // Changed plugin owners already started with this config; retained owners
      // still honor service-specific reload declarations in mixed updates.
      const serviceIds = pluginRuntimeApplication
        ? new Set(
            params
              .getPluginRegistry()
              .services.filter(
                (entry) =>
                  plan.restartServices?.has(entry.service.id) &&
                  !pluginRuntimeApplication.pluginIds.includes(entry.pluginId),
              )
              .map((entry) => entry.service.id),
          )
        : plan.reloadPlugins
          ? new Set<string>()
          : plan.restartServices;
      if (serviceIds.size > 0) {
        try {
          if (!params.reloadPluginServices) {
            throw new Error("Plugin service reload owner is unavailable");
          }
          await params.reloadPluginServices(nextConfig, serviceIds);
        } catch (err) {
          scheduleRecoveryRestart("plugin services reload", err);
          return "applied-restart-required";
        }
      }
    }

    try {
      await mrReload.refreshModelRuntimeAfterHotReload({
        config: nextConfig,
        agentIds: modelRuntimeAgentIds,
        pluginMetadataSnapshot: params.getPluginMetadataSnapshot?.(),
      });
    } catch (err) {
      scheduleRecoveryRestart("prepared model runtime reload", err);
      return "applied-restart-required";
    }

    if (plan.disposeMcpRuntimes) {
      await disposeMcpRuntimesWithTimeout({
        dispose: () =>
          reloadSessionMcpRuntimes({
            cfg: nextConfig,
            manifestRegistry: params.getPluginMetadataSnapshot?.()?.manifestRegistry,
            reloadPlugins: plan.reloadPlugins,
          }),
        timeoutMs: MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS,
        onWarn: params.logReload.warn,
        label: "bundle-mcp runtime disposal during config reload",
      });
    }

    if (plan.restartGmailWatcher) {
      const restartAbortController =
        params.createGmailRestartAbortController?.() ?? new AbortController();
      try {
        await params.stopPostReadySidecars?.();
        if (!restartAbortController.signal.aborted) {
          const [{ stopGmailWatcher }, { startGmailWatcherWithLogs }] = await Promise.all([
            import("../hooks/gmail-watcher.js"),
            import("../hooks/gmail-watcher-lifecycle.js"),
          ]);
          if (!restartAbortController.signal.aborted) {
            await stopGmailWatcher().catch((err: unknown) => {
              params.logHooks.warn(`gmail watcher stop failed during reload: ${String(err)}`);
            });
          }
          if (!restartAbortController.signal.aborted) {
            await startGmailWatcherWithLogs({
              cfg: nextConfig,
              log: params.logHooks,
              signal: restartAbortController.signal,
              onSkipped: () =>
                params.logHooks.info(
                  "skipping gmail watcher restart (OPENCLAW_SKIP_GMAIL_WATCHER=1)",
                ),
            });
          }
        }
      } catch (err) {
        scheduleRecoveryRestart("gmail watcher reload", err);
      } finally {
        params.clearGmailRestartAbortController?.(restartAbortController);
      }
    }

    await restartGatewayChannels({
      params,
      nextConfig,
      channelsToRestart,
      restartChannelAccounts,
      activePluginChannelsAfterReload,
      shouldSkipChannelRestart,
      skipChannelRestartLogMessage:
        "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
      isLifecycleReloadAborted,
      getChannelAutostartSuppression,
      channelReloadTargets,
      logSuppressedChannelRestart,
      scheduleRecoveryRestart,
    });

    if (shouldRefreshContextWindowCache(plan)) {
      try {
        await refreshContextWindowCache(nextConfig);
      } catch (err) {
        scheduleRecoveryRestart("context window cache reload", err);
      }
    }
    if (plan.hotReasons.length > 0) {
      params.logReload.info(`config hot reload applied (${plan.hotReasons.join(", ")})`);
    } else if (plan.noopPaths.length > 0) {
      params.logReload.info(`config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`);
    }
    const status = recoveryRestartScheduled ? "applied-restart-required" : "applied";
    return pluginRuntimeApplication ? { status, runtime: pluginRuntimeApplication } : status;
  };

  return {
    applyHotReload,
    acceptRestartConfig,
    publishAppliedConfigHash,
    publishDeferredAppliedConfigHash,
    hasOutstandingGatewayRestart,
    hasConfigCandidatePending,
    beginGatewayRestartLifecycle,
    pauseGatewayRestartForConfigCandidate,
    publishAcceptedRestartTarget,
    recordAcceptedRestartTarget,
    requestGatewayRestart,
    restoreConservativeRestartDebt,
    retireRejectedRestartRequest,
    stopRestartRetries,
  };
}
