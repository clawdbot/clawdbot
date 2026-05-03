import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { PluginMetadataRegistryView } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { isGatewayModelPricingEnabled } from "./model-pricing-config.js";

type GatewayRuntimeServiceLogger = {
  child: (name: string) => {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  error: (message: string) => void;
};

export type GatewayChannelManager = Parameters<
  typeof startChannelHealthMonitor
>[0]["channelManager"];

function createNoopHeartbeatRunner(): HeartbeatRunner {
  return {
    stop: () => {},
    updateConfig: (_cfg: OpenClawConfig) => {},
  };
}

export function startGatewayChannelHealthMonitor(params: {
  cfg: OpenClawConfig;
  channelManager: GatewayChannelManager;
}): ChannelHealthMonitor | null {
  const healthCheckMinutes = params.cfg.gateway?.channelHealthCheckMinutes;
  if (healthCheckMinutes === 0) {
    return null;
  }
  const staleEventThresholdMinutes = params.cfg.gateway?.channelStaleEventThresholdMinutes;
  const maxRestartsPerHour = params.cfg.gateway?.channelMaxRestartsPerHour;
  return startChannelHealthMonitor({
    channelManager: params.channelManager,
    checkIntervalMs: (healthCheckMinutes ?? 5) * 60_000,
    ...(staleEventThresholdMinutes != null && {
      staleEventThresholdMs: staleEventThresholdMinutes * 60_000,
    }),
    ...(maxRestartsPerHour != null && { maxRestartsPerHour }),
  });
}

export function startGatewayCronWithLogging(params: {
  cron: { start: () => Promise<void> };
  logCron: { error: (message: string) => void };
}): void {
  void params.cron.start().catch((err) => params.logCron.error(`failed to start: ${String(err)}`));
}

function recoverPendingOutboundDeliveries(params: {
  cfg: OpenClawConfig;
  log: GatewayRuntimeServiceLogger;
}): void {
  void (async () => {
    const { recoverPendingDeliveries } = await import("../infra/outbound/delivery-queue.js");
    const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
    const logRecovery = params.log.child("delivery-recovery");
    await recoverPendingDeliveries({
      deliver: deliverOutboundPayloads,
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

export function startGatewayRuntimeServices(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  channelManager: GatewayChannelManager;
  log: GatewayRuntimeServiceLogger;
}): {
  heartbeatRunner: HeartbeatRunner;
  channelHealthMonitor: ChannelHealthMonitor | null;
  stopModelPricingRefresh: () => void;
} {
  const channelHealthMonitor = startGatewayChannelHealthMonitor({
    cfg: params.cfgAtStart,
    channelManager: params.channelManager,
  });

  return {
    heartbeatRunner: createNoopHeartbeatRunner(),
    channelHealthMonitor,
    stopModelPricingRefresh: () => {},
  };
}

export function activateGatewayScheduledServices(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  deps: import("../cli/deps.types.js").CliDeps;
  sessionDeliveryRecoveryMaxEnqueuedAt: number;
  cron: { start: () => Promise<void> };
  logCron: { error: (message: string) => void };
  log: GatewayRuntimeServiceLogger;
  pluginLookUpTable?: PluginMetadataRegistryView;
}): { heartbeatRunner: HeartbeatRunner; stopModelPricingRefresh: () => void } {
  if (params.minimalTestGateway) {
    return { heartbeatRunner: createNoopHeartbeatRunner(), stopModelPricingRefresh: () => {} };
  }
  const heartbeatRunner = startHeartbeatRunner({ cfg: params.cfgAtStart });
  startGatewayCronWithLogging({
    cron: params.cron,
    logCron: params.logCron,
  });
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
