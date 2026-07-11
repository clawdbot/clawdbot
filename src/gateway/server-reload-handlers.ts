// Gateway hot-reload handlers.
// Applies config reload plans to hooks, cron, heartbeat, plugins, channels, and restarts.
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { getActiveBackgroundExecSessionCount } from "../agents/bash-process-registry.js";
import { refreshContextWindowCache } from "../agents/context.js";
import {
  getActiveEmbeddedRunCount,
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "../agents/embedded-agent-runner/run-state.js";
import { loadModelCatalog, resetModelCatalogCache } from "../agents/model-catalog.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../agents/model-provider-auth.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CliDeps } from "../cli/deps.types.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  deferGatewayRestartUntilIdle,
  emitGatewayRestartWithSignalAdmission,
  resolveGatewayRestartDeferralTimeoutMs,
  setGatewaySigusr1RestartPolicy,
} from "../infra/restart.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import { getInspectableActiveTaskRestartBlockers } from "../tasks/task-registry.maintenance.js";
import { formatActiveTaskRestartBlocker } from "../tasks/task-restart-blocker.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelKind } from "./config-reload-plan.js";
import { startGatewayConfigReloader, type GatewayReloadPlan } from "./config-reload.js";
import { resolveHooksConfig } from "./hooks.js";
import type { GatewayCronReconciliation } from "./server-cron-reconciled.js";
import { buildGatewayCronService, type GatewayCronState } from "./server-cron.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { markGatewayModelCatalogStaleForReload } from "./server-model-catalog.js";
import type { GatewayConfigReloaderHandle } from "./server-runtime-handles.js";
import {
  type GatewayChannelManager,
  startGatewayChannelHealthMonitor,
  startGatewayCronWithLogging,
} from "./server-runtime-services.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  setCurrentSharedGatewaySessionGeneration,
  type SharedGatewayAuthClient,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import type { ActivateRuntimeSecrets } from "./server-startup-config.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";
import type { HookClientIpConfig } from "./server/hooks-request-handler.js";

// When an in-process restart (SIGUSR1) fires while a deferred channel reload
// is waiting for active work to drain, the restart supersedes the reload.
// This abort generation lets the restart path cancel the deferred reload before both
// code paths race to start the same channel. Each createGatewayReloadHandlers call
// increments the generation so a new lifecycle never clears an abort intended for a
// previous lifecycle's deferred reload.
let currentReloadGeneration = 0;
let abortGeneration: number | undefined = undefined;

/** Signal any in-progress deferred channel reload to abort immediately. */
export function abortPendingChannelReloads(): void {
  abortGeneration = currentReloadGeneration;
}

type GatewayHotReloadState = {
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  hookClientIpConfig: HookClientIpConfig;
  heartbeatRunner: HeartbeatRunner;
  cronState: GatewayCronState;
  channelHealthMonitor: ChannelHealthMonitor | null;
};

async function activateSecretsRuntimeSnapshot(
  snapshot: PreparedSecretsRuntimeSnapshot,
): Promise<void> {
  const runtime = await import("../secrets/runtime.js");
  runtime.activateSecretsRuntimeSnapshot(snapshot);
}

type GatewayReloadLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type GatewayGmailRestartAbortController = {
  abort: () => void;
  signal: AbortSignal;
};

export type GatewayPluginReloadResult = {
  restartChannels: ReadonlySet<ChannelKind>;
  activeChannels: ReadonlySet<ChannelKind>;
  /** Set when the reload was cancelled mid-flight (e.g. by an in-process restart). */
  cancelled?: boolean;
};

const MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS = 5_000;
const CHANNEL_RELOAD_DEFERRAL_POLL_MS = 500;
const CHANNEL_RELOAD_STILL_PENDING_WARN_MS = 30_000;

function resetPreparedModelRuntimeStateForHotReload(): void {
  resetModelCatalogCache();
  clearCurrentProviderAuthState();
  markGatewayModelCatalogStaleForReload();
}

function shouldRefreshContextWindowCache(plan: GatewayReloadPlan): boolean {
  return (
    plan.reloadPlugins ||
    plan.changedPaths.some(
      (path) =>
        path === "models" ||
        path.startsWith("models.") ||
        path === "agents" ||
        path === "agents.defaults" ||
        path === "agents.list" ||
        path.startsWith("agents.list.") ||
        path === "agents.defaults.workspace" ||
        path.startsWith("agents.defaults.workspace."),
    )
  );
}

async function disposeMcpRuntimesWithTimeout(params: {
  dispose: () => Promise<void>;
  timeoutMs: number;
  onWarn: (message: string) => void;
  label: string;
}) {
  // MCP runtime disposal may need async provider cleanup. Bound it so config
  // reload can proceed and report the stale runtime risk.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disposePromise = params.dispose().catch((error: unknown) => {
    params.onWarn(`${params.label} failed: ${String(error)}`);
  });
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), params.timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([disposePromise.then(() => "done" as const), timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  if (result === "timeout") {
    params.onWarn(`${params.label} exceeded ${params.timeoutMs}ms; continuing`);
  }
}

async function collectChannelOperationFailures(params: {
  channels: Iterable<ChannelKind>;
  run: (channel: ChannelKind) => Promise<void>;
  onFailure: (channel: ChannelKind, err: unknown) => void;
}): Promise<ChannelKind[]> {
  const failures: ChannelKind[] = [];
  for (const channel of params.channels) {
    try {
      await params.run(channel);
    } catch (err) {
      failures.push(channel);
      params.onFailure(channel, err);
    }
  }
  return failures;
}

type GatewayReloadHandlerParams = {
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  getState: () => GatewayHotReloadState;
  setState: (state: GatewayHotReloadState) => void;
  startChannel: GatewayChannelManager["startChannel"];
  stopChannel: GatewayChannelManager["stopChannel"];
  getChannelAutostartSuppression?: GatewayChannelManager["getAutostartSuppression"];
  stopPostReadySidecars?: () => Promise<void> | void;
  reloadPlugins: (params: {
    nextConfig: OpenClawConfig;
    changedPaths: readonly string[];
    beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
    isAborted?: () => boolean;
  }) => Promise<GatewayPluginReloadResult>;
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logCron: { error: (msg: string) => void };
  logReload: GatewayReloadLog;
  cronReconciliation: GatewayCronReconciliation;
  createHealthMonitor: (config: OpenClawConfig) => ChannelHealthMonitor | null;
  createGmailRestartAbortController?: () => GatewayGmailRestartAbortController;
  clearGmailRestartAbortController?: (controller: GatewayGmailRestartAbortController) => void;
  onCronRestart?: () => void;
};

type ManagedGatewayConfigReloaderParams = Omit<
  GatewayReloadHandlerParams,
  "createHealthMonitor" | "logReload"
> & {
  minimalTestGateway: boolean;
  initialConfig: OpenClawConfig;
  initialCompareConfig?: OpenClawConfig;
  initialInternalWriteHash: string | null;
  watchPath: string;
  readSnapshot: typeof import("../config/config.js").readConfigFileSnapshot;
  promoteSnapshot: typeof import("../config/config.js").promoteConfigSnapshotToLastKnownGood;
  subscribeToWrites: typeof import("../config/config.js").registerConfigWriteListener;
  logReload: GatewayReloadLog & {
    error: (msg: string) => void;
  };
  channelManager: GatewayChannelManager;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  resolveSharedGatewaySessionGenerationForConfig: (config: OpenClawConfig) => string | undefined;
  sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState;
  clients: Iterable<SharedGatewayAuthClient>;
  reconcileTerminalSessions: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void;
  commitTerminalConfig: () => void;
};

export function createGatewayReloadHandlers(params: GatewayReloadHandlerParams) {
  const myGeneration = ++currentReloadGeneration;

  const getActiveCounts = () => {
    const queueSize = getTotalQueueSize();
    const pendingReplies = getTotalPendingReplies();
    const embeddedRuns = getActiveEmbeddedRunCount();
    const backgroundExecSessions = getActiveBackgroundExecSessionCount();
    const rootRequests = getActiveGatewayRootWorkCount({ excludeCurrent: true });
    const activeTasks = getInspectableActiveTaskRestartBlockers().length;
    return {
      queueSize,
      pendingReplies,
      embeddedRuns,
      backgroundExecSessions,
      rootRequests,
      activeTasks,
      totalActive:
        queueSize +
        pendingReplies +
        embeddedRuns +
        backgroundExecSessions +
        rootRequests +
        activeTasks,
    };
  };
  const formatActiveDetails = (counts: ReturnType<typeof getActiveCounts>) => {
    const details = [];
    if (counts.queueSize > 0) {
      details.push(`${counts.queueSize} operation(s)`);
    }
    if (counts.pendingReplies > 0) {
      details.push(`${counts.pendingReplies} reply(ies)`);
    }
    if (counts.embeddedRuns > 0) {
      details.push(`${counts.embeddedRuns} embedded run(s)`);
    }
    if (counts.backgroundExecSessions > 0) {
      details.push(`${counts.backgroundExecSessions} background exec session(s)`);
    }
    if (counts.rootRequests > 0) {
      details.push(`${counts.rootRequests} gateway request(s)`);
    }
    if (counts.activeTasks > 0) {
      details.push(`${counts.activeTasks} background task run(s)`);
    }
    return details;
  };
  const formatTaskBlockers = () => {
    const blockers = getInspectableActiveTaskRestartBlockers();
    if (blockers.length === 0) {
      return null;
    }
    const shown = blockers.slice(0, 8).map(formatActiveTaskRestartBlocker);
    const omitted = blockers.length - shown.length;
    return omitted > 0 ? `${shown.join("; ")}; +${omitted} more` : shown.join("; ");
  };
  const collectActiveRestartSessionKeys = () => {
    return new Set<string>(listActiveEmbeddedRunSessionKeys());
  };
  const collectActiveRestartSessionIds = () => {
    return new Set<string>(listActiveEmbeddedRunSessionIds());
  };
  const markActiveMainSessionsForRestart = async (nextConfig: OpenClawConfig, reason: string) => {
    const sessionKeys = collectActiveRestartSessionKeys();
    const sessionIds = collectActiveRestartSessionIds();
    if (sessionKeys.size === 0 && sessionIds.size === 0) {
      return;
    }
    const { markRestartAbortedMainSessions } =
      await import("../agents/main-session-restart-recovery.js");
    await markRestartAbortedMainSessions({
      cfg: nextConfig,
      additionalCfgs: [getRuntimeConfig()],
      sessionKeys,
      sessionIds,
      reason,
    });
  };
  const waitForActiveWorkBeforeChannelReload = async (
    channels: Iterable<ChannelKind>,
    nextConfig: OpenClawConfig,
  ): Promise<boolean> => {
    // Returns true when the wait was cancelled (in-process restart supersedes),
    // false when active work drained or timed out and channel reload may proceed.
    const initial = getActiveCounts();
    if (initial.totalActive <= 0) {
      return false;
    }
    const channelNames = [...channels].join(", ");
    const initialDetails = formatActiveDetails(initial);
    params.logReload.warn(
      `config change requires channel reload (${channelNames}) — deferring until ${initialDetails.join(
        ", ",
      )} complete`,
    );
    const timeoutMs = resolveGatewayRestartDeferralTimeoutMs(
      nextConfig.gateway?.reload?.deferralTimeoutMs,
    );
    const startedAt = Date.now();
    let nextStillPendingAt = startedAt + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
    while (true) {
      if (abortGeneration !== undefined && myGeneration <= abortGeneration) {
        return true;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CHANNEL_RELOAD_DEFERRAL_POLL_MS);
        timer.unref?.();
      });
      if (abortGeneration !== undefined && myGeneration <= abortGeneration) {
        return true;
      }
      const current = getActiveCounts();
      if (current.totalActive <= 0) {
        return false;
      }
      const elapsedMs = Date.now() - startedAt;
      if (timeoutMs !== undefined && elapsedMs >= timeoutMs) {
        const remaining = formatActiveDetails(current);
        params.logReload.warn(
          `channel reload timeout after ${elapsedMs}ms with ${remaining.join(
            ", ",
          )} still active; reloading channels anyway`,
        );
        return false;
      }
      if (Date.now() >= nextStillPendingAt) {
        const remaining = formatActiveDetails(current);
        params.logReload.warn(
          `channel reload still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active`,
        );
        nextStillPendingAt = Date.now() + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
      }
    }
  };

  const applyHotReload = async (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
    setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
    const state = params.getState();
    const nextState = { ...state };

    resetPreparedModelRuntimeStateForHotReload();

    if (plan.reloadHooks) {
      try {
        nextState.hooksConfig = resolveHooksConfig(nextConfig);
      } catch (err) {
        params.logHooks.warn(`hooks config reload failed: ${String(err)}`);
      }
    }
    nextState.hookClientIpConfig = resolveHookClientIpConfig(nextConfig);

    if (plan.restartHeartbeat) {
      nextState.heartbeatRunner.updateConfig(nextConfig);
    }

    resetDirectoryCache();

    const channelsToRestart = new Set(plan.restartChannels);
    const channelsStoppedBeforePluginReload = new Set<ChannelKind>();
    let activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null = null;
    let pluginReloadAborted = false;
    const shouldSkipChannelRestart = () =>
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
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
    if (plan.reloadPlugins) {
      const stopChannelsBeforePluginReplace = async (channels: ReadonlySet<ChannelKind>) => {
        for (const channel of channels) {
          channelsToRestart.add(channel);
        }
        if (channelsToRestart.size === 0 || shouldSkipChannelRestart()) {
          return;
        }
        if (await waitForActiveWorkBeforeChannelReload(channelsToRestart, nextConfig)) {
          params.logChannels.info(
            "channel reload before plugin replace cancelled by in-process restart",
          );
          pluginReloadAborted = true;
          return;
        }
        const stoppedChannels: ChannelKind[] = [];
        const stopFailures = await collectChannelOperationFailures({
          channels: channelsToRestart,
          run: async (channel) => {
            if (channelsStoppedBeforePluginReload.has(channel)) {
              return;
            }
            params.logChannels.info(`stopping ${channel} channel before plugin reload`);
            stoppedChannels.push(channel);
            await params.stopChannel(channel, undefined, { manual: false });
            channelsStoppedBeforePluginReload.add(channel);
          },
          onFailure: (channel, err) => {
            params.logChannels.error(
              `failed to stop ${channel} channel before plugin reload: ${formatErrorMessage(err)}`,
            );
          },
        });
        if (stopFailures.length > 0) {
          const rollbackFailures = await collectChannelOperationFailures({
            channels: stoppedChannels,
            run: async (channel) => {
              params.logChannels.info(
                `restarting ${channel} channel after failed plugin reload pre-stop`,
              );
              await params.startChannel(channel);
              channelsStoppedBeforePluginReload.delete(channel);
            },
            onFailure: (channel, err) => {
              params.logChannels.error(
                `failed to restart ${channel} channel after failed plugin reload pre-stop: ${formatErrorMessage(
                  err,
                )}`,
              );
            },
          });
          const rollbackSuffix =
            rollbackFailures.length > 0
              ? `; rollback restart failed for: ${rollbackFailures.join(", ")}`
              : "";
          throw new Error(
            `failed to stop channels before plugin reload: ${stopFailures.join(", ")}${rollbackSuffix}`,
          );
        }
      };
      if (!pluginReloadAborted) {
        const pluginReloadResult = await params.reloadPlugins({
          nextConfig,
          changedPaths: plan.changedPaths,
          beforeReplace: stopChannelsBeforePluginReplace,
          isAborted: () => pluginReloadAborted,
        });
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
    if (plan.restartCron) {
      params.cronReconciliation.invalidate();
      params.onCronRestart?.();
      state.cronState.cron.stop();
      state.cronState.stopExitWatchers?.();
      nextState.cronState = buildGatewayCronService({
        cfg: nextConfig,
        deps: params.deps,
        broadcast: params.broadcast,
      });
      startGatewayCronWithLogging({
        cronState: nextState.cronState,
        cronReconciliation: params.cronReconciliation,
        reason: "reload",
        config: nextConfig,
        afterStart: nextState.cronState.reconcileExitWatchers,
        logCron: params.logCron,
      });
    }

    if (plan.restartHealthMonitor) {
      state.channelHealthMonitor?.stop();
      nextState.channelHealthMonitor = params.createHealthMonitor(nextConfig);
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
      await params.stopPostReadySidecars?.();
      const restartAbortController =
        params.createGmailRestartAbortController?.() ?? new AbortController();
      try {
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
      } finally {
        params.clearGmailRestartAbortController?.(restartAbortController);
      }
    }

    if (channelsToRestart.size > 0) {
      if (shouldSkipChannelRestart()) {
        params.logChannels.info(
          "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
        );
      } else if (getChannelAutostartSuppression()) {
        let cancelledByRestart = pluginReloadAborted;
        if (!plan.reloadPlugins && !cancelledByRestart) {
          cancelledByRestart = await waitForActiveWorkBeforeChannelReload(
            channelsToRestart,
            nextConfig,
          );
        }
        if (cancelledByRestart) {
          params.logChannels.info("channel restart cancelled by in-process restart");
        } else {
          const stopFailures = await collectChannelOperationFailures({
            channels: channelsToRestart,
            run: async (channel) => {
              if (plan.reloadPlugins && activePluginChannelsAfterReload?.has(channel) === false) {
                return;
              }
              if (channelsStoppedBeforePluginReload.has(channel)) {
                return;
              }
              params.logChannels.info(`stopping ${channel} channel before suppressed hot reload`);
              await params.stopChannel(channel, undefined, { manual: false });
            },
            onFailure: (channel, err) => {
              params.logChannels.error(
                `failed to stop ${channel} channel during suppressed hot reload: ${formatErrorMessage(
                  err,
                )}`,
              );
            },
          });
          if (stopFailures.length > 0) {
            throw new Error(
              `failed to stop channels during suppressed hot reload: ${stopFailures.join(", ")}`,
            );
          }
          logSuppressedChannelRestart(channelsToRestart, "channel restart during hot reload");
        }
      } else {
        let cancelledByRestart = pluginReloadAborted;
        if (!plan.reloadPlugins && !cancelledByRestart) {
          cancelledByRestart = await waitForActiveWorkBeforeChannelReload(
            channelsToRestart,
            nextConfig,
          );
        }
        if (cancelledByRestart) {
          params.logChannels.info("channel restart cancelled by in-process restart");
        } else {
          const restartChannel = async (name: ChannelKind) => {
            if (plan.reloadPlugins && activePluginChannelsAfterReload?.has(name) === false) {
              return;
            }
            params.logChannels.info(`restarting ${name} channel`);
            if (!channelsStoppedBeforePluginReload.has(name)) {
              await params.stopChannel(name, undefined, { manual: false });
            }
            if (abortGeneration !== undefined && myGeneration <= abortGeneration) {
              return;
            }
            await params.startChannel(name);
          };
          const restartFailures = await collectChannelOperationFailures({
            channels: channelsToRestart,
            run: restartChannel,
            onFailure: (channel, err) => {
              params.logChannels.error(
                `failed to restart ${channel} channel during hot reload: ${formatErrorMessage(err)}`,
              );
            },
          });
          if (restartFailures.length > 0) {
            throw new Error(
              `failed to restart channels during hot reload: ${restartFailures.join(", ")}`,
            );
          }
        }
      }
    }

    applyGatewayLaneConcurrency(nextConfig);

    if (shouldRefreshContextWindowCache(plan)) {
      await refreshContextWindowCache(nextConfig);
      // Provider discovery is best-effort; a slow hook must not hold hot reload open.
      void loadModelCatalog({ config: nextConfig });
    }
    void warmCurrentProviderAuthStateOffMainThread(nextConfig).catch((err: unknown) => {
      params.logReload.warn(`provider auth state rewarm failed: ${String(err)}`);
    });

    if (plan.hotReasons.length > 0) {
      params.logReload.info(`config hot reload applied (${plan.hotReasons.join(", ")})`);
    } else if (plan.noopPaths.length > 0) {
      params.logReload.info(`config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`);
    }

    params.setState(nextState);
  };

  let restartPending = false;

  const requestGatewayRestart = (plan: GatewayReloadPlan, nextConfig: OpenClawConfig): boolean => {
    setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");

    if (process.listenerCount("SIGUSR1") === 0) {
      params.logReload.warn("no SIGUSR1 listener found; restart skipped");
      return false;
    }

    const active = getActiveCounts();

    if (active.totalActive > 0) {
      // Avoid spinning up duplicate polling loops from repeated config changes.
      if (restartPending) {
        params.logReload.info(
          `config change requires gateway restart (${reasons}) — already waiting for operations to complete`,
        );
        return true;
      }
      restartPending = true;
      const initialDetails = formatActiveDetails(active);
      params.logReload.warn(
        `config change requires gateway restart (${reasons}) — deferring until ${initialDetails.join(", ")} complete`,
      );
      const taskBlockers = formatTaskBlockers();
      if (taskBlockers) {
        params.logReload.warn(`restart blocked by active background task run(s): ${taskBlockers}`);
      }

      deferGatewayRestartUntilIdle({
        getPendingCount: () => getActiveCounts().totalActive,
        maxWaitMs: resolveGatewayRestartDeferralTimeoutMs(
          nextConfig.gateway?.reload?.deferralTimeoutMs,
        ),
        timeoutIntent: { force: true, reason: "config reload forced restart" },
        emitHooks: {
          beforeEmit: () =>
            markActiveMainSessionsForRestart(nextConfig, "config reload forced restart"),
        },
        hooks: {
          onReady: () => {
            restartPending = false;
            params.logReload.info("all operations and replies completed; restarting gateway now");
          },
          onStillPending: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            const taskBlockersValue = formatTaskBlockers();
            params.logReload.warn(
              `restart still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active${
                taskBlockersValue ? ` (${taskBlockersValue})` : ""
              }`,
            );
          },
          onTimeout: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            const taskBlockersLocal = formatTaskBlockers();
            restartPending = false;
            params.logReload.warn(
              `restart timeout after ${elapsedMs}ms with ${remaining.join(", ")} still active${
                taskBlockersLocal ? ` (${taskBlockersLocal})` : ""
              }; forcing restart`,
            );
          },
          onCheckError: (err) => {
            restartPending = false;
            params.logReload.warn(
              `restart deferral check failed (${String(err)}); restarting gateway now`,
            );
          },
        },
      });
      return true;
    }
    // No active operations or pending replies, restart immediately
    params.logReload.warn(`config change requires gateway restart (${reasons})`);
    // The managed reloader owns independent root admission until onRestart
    // returns. Extend that fence across signal delivery until the run loop
    // atomically promotes it to one-way restart drain.
    const emitted = emitGatewayRestartWithSignalAdmission();
    if (!emitted) {
      params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
    }
    return true;
  };

  return { applyHotReload, requestGatewayRestart };
}

export function startManagedGatewayConfigReloader(
  params: ManagedGatewayConfigReloaderParams,
): GatewayConfigReloaderHandle {
  if (params.minimalTestGateway) {
    return { stop: async () => {} };
  }

  let stopped = false;
  let activeGmailRestartAbortController: GatewayGmailRestartAbortController | null = null;
  const abortActiveGmailRestart = () => {
    activeGmailRestartAbortController?.abort();
    activeGmailRestartAbortController = null;
  };
  const createGmailRestartAbortController = (): GatewayGmailRestartAbortController => {
    abortActiveGmailRestart();
    const abortController = new AbortController();
    if (stopped) {
      abortController.abort();
      return abortController;
    }
    activeGmailRestartAbortController = abortController;
    return abortController;
  };
  const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
    deps: params.deps,
    broadcast: params.broadcast,
    getState: params.getState,
    setState: params.setState,
    startChannel: params.startChannel,
    stopChannel: params.stopChannel,
    getChannelAutostartSuppression: params.getChannelAutostartSuppression,
    stopPostReadySidecars: params.stopPostReadySidecars,
    reloadPlugins: params.reloadPlugins,
    logHooks: params.logHooks,
    logChannels: params.logChannels,
    logCron: params.logCron,
    logReload: params.logReload,
    cronReconciliation: params.cronReconciliation,
    createGmailRestartAbortController,
    clearGmailRestartAbortController: (abortController) => {
      if (activeGmailRestartAbortController === abortController) {
        activeGmailRestartAbortController = null;
      }
    },
    ...(params.onCronRestart ? { onCronRestart: params.onCronRestart } : {}),
    createHealthMonitor: (config) =>
      startGatewayChannelHealthMonitor({
        cfg: config,
        channelManager: params.channelManager,
      }),
  });

  const configReloader = startGatewayConfigReloader({
    initialConfig: params.initialConfig,
    initialCompareConfig: params.initialCompareConfig,
    initialInternalWriteHash: params.initialInternalWriteHash,
    runTransaction: runWithGatewayIndependentRootWorkAdmission,
    readSnapshot: params.readSnapshot,
    promoteSnapshot: async (snapshot, _reason) => await params.promoteSnapshot(snapshot),
    subscribeToWrites: params.subscribeToWrites,
    onConfigChange: (plan, nextConfig) => params.reconcileTerminalSessions(plan, nextConfig),
    onConfigApplied: () => params.commitTerminalConfig(),
    onNoopConfigCommit: async (_plan, nextConfig) => {
      await params.activateRuntimeSecrets(nextConfig, {
        reason: "reload",
        activate: true,
      });
    },
    onHotReload: async (plan, nextConfig) => {
      const previousSharedGatewaySessionGeneration =
        params.sharedGatewaySessionGenerationState.current;
      const previousSnapshot = getActiveSecretsRuntimeSnapshot();
      const prepared = await params.activateRuntimeSecrets(nextConfig, {
        reason: "reload",
        activate: true,
      });
      const nextSharedGatewaySessionGeneration =
        params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
      params.sharedGatewaySessionGenerationState.current = nextSharedGatewaySessionGeneration;
      const sharedGatewaySessionGenerationChanged =
        previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration;
      if (sharedGatewaySessionGenerationChanged) {
        disconnectStaleSharedGatewayAuthClients({
          clients: params.clients,
          expectedGeneration: nextSharedGatewaySessionGeneration,
        });
      }
      try {
        await applyHotReload(plan, prepared.config);
      } catch (err) {
        if (previousSnapshot) {
          await activateSecretsRuntimeSnapshot(previousSnapshot);
        } else {
          clearSecretsRuntimeSnapshot();
        }
        if (previousSnapshot && shouldRefreshContextWindowCache(plan)) {
          await refreshContextWindowCache(previousSnapshot.config);
        }
        params.sharedGatewaySessionGenerationState.current = previousSharedGatewaySessionGeneration;
        if (sharedGatewaySessionGenerationChanged) {
          disconnectStaleSharedGatewayAuthClients({
            clients: params.clients,
            expectedGeneration: previousSharedGatewaySessionGeneration,
          });
        }
        throw err;
      }
      setCurrentSharedGatewaySessionGeneration(
        params.sharedGatewaySessionGenerationState,
        nextSharedGatewaySessionGeneration,
      );
    },
    onRestart: async (plan, nextConfig) => {
      const previousRequiredSharedGatewaySessionGeneration =
        params.sharedGatewaySessionGenerationState.required;
      const previousSharedGatewaySessionGeneration =
        params.sharedGatewaySessionGenerationState.current;
      try {
        const prepared = await params.activateRuntimeSecrets(nextConfig, {
          reason: "restart-check",
          activate: false,
        });
        const nextSharedGatewaySessionGeneration =
          params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
        const restartQueued = requestGatewayRestart(plan, nextConfig);
        if (!restartQueued) {
          if (previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration) {
            await activateSecretsRuntimeSnapshot(prepared);
            setCurrentSharedGatewaySessionGeneration(
              params.sharedGatewaySessionGenerationState,
              nextSharedGatewaySessionGeneration,
            );
            params.sharedGatewaySessionGenerationState.required = null;
            disconnectStaleSharedGatewayAuthClients({
              clients: params.clients,
              expectedGeneration: nextSharedGatewaySessionGeneration,
            });
          } else {
            params.sharedGatewaySessionGenerationState.required = null;
          }
          return;
        }
        if (previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration) {
          params.sharedGatewaySessionGenerationState.required = nextSharedGatewaySessionGeneration;
          disconnectStaleSharedGatewayAuthClients({
            clients: params.clients,
            expectedGeneration: nextSharedGatewaySessionGeneration,
          });
        } else {
          params.sharedGatewaySessionGenerationState.required = null;
        }
      } catch (error) {
        params.sharedGatewaySessionGenerationState.required =
          previousRequiredSharedGatewaySessionGeneration;
        throw error;
      }
    },
    log: {
      info: (msg) => params.logReload.info(msg),
      warn: (msg) => params.logReload.warn(msg),
      error: (msg) => params.logReload.error(msg),
    },
    watchPath: params.watchPath,
  });
  return {
    stop: async () => {
      stopped = true;
      abortActiveGmailRestart();
      await configReloader.stop();
    },
    hotReloadStatus: configReloader.hotReloadStatus,
  };
}
