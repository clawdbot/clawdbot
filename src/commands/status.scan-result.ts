// Normalized full status scan result shape.
// Builders flatten the gateway snapshot so downstream text/JSON code reads one stable object.

import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { getStatusSummary as getStatusSummaryFn } from "../status/summary.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";

type StatusScanGatewayResult = Omit<
  StatusScanOverviewResult["gatewaySnapshot"],
  "gatewayCallOverrides"
>;

export type StatusScanResult = Omit<
  StatusScanOverviewResult,
  | "coldStart"
  | "hasConfiguredChannels"
  | "skipColdStartNetworkChecks"
  | "gatewaySnapshot"
  | "channelsStatus"
  | "runtimeDegradation"
> &
  StatusScanGatewayResult & {
    summary: Awaited<ReturnType<typeof getStatusSummaryFn>>;
    memory: MemoryStatusSnapshot | null;
    memoryPlugin: MemoryPluginStatus;
    pluginCompatibility: PluginCompatibilityNotice[];
  };

/** Flattens overview, gateway, channel, summary, memory, and compatibility inputs into a scan result. */
export function buildStatusScanResult(
  params: Omit<StatusScanResult, keyof StatusScanGatewayResult> & {
    gatewaySnapshot: StatusScanGatewayResult;
  },
): StatusScanResult {
  const { gatewaySnapshot, advertisedControlUiLinks, ...result } = params;
  return {
    ...result,
    ...(advertisedControlUiLinks ? { advertisedControlUiLinks } : {}),
    gatewayConnection: gatewaySnapshot.gatewayConnection,
    remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
    gatewayMode: gatewaySnapshot.gatewayMode,
    gatewayProbeAuth: gatewaySnapshot.gatewayProbeAuth,
    gatewayProbeAuthWarning: gatewaySnapshot.gatewayProbeAuthWarning,
    gatewayProbe: gatewaySnapshot.gatewayProbe,
    gatewayReachable: gatewaySnapshot.gatewayReachable,
    gatewaySelf: gatewaySnapshot.gatewaySelf,
  };
}
