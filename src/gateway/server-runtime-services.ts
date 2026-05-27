import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { PluginMetadataRegistryView } from "../plugins/plugin-metadata-snapshot.types.js";
import { isGatewayModelPricingEnabled } from "./model-pricing-config.js";
import type { startGatewayMaintenanceTimers } from "./server-maintenance.js";
export {
  startGatewayChannelHealthMonitor,
  startGatewayRuntimeServices,
  type GatewayChannelManager,
} from "./server-runtime-startup-services.js";

type GatewayRuntimeServiceLogger = {
  child: (name: string) => {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  error: (message: string) => void;
};
type GatewayPostReadyLogger = {
  warn: (message: string) => void;
};
export type GatewayMaintenanceHandles = NonNullable<
  Awaited<ReturnType<typeof startGatewayMaintenanceTimers>>
>;

function createNoopHeartbeatRunner(): HeartbeatRunner {
  return {
    stop: () => {},
    updateConfig: (_cfg: OpenClawConfig) => {},
  };
}

export function startGatewayCronWithLogging(params: {
  cron: { start: () => Promise<void> };
  logCron: { error: (message: string) => void };
}): void {
  void params.cron.start().catch((err) => params.logCron.error(`failed to start: ${String(err)}`));
}

function clearGatewayMaintenanceHandles(maintenance: GatewayMaintenanceHandles | null): void {
  if (!maintenance) {
    return;
  }
  clearInterval(maintenance.tickInterval);
  clearInterval(maintenance.healthInterval);
  clearInterval(maintenance.dedupeCleanup);
  if (maintenance.mediaCleanup) {
    clearInterval(maintenance.mediaCleanup);
  }
}

export async function runGatewayPostReadyMaintenance(params: {
  startMaintenance: () => Promise<GatewayMaintenanceHandles | null>;
  applyMaintenance: (maintenance: GatewayMaintenanceHandles) => void;
  shouldStartCron: () => boolean;
  markCronStartHandled: () => void;
  cron: { start: () => Promise<void> };
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
      cron: params.cron,
      logCron: params.logCron,
    });
  }
  params.recordPostReadyMemory();
}

export function scheduleGatewayPostReadyMaintenance(params: {
  delayMs: number;
  isClosing: () => boolean;
  onStarted?: () => void;
  startMaintenance: () => Promise<GatewayMaintenanceHandles | null>;
  applyMaintenance: (maintenance: GatewayMaintenanceHandles) => void;
  shouldStartCron: () => boolean;
  markCronStartHandled: () => void;
  cron: { start: () => Promise<void> };
  logCron: { error: (message: string) => void };
  log: GatewayPostReadyLogger;
  recordPostReadyMemory: () => void;
}): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    params.onStarted?.();
    if (params.isClosing()) {
      return;
    }
    void runGatewayPostReadyMaintenance({
      startMaintenance: async () => {
        if (params.isClosing()) {
          return null;
        }
        const maintenance = await params.startMaintenance();
        if (params.isClosing()) {
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
      cron: params.cron,
      logCron: params.logCron,
      log: params.log,
      recordPostReadyMemory: () => {
        if (!params.isClosing()) {
          params.recordPostReadyMemory();
        }
      },
    });
  }, params.delayMs);
  timer.unref?.();
  return timer;
}

function recoverPendingOutboundDeliveries(params: {
  cfg: OpenClawConfig;
  log: GatewayRuntimeServiceLogger;
}): void {
  void (async () => {
    const { recoverPendingDeliveries } = await import("../infra/outbound/delivery-queue.js");
    const { deliverOutboundPayloadsInternal } = await import("../infra/outbound/deliver.js");
    const logRecovery = params.log.child("delivery-recovery");
    await recoverPendingDeliveries({
      deliver: deliverOutboundPayloadsInternal,
      log: logRecovery,
      cfg: params.cfg,
    });
  })().catch((err) => params.log.error(`Delivery recovery failed: ${String(err)}`));
}

function recoverPendingSessionDeliveries(params: {
  deps: import("../cli/deps.types.js").CliDeps;
  log: GatewayRuntimeServiceLogger;
  maxEnqueuedAt: number;
}): void {
  const timer = setTimeout(() => {
    void (async () => {
      const { recoverPendingRestartContinuationDeliveries } =
        await import("./server-restart-sentinel.js");
      const logRecovery = params.log.child("session-delivery-recovery");
      await recoverPendingRestartContinuationDeliveries({
        deps: params.deps,
        log: logRecovery,
        maxEnqueuedAt: params.maxEnqueuedAt,
      });
    })().catch((err) => params.log.error(`Session delivery recovery failed: ${String(err)}`));
  }, 1_250);
  timer.unref?.();
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
  void (async () => {
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
  })().catch((err) => params.log.error(`Model pricing refresh failed to start: ${String(err)}`));
  return () => {
    stopped = true;
    stopRefresh?.();
    stopRefresh = undefined;
  };
}

export function activateGatewayScheduledServices(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  deps: import("../cli/deps.types.js").CliDeps;
  sessionDeliveryRecoveryMaxEnqueuedAt: number;
  cron: { start: () => Promise<void> };
  startCron?: boolean;
  logCron: { error: (message: string) => void };
  log: GatewayRuntimeServiceLogger;
  pluginLookUpTable?: PluginMetadataRegistryView;
}): { heartbeatRunner: HeartbeatRunner; stopModelPricingRefresh: () => void } {
  if (params.minimalTestGateway) {
    return { heartbeatRunner: createNoopHeartbeatRunner(), stopModelPricingRefresh: () => {} };
  }
  const heartbeatRunner = startHeartbeatRunner({ cfg: params.cfgAtStart });
  if (params.startCron !== false) {
    startGatewayCronWithLogging({
      cron: params.cron,
      logCron: params.logCron,
    });
  }
  recoverPendingOutboundDeliveries({
    cfg: params.cfgAtStart,
    log: params.log,
  });
  recoverPendingSessionDeliveries({
    deps: params.deps,
    log: params.log,
    maxEnqueuedAt: params.sessionDeliveryRecoveryMaxEnqueuedAt,
  });
  const stopModelPricingRefresh = !isVitestRuntimeEnv()
    ? startGatewayModelPricingRefreshOnDemand({
        config: params.cfgAtStart,
        ...(params.pluginLookUpTable ? { pluginLookUpTable: params.pluginLookUpTable } : {}),
        log: params.log,
      })
    : () => {};
  return { heartbeatRunner, stopModelPricingRefresh };
}
