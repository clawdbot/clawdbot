import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { startGatewayModelPricingRefresh } from "./model-pricing-cache.js";

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

export function startGatewayRuntimeServices(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  channelManager: GatewayChannelManager;
  cron: { start: () => Promise<void> };
  logCron: { error: (message: string) => void };
  log: GatewayRuntimeServiceLogger;
}): {
  heartbeatRunner: HeartbeatRunner;
  channelHealthMonitor: ChannelHealthMonitor | null;
  stopModelPricingRefresh: () => void;
} {
  const heartbeatRunner = params.minimalTestGateway
    ? createNoopHeartbeatRunner()
    : startHeartbeatRunner({ cfg: params.cfgAtStart });
  const channelHealthMonitor = startGatewayChannelHealthMonitor({
    cfg: params.cfgAtStart,
    channelManager: params.channelManager,
  });

  if (!params.minimalTestGateway) {
    startGatewayCronWithLogging({
      cron: params.cron,
      logCron: params.logCron,
    });
    recoverPendingOutboundDeliveries({
      cfg: params.cfgAtStart,
      log: params.log,
    });
  }

  return {
    heartbeatRunner,
    channelHealthMonitor,
    stopModelPricingRefresh:
      !params.minimalTestGateway && process.env.VITEST !== "1"
        ? startGatewayModelPricingRefresh({ config: params.cfgAtStart })
        : () => {},
  };
}
