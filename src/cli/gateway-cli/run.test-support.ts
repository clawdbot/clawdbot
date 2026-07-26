import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import "./run.js";

type GatewayRunTestLogger = {
  info(message: string): void;
  warn(message: string): void;
};

type GatewayRunTestApi = {
  createConfiguredGatewayHealthProbe(
    cfg: OpenClawConfig,
  ): (params: { host: string; port: number }) => Promise<boolean>;
  isGatewayHealthzResponse(statusCode: number | undefined, body: string): boolean;
  normalizeGatewayHealthProbeHost(host: string): string;
  probeGatewayHealthz(params: {
    host: string;
    port: number;
    timeoutMs?: number;
    tlsFingerprint?: string;
  }): Promise<boolean>;
  resolveGatewayLockErrorExitCode(err: unknown): number;
  resolveGatewayStartupFailureExitCode(err: unknown): number;
  runGatewayLoopWithSupervisedLockRecovery(params: {
    startLoop: () => Promise<void>;
    supervisor: RespawnSupervisor | null;
    port: number;
    healthHost: string;
    log: GatewayRunTestLogger;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    probeHealth?: (params: { host: string; port: number }) => Promise<boolean>;
    retryMs?: number;
    timeoutMs?: number;
  }): Promise<void>;
};

function getTestApi(): GatewayRunTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.gatewayRunTestApi")
  ] as GatewayRunTestApi;
}

export const testing: GatewayRunTestApi = {
  createConfiguredGatewayHealthProbe(cfg) {
    return getTestApi().createConfiguredGatewayHealthProbe(cfg);
  },
  isGatewayHealthzResponse(statusCode, body) {
    return getTestApi().isGatewayHealthzResponse(statusCode, body);
  },
  normalizeGatewayHealthProbeHost(host) {
    return getTestApi().normalizeGatewayHealthProbeHost(host);
  },
  async probeGatewayHealthz(params) {
    return await getTestApi().probeGatewayHealthz(params);
  },
  resolveGatewayLockErrorExitCode(err) {
    return getTestApi().resolveGatewayLockErrorExitCode(err);
  },
  resolveGatewayStartupFailureExitCode(err) {
    return getTestApi().resolveGatewayStartupFailureExitCode(err);
  },
  async runGatewayLoopWithSupervisedLockRecovery(params) {
    await getTestApi().runGatewayLoopWithSupervisedLockRecovery(params);
  },
};
