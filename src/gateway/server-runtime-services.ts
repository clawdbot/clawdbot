// Gateway post-ready runtime services.
// Starts delayed maintenance, cron, heartbeat, recovery, and pricing refresh work.
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import {
  resolveHeartbeatAgents,
  startHeartbeatRunner,
  type HeartbeatRunner,
} from "../infra/heartbeat-runner.js";
import { resolveHeartbeatIntervalMs } from "../infra/heartbeat-summary.js";
import {
  schedulePendingSessionDeliveries,
  startSessionDeliveryRuntime,
} from "../infra/session-delivery-queue-runtime.js";
import type { PluginMetadataRegistryView } from "../plugins/plugin-metadata-snapshot.types.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { startSessionUpstreamMonitor } from "../sessions/session-upstream-monitor.js";
import { removeCronRunContinuationSessionIfIdle } from "../tasks/cron-run-continuation-cleanup.js";
import { isGatewayModelPricingEnabled } from "./model-pricing-config.js";
import type { GatewayCronReconciliation } from "./server-cron-reconciled.js";
import type { GatewayCronState } from "./server-cron.js";
import type { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import {
  createNoopHeartbeatRunner,
  type GatewayRuntimeServiceLogger,
} from "./server-runtime-service-shared.js";
export {
  startGatewayChannelHealthMonitor,
  startGatewayRuntimeServices,
  type GatewayChannelManager,
} from "./server-runtime-startup-services.js";

type GatewayPostReadyLogger = {
  warn: (message: string) => void;
};
export type GatewayIdleTaskHandle = {
  stop: () => void;
};
export type GatewayMaintenanceHandles = NonNullable<
  Awaited<ReturnType<typeof startGatewayMaintenanceTimers>>
>;

/** Starts cron without making the surrounding startup or reload transaction wait. */
export function startGatewayCronWithLogging(params: {
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  reason: "startup" | "reload";
  config: OpenClawConfig;
  afterStart?: () => Promise<void>;
  onStartError?: (error: unknown) => void;
  logCron: { error: (message: string) => void };
}): void {
  const reconciliation = params.cronReconciliation.arm({
    reason: params.reason,
    config: params.config,
    cronState: params.cronState,
  });
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    try {
      await params.cronState.cron.start();
      await params.afterStart?.();
      await reconciliation.complete();
    } catch (err) {
      params.logCron.error(`failed to start: ${String(err)}`);
      // Recovery callbacks must run before this independent root releases its
      // admission fence; restart and suspension cannot race past this point.
      params.onStartError?.(err);
    }
  }).catch((err: unknown) => params.logCron.error(`failed to enter start root: ${String(err)}`));
}

function clearGatewayMaintenanceHandles(maintenance: GatewayMaintenanceHandles | null): void {
  if (!maintenance) {
    return;
  }
  // Maintenance startup can race shutdown. Clear every interval handle here so
  // callers can discard partially-created maintenance safely.
  clearInterval(maintenance.tickInterval);
  clearInterval(maintenance.healthInterval);
  clearInterval(maintenance.dedupeCleanup);
  clearInterval(maintenance.worktreeCleanup);
  if (maintenance.mediaCleanup) {
    clearInterval(maintenance.mediaCleanup);
  }
  maintenance.skillCuratorCleanup();
}

/** Runs maintenance that is intentionally delayed until after the gateway is ready. */
export async function runGatewayPostReadyMaintenance(params: {
  startMaintenance: () => Promise<GatewayMaintenanceHandles | null>;
  applyMaintenance: (maintenance: GatewayMaintenanceHandles) => void;
  shouldStartCron: () => boolean;
  markCronStartHandled: () => void;
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  cronConfig: OpenClawConfig;
  logCron: { error: (message: string) => void };
  log: GatewayPostReadyLogger;
  recordPostReadyMemory: () => void;
}): Promise<void> {
  try {
    const maintenance = await params.startMaintenance();
    if (maintenance) {
      params.applyMaintenance(maintenance);
    }
  } catch (err) {
    params.log.warn(`gateway post-ready maintenance startup failed: ${String(err)}`);
  }
  if (params.shouldStartCron()) {
    params.markCronStartHandled();
    startGatewayCronWithLogging({
      cronState: params.cronState,
      cronReconciliation: params.cronReconciliation,
      reason: "startup",
      config: params.cronConfig,
      logCron: params.logCron,
    });
  }
  params.recordPostReadyMemory();
}

/** Schedules post-ready maintenance and cancels/cleans handles if shutdown wins the race. */
export function scheduleGatewayPostReadyMaintenance(params: {
  delayMs: number;
  isClosing: () => boolean;
  onStarted?: () => void;
  startMaintenance: () => Promise<GatewayMaintenanceHandles | null>;
  applyMaintenance: (maintenance: GatewayMaintenanceHandles) => void;
  shouldStartCron: () => boolean;
  markCronStartHandled: () => void;
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  cronConfig: OpenClawConfig;
  logCron: { error: (message: string) => void };
  log: GatewayPostReadyLogger;
  recordPostReadyMemory: () => void;
}): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    params.onStarted?.();
    if (params.isClosing()) {
      return;
    }
    void runWithGatewayIndependentRootWorkAdmission(async () =>
      runGatewayPostReadyMaintenance({
        startMaintenance: async () => {
          if (params.isClosing()) {
            return null;
          }
          const maintenance = await params.startMaintenance();
          if (params.isClosing()) {
            // Maintenance can allocate intervals before shutdown is observed; clear them here
            // instead of handing live timers to a closing gateway.
            clearGatewayMaintenanceHandles(maintenance);
            return null;
          }
          return maintenance;
        },
        applyMaintenance: (maintenance) => {
          if (params.isClosing()) {
            clearGatewayMaintenanceHandles(maintenance);
            return;
          }
          params.applyMaintenance(maintenance);
        },
        shouldStartCron: () => !params.isClosing() && params.shouldStartCron(),
        markCronStartHandled: params.markCronStartHandled,
        cronState: params.cronState,
        cronReconciliation: params.cronReconciliation,
        cronConfig: params.cronConfig,
        logCron: params.logCron,
        log: params.log,
        recordPostReadyMemory: () => {
          if (!params.isClosing()) {
            params.recordPostReadyMemory();
          }
        },
      }),
    ).catch((err: unknown) =>
      params.log.warn(`gateway post-ready maintenance deferred task failed: ${String(err)}`),
    );
  }, params.delayMs);
  timer.unref?.();
  return timer;
}

/** Schedules one low-priority task, retrying until the gateway has no active request roots. */
export function scheduleGatewayIdleTask(params: {
  delayMs: number;
  retryDelayMs: number;
  isClosing: () => boolean;
  isBusy: () => boolean;
  run: () => Promise<void>;
  log: GatewayPostReadyLogger;
  errorMessage: string;
}): GatewayIdleTaskHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number) => {
    if (stopped || params.isClosing()) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (stopped || params.isClosing()) {
        return;
      }
      if (params.isBusy()) {
        schedule(params.retryDelayMs);
        return;
      }
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        if (stopped || params.isClosing()) {
          return;
        }
        // Recheck inside admission so work that arrived while this task was
        // joining the root set gets priority over non-urgent maintenance.
        if (params.isBusy()) {
          schedule(params.retryDelayMs);
          return;
        }
        await params.run();
      }).catch((error: unknown) => params.log.warn(`${params.errorMessage}: ${String(error)}`));
    }, delayMs);
    timer.unref?.();
  };
  schedule(params.delayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function recoverPendingOutboundDeliveries(params: {
  cfg: OpenClawConfig;
  log: GatewayRuntimeServiceLogger;
}): void {
  // Recovery is best-effort background work; startup must continue even if outbound modules fail
  // to import or queued delivery replay fails.
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    const { recoverPendingDeliveries } = await import("../infra/outbound/delivery-queue.js");
    const { deliverOutboundPayloadsInternal } = await import("../infra/outbound/deliver.js");
    const logRecovery = params.log.child("delivery-recovery");
    await recoverPendingDeliveries({
      deliver: deliverOutboundPayloadsInternal,
      log: logRecovery,
      cfg: params.cfg,
    });
  }).catch((err: unknown) => params.log.error(`Delivery recovery failed: ${String(err)}`));
}

function startPendingSessionDeliveryRuntime(params: {
  deps: import("../cli/deps.types.js").CliDeps;
  log: GatewayRuntimeServiceLogger;
  maxEnqueuedAt: number;
}): () => void {
  let stopped = false;
  let stopRuntime: (() => void) | undefined;
  // Delay session continuation recovery so the gateway has time to publish ready state and
  // request routing before replaying restart-sentinel deliveries.
  const timer = setTimeout(() => {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      const { deliverQueuedSessionDelivery, recoverPendingRestartContinuationDeliveries } =
        await import("./server-restart-sentinel.js");
      if (stopped) {
        return;
      }
      const logRecovery = params.log.child("session-delivery-recovery");
      stopRuntime = startSessionDeliveryRuntime({
        deliver: (entry, context = {}) =>
          deliverQueuedSessionDelivery({
            deps: params.deps,
            entry,
            ...(context.stateDir !== undefined ? { stateDir: context.stateDir } : {}),
          }),
        log: logRecovery,
        onSettled: (entry) => removeCronRunContinuationSessionIfIdle(entry.sessionKey, entry.id),
      });
      try {
        await recoverPendingRestartContinuationDeliveries({
          deps: params.deps,
          log: logRecovery,
          maxEnqueuedAt: params.maxEnqueuedAt,
        });
      } finally {
        // Recovery and scheduling are independent safeguards. A transient
        // recovery failure must not leave persisted rows without timers.
        await schedulePendingSessionDeliveries();
      }
    }).catch((err: unknown) =>
      params.log.error(`Session delivery recovery failed: ${String(err)}`),
    );
  }, 1_250);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
    stopRuntime?.();
    stopRuntime = undefined;
  };
}

function startGatewayModelPricingRefreshOnDemand(params: {
  config: OpenClawConfig;
  pluginLookUpTable?: PluginMetadataRegistryView;
  log: GatewayRuntimeServiceLogger;
}): () => void {
  if (!isGatewayModelPricingEnabled(params.config)) {
    return () => {};
  }
  let stopped = false;
  let stopRefresh: (() => void) | undefined;
  // Import pricing refresh lazily; many gateway starts never use model-pricing metadata.
  // The stopped flag closes the race where shutdown happens before the import resolves.
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    const { startGatewayModelPricingRefresh } = await import("./model-pricing-cache.js");
    if (stopped) {
      return;
    }
    stopRefresh = startGatewayModelPricingRefresh({
      config: params.config,
      ...(params.pluginLookUpTable ? { pluginLookUpTable: params.pluginLookUpTable } : {}),
    });
    if (stopped) {
      stopRefresh();
      stopRefresh = undefined;
    }
  }).catch((err: unknown) =>
    params.log.error(`Model pricing refresh failed to start: ${String(err)}`),
  );
  return () => {
    stopped = true;
    stopRefresh?.();
    stopRefresh = undefined;
  };
}

/** Activates background gateway services after core runtime startup is ready. */
export function activateGatewayScheduledServices(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  deps: import("../cli/deps.types.js").CliDeps;
  sessionDeliveryRecoveryMaxEnqueuedAt: number;
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  startCron?: boolean;
  logCron: { error: (message: string) => void };
  log: GatewayRuntimeServiceLogger;
  pluginLookUpTable?: PluginMetadataRegistryView;
}): { heartbeatRunner: HeartbeatRunner; stopModelPricingRefresh: () => void } {
  if (params.minimalTestGateway) {
    // Minimal gateways keep handles callable but inert so tests can share shutdown paths with
    // production starts without launching background loops.
    return {
      heartbeatRunner: createNoopHeartbeatRunner(),
      stopModelPricingRefresh: () => {},
    };
  }
  if (
    !params.cronState.cronEnabled &&
    resolveHeartbeatAgents(params.cfgAtStart).some((agent) =>
      Boolean(resolveHeartbeatIntervalMs(params.cfgAtStart, undefined, agent.heartbeat)),
    )
  ) {
    params.log
      .child("heartbeat")
      .warn(
        "scheduled heartbeats are disabled because the cron scheduler is disabled; enable cron and restart the gateway",
      );
  }
  const heartbeatRunner = startHeartbeatRunner({
    cfg: params.cfgAtStart,
    readCurrentConfig: getRuntimeConfig,
  });
  const sessionUpstreamMonitor = startSessionUpstreamMonitor();
  const stopSessionDeliveryRuntime = startPendingSessionDeliveryRuntime({
    deps: params.deps,
    log: params.log,
    maxEnqueuedAt: params.sessionDeliveryRecoveryMaxEnqueuedAt,
  });
  const heartbeatRunnerWithUpstreamMonitor: HeartbeatRunner = {
    updateConfig: heartbeatRunner.updateConfig,
    stop: () => {
      stopSessionDeliveryRuntime();
      sessionUpstreamMonitor.stop();
      heartbeatRunner.stop();
    },
  };
  if (params.startCron !== false) {
    startGatewayCronWithLogging({
      cronState: params.cronState,
      cronReconciliation: params.cronReconciliation,
      reason: "startup",
      config: params.cfgAtStart,
      logCron: params.logCron,
    });
  }
  recoverPendingOutboundDeliveries({
    cfg: params.cfgAtStart,
    log: params.log,
  });
  const stopModelPricingRefresh = !isVitestRuntimeEnv()
    ? startGatewayModelPricingRefreshOnDemand({
        config: params.cfgAtStart,
        ...(params.pluginLookUpTable ? { pluginLookUpTable: params.pluginLookUpTable } : {}),
        log: params.log,
      })
    : () => {};
  return {
    heartbeatRunner: heartbeatRunnerWithUpstreamMonitor,
    stopModelPricingRefresh,
  };
}
