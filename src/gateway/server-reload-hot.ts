import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { refreshContextWindowCache } from "../agents/context.js";
import { warmCurrentProviderAuthStateOffMainThread } from "../agents/model-provider-auth.js";
import {
  markPreparedModelRuntimeSnapshotsStale,
  rejectPendingPreparedModelRuntimeReplacement,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeReplacementGateId,
} from "../agents/prepared-model-runtime.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import { setGatewaySigusr1RestartPolicy } from "../infra/restart.js";
import type { ChannelKind } from "./config-reload-plan.js";
import {
  shouldRefreshContextWindowCache,
  shouldRewarmProviderAuthState,
} from "./config-reload-recovery.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { commitHooksConfigReload, resolveHooksConfig } from "./hooks.js";
import { buildGatewayCronService } from "./server-cron.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";
import { createGatewayActiveWorkTracker } from "./server-reload-active-work.js";
import {
  restartGatewayChannels,
  startGatewayChannelFromActiveRegistry,
} from "./server-reload-channel-restart.js";
import {
  GatewayHotReloadCancelledError,
  GatewayHotReloadRecoveryError,
  isCurrentGatewayReloadGeneration,
  isGatewayReloadGenerationAborted,
  nextGatewayReloadGeneration,
  type GatewayHotReloadPublication,
  type GatewayPluginReloadResult,
  type GatewayReloadHandlerParams,
  type GatewayRestartTransactionResult,
} from "./server-reload-contracts.js";
import { createGatewayRestartCoordinator } from "./server-reload-restart.js";
import {
  assertIrreversibleReloadPlanHasRecoveryOwner,
  collectChannelOperationFailures,
  disposeMcpRuntimesWithTimeout,
  resetPreparedModelRuntimeStateForHotReload,
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
  ): Promise<void> => {
    assertIrreversibleReloadPlanHasRecoveryOwner(plan, restartRecoveryAvailable);
    const isTransactionCurrent = () =>
      !isRestartRetryStopped() && (publication?.isCurrent?.() ?? true);
    const state = params.getState();
    const nextState = { ...state };

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
    }

    resetDirectoryCache();

    const channelsToRestart = new Set(plan.restartChannels);
    const restartChannelAccounts = new Map<ChannelKind, Set<string>>(
      [...(plan.restartChannelAccounts ?? [])].map(([channel, accountIds]) => [
        channel,
        new Set(accountIds),
      ]),
    );
    const channelsStoppedBeforePluginReload = new Set<ChannelKind>();
    const accountsStoppedBeforePluginReload = new Map<ChannelKind, Set<string>>();
    let activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null = null;
    let pluginReloadAborted = false;
    const isLifecycleReloadAborted = () => isGatewayReloadGenerationAborted(myGeneration);
    const isPluginReloadAborted = () =>
      pluginReloadAborted || !isTransactionCurrent() || isLifecycleReloadAborted();
    let runtimeCommitted = false;
    let preparedModelRuntimeReplacementGateId: PreparedModelRuntimeReplacementGateId | undefined;
    let recoveryRestartScheduled = false;
    const laneConcurrency = resolveGatewayLaneConcurrency(nextConfig);
    const candidateEnv = publication?.runtimeEnv ?? process.env;
    // Planning happens before candidate env publication, while channel starts
    // happen after it. Use one candidate snapshot across both phases.
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
    const commitRuntime = async (onCommit?: () => void) => {
      if (runtimeCommitted) {
        return;
      }
      const commit = async () => {
        if (plan.restartHeartbeat) {
          nextState.heartbeatRunner.updateConfig(nextConfig);
          // Heartbeat cadence lives in system-owned cron monitor jobs;
          // reconverge them against the new config in the background.
          void nextState.cronState.reconcileHeartbeatJobs(nextConfig).catch((error: unknown) => {
            params.logReload.warn(`heartbeat monitor reconvergence failed: ${String(error)}`);
          });
        }
        // Config, plugin hooks, and prepared stores publish as one generation. Synchronously
        // retire the prior stores at the commit edge so no request can mix generations.
        preparedModelRuntimeReplacementGateId = markPreparedModelRuntimeSnapshotsStale(
          "prepared model runtime owner is stale before config publication",
          { waitForReplacement: true },
        );
        params.setState(nextState);
        // All rejecting work is complete. Publish pre-resolved lane limits at
        // the final synchronous commit edge, alongside the accepted state.
        if (plan.reloadHooks) {
          commitHooksConfigReload();
        }
        applyGatewayLaneConcurrency(laneConcurrency);
        runtimeCommitted = true;
        onCommit?.();
        setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
        if (plan.restartCron) {
          params.cronReconciliation.invalidate();
          params.onCronRestart?.();
          if (state.cronState.cron.stopAndDrain) {
            await state.cronState.cron.stopAndDrain();
          } else {
            state.cronState.cron.stop();
            state.cronState.stopExitWatchers();
            await state.cronState.stopStreamWatchers();
          }
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
              if (
                !isCurrentGatewayReloadGeneration(myGeneration) ||
                params.getState().cronState !== nextState.cronState
              ) {
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
      if (publication) {
        await publication.publish(commit, () => runtimeCommitted);
      } else {
        await commit();
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
      const detail = err === undefined ? "" : `: ${formatErrorMessage(err)}`;
      if (runtimeCommitted) {
        rejectPendingPreparedModelRuntimeReplacement(
          preparedModelRuntimeReplacementGateId,
          err ?? new Error(`prepared model runtime replacement stopped during ${surface}`),
        );
      }
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
      if (!isTransactionCurrent()) {
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
        // Reuse the config-restart path: it excludes this reload root while
        // draining other work and fences signal delivery until restart takes over.
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
        // Immediate emission failure already owns a lifecycle retry. The runtime
        // is committed, so keep this transaction accepted while that retry runs.
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
    if (plan.reloadPlugins) {
      const restartStoppedPluginAccounts = async (reason: string): Promise<string[]> => {
        const failures: string[] = [];
        for (const [channel, accountIds] of accountsStoppedBeforePluginReload) {
          for (const accountId of accountIds) {
            try {
              params.logChannels.info(`restarting ${channel} account ${accountId} after ${reason}`);
              await startGatewayChannelFromActiveRegistry(params, channel, accountId);
              accountIds.delete(accountId);
            } catch (err) {
              failures.push(`${channel}[${accountId}]`);
              params.logChannels.error(
                `failed to restart ${channel} account ${accountId} after ${reason}: ${formatErrorMessage(err)}`,
              );
            }
          }
          if (accountIds.size === 0) {
            accountsStoppedBeforePluginReload.delete(channel);
          }
        }
        return failures;
      };
      const restartStoppedPluginChannels = async (reason: string) =>
        await collectChannelOperationFailures({
          channels: [...channelsStoppedBeforePluginReload],
          run: async (channel) => {
            params.logChannels.info(`restarting ${channel} channel after ${reason}`);
            await startGatewayChannelFromActiveRegistry(params, channel);
            channelsStoppedBeforePluginReload.delete(channel);
          },
          onFailure: (channel, err) => {
            params.logChannels.error(
              `failed to restart ${channel} channel after ${reason}: ${formatErrorMessage(err)}`,
            );
          },
        });
      const rollbackStoppedPluginTargets = async (reason: string): Promise<string[]> => [
        ...(await restartStoppedPluginAccounts(reason)),
        ...(await restartStoppedPluginChannels(reason)),
      ];
      const failPluginChannelRollback = (reason: string, failures: string[]): never => {
        const error = new Error(
          `plugin reload cancellation rollback failed for: ${failures.join(", ")}`,
        );
        scheduleRecoveryRestart(`plugin channel rollback after ${reason}`, error);
        throw error;
      };
      const stopChannelsBeforePluginReplace = async (
        channels: ReadonlySet<ChannelKind>,
        accounts: ReadonlyMap<ChannelKind, ReadonlySet<string>> = new Map(),
      ) => {
        for (const channel of channels) {
          channelsToRestart.add(channel);
        }
        for (const [channel, accountIds] of accounts) {
          if (channelsToRestart.has(channel)) {
            continue;
          }
          let restartAccountIds = restartChannelAccounts.get(channel);
          if (!restartAccountIds) {
            restartAccountIds = new Set();
            restartChannelAccounts.set(channel, restartAccountIds);
          }
          for (const accountId of accountIds) {
            restartAccountIds.add(accountId);
          }
        }
        const targets = channelReloadTargets();
        if (targets.size === 0 || shouldSkipChannelRestart) {
          return;
        }
        if (await waitForActiveWorkBeforeChannelReload(targets, isTransactionCurrent)) {
          params.logChannels.info(
            "channel reload before plugin replace cancelled by config supersession or restart",
          );
          pluginReloadAborted = true;
          return;
        }
        const accountStopFailures: string[] = [];
        for (const [channel, accountIds] of accounts) {
          if (channelsToRestart.has(channel)) {
            continue;
          }
          for (const accountId of accountIds) {
            if (isPluginReloadAborted()) {
              pluginReloadAborted = true;
              break;
            }
            let stoppedAccountIds = accountsStoppedBeforePluginReload.get(channel);
            if (!stoppedAccountIds) {
              stoppedAccountIds = new Set();
              accountsStoppedBeforePluginReload.set(channel, stoppedAccountIds);
            }
            if (stoppedAccountIds.has(accountId)) {
              continue;
            }
            stoppedAccountIds.add(accountId);
            try {
              params.logChannels.info(
                `stopping ${channel} account ${accountId} before plugin reload`,
              );
              await params.stopChannel(channel, accountId, { manual: false });
              if (isPluginReloadAborted()) {
                pluginReloadAborted = true;
              }
            } catch (err) {
              accountStopFailures.push(`${channel}[${accountId}]`);
              params.logChannels.error(
                `failed to stop ${channel} account ${accountId} before plugin reload: ${formatErrorMessage(err)}`,
              );
            }
          }
        }
        const channelStopFailures = await collectChannelOperationFailures({
          channels: channelsToRestart,
          run: async (channel) => {
            if (isPluginReloadAborted()) {
              pluginReloadAborted = true;
              return;
            }
            if (channelsStoppedBeforePluginReload.has(channel)) {
              return;
            }
            params.logChannels.info(`stopping ${channel} channel before plugin reload`);
            channelsStoppedBeforePluginReload.add(channel);
            await params.stopChannel(channel, undefined, { manual: false });
            if (isPluginReloadAborted()) {
              pluginReloadAborted = true;
            }
          },
          onFailure: (channel, err) => {
            params.logChannels.error(
              `failed to stop ${channel} channel before plugin reload: ${formatErrorMessage(err)}`,
            );
          },
        });
        if (isPluginReloadAborted()) {
          pluginReloadAborted = true;
        }
        if (pluginReloadAborted) {
          if (isLifecycleReloadAborted()) {
            return;
          }
          const rollbackFailures = await rollbackStoppedPluginTargets(
            "cancelled plugin reload pre-stop",
          );
          if (rollbackFailures.length > 0) {
            failPluginChannelRollback("cancelled plugin reload pre-stop", rollbackFailures);
          }
          return;
        }
        const stopFailures = [...accountStopFailures, ...channelStopFailures];
        if (stopFailures.length > 0) {
          const rollbackFailures = await rollbackStoppedPluginTargets(
            "failed plugin reload pre-stop",
          );
          if (rollbackFailures.length > 0) {
            failPluginChannelRollback("failed plugin reload pre-stop", rollbackFailures);
          }
          throw new Error(
            `failed to stop channels before plugin reload: ${stopFailures.join(", ")}`,
          );
        }
      };
      if (!pluginReloadAborted) {
        let pluginReloadResult: GatewayPluginReloadResult;
        try {
          pluginReloadResult = await params.reloadPlugins({
            nextConfig,
            // Without a managed publication, the direct caller's input is itself authored.
            sourceConfig: publication ? publication.sourceConfig : nextConfig,
            changedPaths: plan.changedPaths,
            beforeReplace: stopChannelsBeforePluginReplace,
            commitRuntime,
            onReplacementTeardownFailure: (error) =>
              scheduleRecoveryRestart("plugin service replacement teardown", error),
            env: publication?.runtimeEnv ?? process.env,
            isAborted: isPluginReloadAborted,
          });
        } catch (err) {
          if (!runtimeCommitted) {
            // Once replacement teardown begins, old services cannot safely be rolled back.
            if (recoveryRestartScheduled) {
              throw err;
            }
            const rollbackFailures = await rollbackStoppedPluginTargets(
              "failed plugin runtime publication",
            );
            if (rollbackFailures.length > 0) {
              failPluginChannelRollback("failed plugin runtime publication", rollbackFailures);
            }
            throw err;
          }
          scheduleRecoveryRestart("plugin runtime reload", err);
          return;
        }
        if (pluginReloadResult.cancelled) {
          pluginReloadAborted = true;
          if (!isLifecycleReloadAborted()) {
            const rollbackFailures = await rollbackStoppedPluginTargets(
              "cancelled plugin runtime publication",
            );
            if (rollbackFailures.length > 0) {
              failPluginChannelRollback("cancelled plugin runtime publication", rollbackFailures);
            }
          }
        }
        // beforeReplace may have set pluginReloadAborted inside reloadPlugins;
        // skip metadata/runtime updates when the reload was cancelled mid-flight.
        if (!pluginReloadAborted) {
          for (const channel of pluginReloadResult.restartChannels) {
            channelsToRestart.add(channel);
          }
          activePluginChannelsAfterReload = pluginReloadResult.activeChannels;
          resetPreparedModelRuntimeStateForHotReload();
        }
      }
    }

    const channelTargets = channelReloadTargets();
    const hasLiveChannelTargets = [...channelTargets].some(
      (channel) => !channelsStoppedBeforePluginReload.has(channel),
    );
    // Plugin replacement can admit new agent work while an account monitor stays live.
    // Recheck that work here; durable ingress replay remains owned by the fresh monitor drain.
    if (!pluginReloadAborted && hasLiveChannelTargets && !shouldSkipChannelRestart) {
      pluginReloadAborted = await waitForActiveWorkBeforeChannelReload(
        channelTargets,
        isTransactionCurrent,
      );
    }
    if (pluginReloadAborted) {
      params.logChannels.info("channel restart cancelled by config supersession or restart");
      const error = new GatewayHotReloadCancelledError();
      if (runtimeCommitted) {
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
      return;
    }

    try {
      const pluginMetadataSnapshot = params.getPluginMetadataSnapshot?.();
      await refreshPreparedModelRuntimeSnapshots(nextConfig, {
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      });
    } catch (err) {
      scheduleRecoveryRestart("prepared model runtime reload", err);
      return;
    }

    if (plan.restartHealthMonitor) {
      try {
        state.channelHealthMonitor?.stop();
        await state.channelHealthMonitor?.waitForIdle();
        nextState.channelHealthMonitor = params.createHealthMonitor(nextConfig);
        params.setState(nextState);
      } catch (err) {
        scheduleRecoveryRestart("health monitor reload", err);
      }
    }

    if (plan.disposeMcpRuntimes) {
      await disposeMcpRuntimesWithTimeout({
        dispose: disposeAllSessionMcpRuntimes,
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
              isCancelled: () => restartAbortController.signal.aborted,
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
      plan,
      nextConfig,
      channelsToRestart,
      restartChannelAccounts,
      activePluginChannelsAfterReload,
      channelsStoppedBeforePluginReload,
      accountsStoppedBeforePluginReload,
      shouldSkipChannelRestart,
      skipChannelRestartLogMessage:
        "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
      pluginReloadAborted,
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
    if (shouldRewarmProviderAuthState(plan)) {
      void warmCurrentProviderAuthStateOffMainThread(nextConfig, {
        isCancelled: () => !isTransactionCurrent(),
      }).catch((err: unknown) => {
        if (isTransactionCurrent()) {
          params.logReload.warn(`provider auth state rewarm failed: ${String(err)}`);
        }
      });
    }
    if (plan.hotReasons.length > 0) {
      params.logReload.info(`config hot reload applied (${plan.hotReasons.join(", ")})`);
    } else if (plan.noopPaths.length > 0) {
      params.logReload.info(`config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`);
    }
  };

  return {
    applyHotReload,
    acceptRestartConfig,
    publishAppliedConfigHash,
    publishDeferredAppliedConfigHash,
    hasOutstandingGatewayRestart,
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
