import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { PluginHealthErrorSummary } from "../../gateway/health/types.js";
import type { PortUsage } from "../../infra/ports.js";

export type GatewayRestartWaitOutcome =
  | "healthy"
  | "plugin-errors"
  | "channel-errors"
  | "version-mismatch"
  | "build-id-mismatch"
  | "stale-pids"
  | "stopped-free"
  | "timeout";

export type GatewayRestartSnapshot = {
  runtime: GatewayServiceRuntime;
  portUsage: PortUsage;
  healthy: boolean;
  staleGatewayPids: number[];
  gatewayVersion?: string | null;
  gatewayBuildId?: string | null;
  probeError?: string;
  activatedPluginErrors?: PluginHealthErrorSummary[];
  channelProbeErrors?: Array<{ id: string; error: string }>;
  expectedVersion?: string;
  versionMismatch?: {
    expected: string;
    actual: string | null;
  };
  expectedBuildId?: string;
  buildIdMismatch?: {
    expected: string;
    actual: string | null;
  };
  waitOutcome?: GatewayRestartWaitOutcome;
  elapsedMs?: number;
};

export type GatewayPortHealthSnapshot = {
  portUsage: PortUsage;
  healthy: boolean;
  probeError?: string;
};
