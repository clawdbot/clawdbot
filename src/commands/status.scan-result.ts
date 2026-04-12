import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { collectChannelStatusIssues as collectChannelStatusIssuesFn } from "../infra/channels-status-issues.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { buildChannelsTable as buildChannelsTableFn } from "./status-all/channels.js";
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import type {
  GatewayProbeSnapshot,
  MemoryPluginStatus,
  MemoryStatusSnapshot,
  pickGatewaySelfPresence,
} from "./status.scan.shared.js";
import type { getStatusSummary as getStatusSummaryFn } from "./status.summary.js";

export type StatusScanResult = {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  secretDiagnostics: string[];
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  update: UpdateCheckResult;
  gatewayConnection: GatewayProbeSnapshot["gatewayConnection"];
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  gatewayProbeAuthWarning?: string;
  gatewayProbe: GatewayProbeSnapshot["gatewayProbe"];
  gatewayReachable: boolean;
  gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
  channelIssues: ReturnType<typeof collectChannelStatusIssuesFn>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
  channels: Awaited<ReturnType<typeof buildChannelsTableFn>>;
  summary: Awaited<ReturnType<typeof getStatusSummaryFn>>;
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
  pluginCompatibility: PluginCompatibilityNotice[];
};

export function buildStatusScanResult(params: {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  secretDiagnostics: string[];
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  update: UpdateCheckResult;
  gatewaySnapshot: Pick<
    GatewayProbeSnapshot,
    | "gatewayConnection"
    | "remoteUrlMissing"
    | "gatewayMode"
    | "gatewayProbeAuth"
    | "gatewayProbeAuthWarning"
    | "gatewayProbe"
    | "gatewayReachable"
    | "gatewaySelf"
  >;
  channelIssues: ReturnType<typeof collectChannelStatusIssuesFn>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
  channels: Awaited<ReturnType<typeof buildChannelsTableFn>>;
  summary: Awaited<ReturnType<typeof getStatusSummaryFn>>;
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
  pluginCompatibility: PluginCompatibilityNotice[];
}): StatusScanResult {
  return {
    cfg: params.cfg,
    sourceConfig: params.sourceConfig,
    secretDiagnostics: params.secretDiagnostics,
    osSummary: params.osSummary,
    tailscaleMode: params.tailscaleMode,
    tailscaleDns: params.tailscaleDns,
    tailscaleHttpsUrl: params.tailscaleHttpsUrl,
    update: params.update,
    gatewayConnection: params.gatewaySnapshot.gatewayConnection,
    remoteUrlMissing: params.gatewaySnapshot.remoteUrlMissing,
    gatewayMode: params.gatewaySnapshot.gatewayMode,
    gatewayProbeAuth: params.gatewaySnapshot.gatewayProbeAuth,
    gatewayProbeAuthWarning: params.gatewaySnapshot.gatewayProbeAuthWarning,
    gatewayProbe: params.gatewaySnapshot.gatewayProbe,
    gatewayReachable: params.gatewaySnapshot.gatewayReachable,
    gatewaySelf: params.gatewaySnapshot.gatewaySelf,
    channelIssues: params.channelIssues,
    agentStatus: params.agentStatus,
    channels: params.channels,
    summary: params.summary,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    pluginCompatibility: params.pluginCompatibility,
  };
}
