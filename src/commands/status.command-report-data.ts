import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { resolveOsSummary } from "../infra/os-summary.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { SecurityAuditReport } from "../security/audit.js";
import type { RenderTableOptions, TableColumn } from "../terminal/table.js";
import type { HealthSummary } from "./health.js";
import {
  buildStatusChannelsTableRows,
  statusChannelsTableColumns,
} from "./status-all/channels-table.js";
import { buildStatusCommandOverviewRows } from "./status-overview-rows.ts";
import type { StatusOverviewSurface } from "./status-overview-surface.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import {
  buildStatusFooterLines,
  buildStatusHealthRows,
  buildStatusPairingRecoveryLines,
  buildStatusPluginCompatibilityLines,
  buildStatusSecurityAuditLines,
  buildStatusSessionsRows,
  buildStatusSystemEventsRows,
  buildStatusSystemEventsTrailer,
  statusHealthColumns,
  type StatusMemoryStateResolvers,
} from "./status.command-sections.js";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";
import type { SessionStatus, StatusSummary } from "./status.types.js";

export async function buildStatusCommandReportData(
  params: {
    opts: {
      deep?: boolean;
      verbose?: boolean;
    };
    surface: StatusOverviewSurface;
    osSummary: ReturnType<typeof resolveOsSummary>;
    summary: StatusSummary;
    securityAudit?: SecurityAuditReport;
    health?: HealthSummary;
    usageLines?: string[];
    lastHeartbeat: HeartbeatEventPayload | null;
    agentStatus: {
      defaultId?: string | null;
      bootstrapPendingCount: number;
      totalSessions: number;
      agents: AgentLocalStatus[];
    };
    channels: {
      rows: Array<{
        id: string;
        label: string;
        enabled: boolean;
        state: "ok" | "warn" | "off" | "setup";
        detail: string;
      }>;
    };
    channelIssues: Array<{
      channel: string;
      message: string;
    }>;
    memory: MemoryStatusSnapshot | null;
    memoryPlugin: MemoryPluginStatus;
    pluginCompatibility: PluginCompatibilityNotice[];
    pairingRecovery: { requestId: string | null } | null;
    tableWidth: number;
    ok: (value: string) => string;
    warn: (value: string) => string;
    muted: (value: string) => string;
    shortenText: (value: string, maxLen: number) => string;
    formatCliCommand: (value: string) => string;
    formatTimeAgo: (ageMs: number) => string;
    formatKTokens: (value: number) => string;
    formatTokensCompact: (value: SessionStatus) => string;
    formatPromptCacheCompact: (value: SessionStatus) => string | null;
    formatHealthChannelLines: (summary: HealthSummary, opts: { accountMode: "all" }) => string[];
    formatPluginCompatibilityNotice: (notice: PluginCompatibilityNotice) => string;
    formatUpdateAvailableHint: (update: StatusOverviewSurface["update"]) => string | null;
    accentDim: (value: string) => string;
    updateValue?: string;
    theme: {
      heading: (value: string) => string;
      muted: (value: string) => string;
      warn: (value: string) => string;
      error: (value: string) => string;
    };
    renderTable: (input: RenderTableOptions) => string;
  } & StatusMemoryStateResolvers,
) {
  const overviewRows = buildStatusCommandOverviewRows({
    opts: params.opts,
    surface: params.surface,
    osLabel: params.osSummary.label,
    summary: params.summary,
    health: params.health,
    lastHeartbeat: params.lastHeartbeat,
    agentStatus: params.agentStatus,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    pluginCompatibility: params.pluginCompatibility,
    ok: params.ok,
    warn: params.warn,
    muted: params.muted,
    formatTimeAgo: params.formatTimeAgo,
    formatKTokens: params.formatKTokens,
    resolveMemoryVectorState: params.resolveMemoryVectorState,
    resolveMemoryFtsState: params.resolveMemoryFtsState,
    resolveMemoryCacheSummary: params.resolveMemoryCacheSummary,
    updateValue: params.updateValue,
  });

  const sessionsColumns = [
    { key: "Key", header: "Key", minWidth: 20, flex: true },
    { key: "Kind", header: "Kind", minWidth: 6 },
    { key: "Age", header: "Age", minWidth: 9 },
    { key: "Model", header: "Model", minWidth: 14 },
    { key: "Tokens", header: "Tokens", minWidth: 16 },
    ...(params.opts.verbose ? [{ key: "Cache", header: "Cache", minWidth: 16, flex: true }] : []),
  ] satisfies TableColumn[];
  const securityAudit = params.securityAudit ?? {
    summary: { critical: 0, warn: 0, info: 0 },
    findings: [],
  };

  return {
    heading: params.theme.heading,
    muted: params.theme.muted,
    renderTable: params.renderTable,
    width: params.tableWidth,
    overviewRows,
    showTaskMaintenanceHint: params.summary.taskAudit.errors > 0,
    taskMaintenanceHint: `Task maintenance: ${params.formatCliCommand("openclaw tasks maintenance --apply")}`,
    pluginCompatibilityLines: buildStatusPluginCompatibilityLines({
      notices: params.pluginCompatibility,
      formatNotice: params.formatPluginCompatibilityNotice,
      warn: params.theme.warn,
      muted: params.theme.muted,
    }),
    pairingRecoveryLines: buildStatusPairingRecoveryLines({
      pairingRecovery: params.pairingRecovery,
      warn: params.theme.warn,
      muted: params.theme.muted,
      formatCliCommand: params.formatCliCommand,
    }),
    securityAuditLines: buildStatusSecurityAuditLines({
      securityAudit,
      theme: params.theme,
      shortenText: params.shortenText,
      formatCliCommand: params.formatCliCommand,
    }),
    channelsColumns: statusChannelsTableColumns,
    channelsRows: buildStatusChannelsTableRows({
      rows: params.channels.rows,
      channelIssues: params.channelIssues,
      ok: params.ok,
      warn: params.warn,
      muted: params.muted,
      accentDim: params.accentDim,
      formatIssueMessage: (message) => params.shortenText(message, 84),
    }),
    sessionsColumns,
    sessionsRows: buildStatusSessionsRows({
      recent: params.summary.sessions.recent,
      verbose: params.opts.verbose,
      shortenText: params.shortenText,
      formatTimeAgo: params.formatTimeAgo,
      formatTokensCompact: params.formatTokensCompact,
      formatPromptCacheCompact: params.formatPromptCacheCompact,
      muted: params.muted,
    }),
    systemEventsRows: buildStatusSystemEventsRows({
      queuedSystemEvents: params.summary.queuedSystemEvents,
    }),
    systemEventsTrailer: buildStatusSystemEventsTrailer({
      queuedSystemEvents: params.summary.queuedSystemEvents,
      muted: params.muted,
    }),
    healthColumns: params.health ? statusHealthColumns : undefined,
    healthRows: params.health
      ? buildStatusHealthRows({
          health: params.health,
          formatHealthChannelLines: params.formatHealthChannelLines,
          ok: params.ok,
          warn: params.warn,
          muted: params.muted,
        })
      : undefined,
    usageLines: params.usageLines,
    footerLines: buildStatusFooterLines({
      updateHint: params.formatUpdateAvailableHint(params.surface.update),
      warn: params.theme.warn,
      formatCliCommand: params.formatCliCommand,
      nodeOnlyGateway: params.surface.nodeOnlyGateway,
      gatewayReachable: params.surface.gatewayReachable,
    }),
  };
}
