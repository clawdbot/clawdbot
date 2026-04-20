import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import { stopGmailWatcher } from "../hooks/gmail-watcher.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  deferGatewayRestartUntilIdle,
  emitGatewayRestart,
  setGatewaySigusr1RestartPolicy,
} from "../infra/restart.js";
import { setCommandLaneConcurrency, getTotalQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { getInspectableTaskRegistrySummary } from "../tasks/task-registry.maintenance.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import { enqueueConfigRecoveryNotice } from "./config-recovery-notice.js";
import type { ChannelKind } from "./config-reload-plan.js";
import { startGatewayConfigReloader, type GatewayReloadPlan } from "./config-reload.js";
import { resolveHooksConfig } from "./hooks.js";
import { buildGatewayCronService, type GatewayCronState } from "./server-cron.js";
import type { HookClientIpConfig } from "./server-http.js";
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
import { resolveHookClientIpConfig } from "./server/hooks.js";

type GatewayHotReloadState = {
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  hookClientIpConfig: HookClientIpConfig;
  heartbeatRunner: HeartbeatRunner;
  cronState: GatewayCronState;
  channelHealthMonitor: ChannelHealthMonitor | null;
};

type GatewayReloadLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type GatewayReloadHandlerParams = {
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  getState: () => GatewayHotReloadState;
  setState: (state: GatewayHotReloadState) => void;
  startChannel: (name: ChannelKind) => Promise<void>;
  stopChannel: (name: ChannelKind) => Promise<void>;
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logCron: { error: (msg: string) => void };
  logReload: GatewayReloadLog;
  createHealthMonitor: (config: OpenClawConfig) => ChannelHealthMonitor | null;
};

type ManagedGatewayConfigReloaderParams = Omit<
  GatewayReloadHandlerParams,
  "createHealthMonitor" | "logReload"
> & {
  minimalTestGateway: boolean;
  initialConfig: OpenClawConfig;
  initialInternalWriteHash: string | null;
  watchPath: string;
  readSnapshot: typeof import("../config/config.js").readConfigFileSnapshot;
  recoverSnapshot: typeof import("../config/config.js").recoverConfigFromLastKnownGood;
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
};

export function createGatewayReloadHandlers(params: GatewayReloadHandlerParams) {
  const applyHotReload = async (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
    setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
    const state = params.getState();
    const nextState = { ...state };

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

    if (plan.restartCron) {
      state.cronState.cron.stop();
      nextState.cronState = buildGatewayCronService({
        cfg: nextConfig,
        deps: params.deps,
        broadcast: params.broadcast,
      });
      startGatewayCronWithLogging({
        cron: nextState.cronState.cron,
        logCron: params.logCron,
      });
    }

    if (plan.restartHealthMonitor) {
      state.channelHealthMonitor?.stop();
      nextState.channelHealthMonitor = params.createHealthMonitor(nextConfig);
    }

    if (plan.restartGmailWatcher) {
      await stopGmailWatcher().catch((err) => {
        params.logHooks.warn(`gmail watcher stop failed during reload: ${String(err)}`);
      });
      await startGmailWatcherWithLogs({
        cfg: nextConfig,
        log: params.logHooks,
        onSkipped: () =>
          params.logHooks.info("skipping gmail watcher restart (OPENCLAW_SKIP_GMAIL_WATCHER=1)"),
      });
    }

    if (plan.restartChannels.size > 0) {
      if (
        isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
        isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)
      ) {
        params.logChannels.info(
          "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
        );
      } else {
        const restartChannel = async (name: ChannelKind) => {
          params.logChannels.info(`restarting ${name} channel`);
          await params.stopChannel(name);
          await params.startChannel(name);
        };
        for (const channel of plan.restartChannels) {
          await restartChannel(channel);
        }
      }
    }

    setCommandLaneConcurrency(CommandLane.Cron, nextConfig.cron?.maxConcurrentRuns ?? 1);
    setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(nextConfig));
    setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(nextConfig));

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

    const getActiveCounts = () => {
      const queueSize = getTotalQueueSize();
      const pendingReplies = getTotalPendingReplies();
      const embeddedRuns = getActiveEmbeddedRunCount();
      const activeTasks = getInspectableTaskRegistrySummary().active;
      return {
        queueSize,
        pendingReplies,
        embeddedRuns,
        activeTasks,
        totalActive: queueSize + pendingReplies + embeddedRuns + activeTasks,
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
      if (counts.activeTasks > 0) {
        details.push(`${counts.activeTasks} task run(s)`);
      }
      return details;
    };
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

      deferGatewayRestartUntilIdle({
        getPendingCount: () => getActiveCounts().totalActive,
        maxWaitMs: nextConfig.gateway?.reload?.deferralTimeoutMs,
        hooks: {
          onReady: () => {
            restartPending = false;
            params.logReload.info("all operations and replies completed; restarting gateway now");
          },
          onTimeout: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            restartPending = false;
            params.logReload.warn(
              `restart timeout after ${elapsedMs}ms with ${remaining.join(", ")} still active; restarting anyway`,
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
    } else {
      // No active operations or pending replies, restart immediately
      params.logReload.warn(`config change requires gateway restart (${reasons})`);
      const emitted = emitGatewayRestart();
      if (!emitted) {
        params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
      }
      return true;
    }
  };

  return { applyHotReload, requestGatewayRestart };
}

export function startManagedGatewayConfigReloader(params: ManagedGatewayConfigReloaderParams) {
  if (params.minimalTestGateway) {
    return { stop: async () => {} };
  }

  const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
    deps: params.deps,
    broadcast: params.broadcast,
    getState: params.getState,
    setState: params.setState,
    startChannel: params.startChannel,
    stopChannel: params.stopChannel,
    logHooks: params.logHooks,
    logChannels: params.logChannels,
    logCron: params.logCron,
    logReload: params.logReload,
    createHealthMonitor: (config) =>
      startGatewayChannelHealthMonitor({
        cfg: config,
        channelManager: params.channelManager,
      }),
  });

  return startGatewayConfigReloader({
    initialConfig: params.initialConfig,
    initialInternalWriteHash: params.initialInternalWriteHash,
    readSnapshot: params.readSnapshot,
    recoverSnapshot: async (snapshot, reason) =>
      await params.recoverSnapshot({ snapshot, reason: `reload-${reason}` }),
    promoteSnapshot: async (snapshot, _reason) => await params.promoteSnapshot(snapshot),
    onRecovered: ({ reason, snapshot, recoveredSnapshot }) => {
      enqueueConfigRecoveryNotice({
        cfg: recoveredSnapshot.config,
        phase: "reload",
        reason: `reload-${reason}`,
        configPath: snapshot.path,
      });
    },
    subscribeToWrites: params.subscribeToWrites,
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
          activateSecretsRuntimeSnapshot(previousSnapshot);
        } else {
          clearSecretsRuntimeSnapshot();
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
            activateSecretsRuntimeSnapshot(prepared);
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
}
