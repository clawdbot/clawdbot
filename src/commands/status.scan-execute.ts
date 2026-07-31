// Converts a shared status overview scan into the full status scan result.
// Memory and summary collection run in parallel after the common gateway/config scan has completed.

import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import { resolveStatusSummaryFromOverview } from "./status.scan-overview.ts";
import { buildStatusScanResult, type StatusScanResult } from "./status.scan-result.ts";
import {
  resolveMemoryPluginStatus,
  type MemoryPluginStatus,
  type MemoryStatusSnapshot,
} from "./status.scan.shared.js";

/** Builds a full status scan result from an overview scan plus channel/plugin compatibility data. */
export async function executeStatusScanFromOverview(params: {
  overview: StatusScanOverviewResult;
  runtime?: RuntimeEnv;
  resolveMemory: (args: {
    cfg: StatusScanOverviewResult["cfg"];
    agentStatus: StatusScanOverviewResult["agentStatus"];
    memoryPlugin: MemoryPluginStatus;
    runtime?: RuntimeEnv;
  }) => Promise<MemoryStatusSnapshot | null>;
  channelIssues: StatusScanResult["channelIssues"];
  channels: StatusScanResult["channels"];
  pluginCompatibility: PluginCompatibilityNotice[];
}) {
  const memoryPlugin = resolveMemoryPluginStatus(params.overview.cfg);
  // Memory probing can hit disk/plugin code, so run it alongside session/task summary collection.
  const [memory, summary] = await Promise.all([
    params.resolveMemory({
      cfg: params.overview.cfg,
      agentStatus: params.overview.agentStatus,
      memoryPlugin,
      ...(params.runtime ? { runtime: params.runtime } : {}),
    }),
    resolveStatusSummaryFromOverview({ overview: params.overview }),
  ]);

  return buildStatusScanResult({
    cfg: params.overview.cfg,
    sourceConfig: params.overview.sourceConfig,
    secretDiagnostics: params.overview.secretDiagnostics,
    osSummary: params.overview.osSummary,
    tailscaleMode: params.overview.tailscaleMode,
    tailscaleDns: params.overview.tailscaleDns,
    tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
    ...(params.overview.advertisedControlUiLinks
      ? { advertisedControlUiLinks: params.overview.advertisedControlUiLinks }
      : {}),
    update: params.overview.update,
    gatewaySnapshot: params.overview.gatewaySnapshot,
    channelIssues: params.channelIssues,
    agentStatus: params.overview.agentStatus,
    channels: params.channels,
    summary,
    memory,
    memoryPlugin,
    pluginCompatibility: params.pluginCompatibility,
  });
}
