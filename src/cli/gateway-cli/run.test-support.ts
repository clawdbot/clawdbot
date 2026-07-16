import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import "./run.js";

type GatewayRunTestLogger = {
  info(message: string): void;
  warn(message: string): void;
};

type GatewayRunTestApi = {
  normalizeGatewayHealthProbeHost(host: string): string;
  resolveGatewayLockErrorExitCode(err: unknown, supervisor: RespawnSupervisor | null): number;
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
  normalizeGatewayHealthProbeHost(host) {
    return getTestApi().normalizeGatewayHealthProbeHost(host);
  },
  resolveGatewayLockErrorExitCode(err, supervisor) {
    return getTestApi().resolveGatewayLockErrorExitCode(err, supervisor);
  },
  resolveGatewayStartupFailureExitCode(err) {
    return getTestApi().resolveGatewayStartupFailureExitCode(err);
  },
  async runGatewayLoopWithSupervisedLockRecovery(params) {
    await getTestApi().runGatewayLoopWithSupervisedLockRecovery(params);
  },
};
