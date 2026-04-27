import { resetModelCatalogCache } from "../agents/model-catalog.js";
import { disposeAllSessionMcpRuntimes } from "../agents/pi-bundle-mcp-tools.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CliDeps } from "../cli/deps.types.js";
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
import { getTotalQueueSize } from "../process/command-queue.js";
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
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
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

const MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS = 5_000;
const CHANNEL_RELOAD_DEFERRAL_POLL_MS = 500;
const CHANNEL_RELOAD_STILL_PENDING_WARN_MS = 30_000;

async function disposeMcpRuntimesWithTimeout(params: {
  dispose: () => Promise<void>;
  timeoutMs: number;
  onWarn: (message: string) => void;
  label: string;
}) {
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
  initialCompareConfig?: OpenClawConfig;
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
  const waitForActiveWorkBeforeChannelReload = async (
    channels: Iterable<ChannelKind>,
    nextConfig: OpenClawConfig,
  ) => {
    const initial = getActiveCounts();
    if (initial.totalActive <= 0) {
      return;
    }
    const channelNames = [...channels].join(", ");
    const initialDetails = formatActiveDetails(initial);
    params.logReload.warn(
      `config change requires channel reload (${channelNames}) — deferring until ${initialDetails.join(
        ", ",
      )} complete`,
    );
    const timeoutMsRaw = nextConfig.gateway?.reload?.deferralTimeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
        ? Math.max(CHANNEL_RELOAD_DEFERRAL_POLL_MS, Math.floor(timeoutMsRaw))
        : undefined;
    const startedAt = Date.now();
    let nextStillPendingAt = startedAt + CHANNEL_RELOAD_STILL_PENDING_WARN_MS;
    while (true) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CHANNEL_RELOAD_DEFERRAL_POLL_MS);
        timer.unref?.();
      });
      const current = getActiveCounts();
      if (current.totalActive <= 0) {
        params.logReload.info("active operations and replies completed; reloading channels now");
        return;
      }
      const elapsedMs = Date.now() - startedAt;
      if (timeoutMs !== undefined && elapsedMs >= timeoutMs) {
        const remaining = formatActiveDetails(current);
        params.logReload.warn(
          `channel reload timeout after ${elapsedMs}ms with ${remaining.join(
            ", ",
          )} still active; reloading channels anyway`,
        );
        return;
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

    if (
      plan.changedPaths.some(
        (path) =>
          path === "models" ||
          path.startsWith("models.") ||
          path === "agents.defaults.model" ||
          path.startsWith("agents.defaults.model.") ||
          path === "agents.defaults.models" ||
          path.startsWith("agents.defaults.models."),
      )
    ) {
      resetModelCatalogCache();
    }

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

    if (plan.disposeMcpRuntimes) {
      await disposeMcpRuntimesWithTimeout({
        dispose: disposeAllSessionMcpRuntimes,
        timeoutMs: MCP_RUNTIME_RELOAD_DISPOSE_TIMEOUT_MS,
        onWarn: params.logReload.warn,
        label: "bundle-mcp runtime disposal during config reload",
      });
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
        await waitForActiveWorkBeforeChannelReload(plan.restartChannels, nextConfig);
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

    applyGatewayLaneConcurrency(nextConfig);

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

      deferGatewayRestartUntilIdle({
        getPendingCount: () => getActiveCounts().totalActive,
        maxWaitMs: nextConfig.gateway?.reload?.deferralTimeoutMs,
        hooks: {
          onReady: () => {
            restartPending = false;
            params.logReload.info("all operations and replies completed; restarting gateway now");
          },
          onStillPending: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            params.logReload.warn(
              `restart still deferred after ${elapsedMs}ms with ${remaining.join(", ")} active`,
            );
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
    }
    // No active operations or pending replies, restart immediately
    params.logReload.warn(`config change requires gateway restart (${reasons})`);
    const emitted = emitGatewayRestart();
    if (!emitted) {
      params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
    }
    return true;
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
    initialCompareConfig: params.initialCompareConfig,
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
