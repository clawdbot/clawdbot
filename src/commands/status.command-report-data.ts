// Builds the data model for the standard `openclaw status` text report.
// It converts scan/runtime state into table rows and section lines before rendering.

import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import type { ConnectPairingRequiredReason } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { renderTable, type TableColumn } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { resolveOsSummary } from "../infra/os-summary.js";
import {
  resolveMemoryCacheSummary,
  resolveMemoryFtsState,
  resolveMemoryVectorState,
} from "../memory-host-sdk/status.js";
import { formatPluginCompatibilityNotice } from "../plugins/status-compatibility.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { SecurityAuditReport } from "../security/audit.js";
import type { StatusSummary } from "../status/types.js";
import { formatHealthChannelLines } from "./health-format.js";
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
  buildStatusModelSelectionLines,
  buildStatusPairingRecoveryLines,
  buildStatusPluginCompatibilityLines,
  buildStatusSecurityAuditLines,
  buildStatusSessionsRows,
  buildStatusSystemEventsRows,
  buildStatusSystemEventsTrailer,
  statusHealthColumns,
} from "./status.command-sections.js";
import {
  formatKTokens,
  formatPromptCacheCompact,
  formatTokensCompact,
  shortenText,
} from "./status.format.js";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";
import { formatUpdateAvailableHint } from "./status.update.js";

/** Builds all table rows, section lines, and footer data needed by the status report renderer. */
export async function buildStatusCommandReportData(params: {
  env: NodeJS.ProcessEnv;
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
  pairingRecovery: {
    requestId: string | null;
    reason: ConnectPairingRequiredReason | null;
    remediationHint: string | null;
  } | null;
  tableWidth: number;
  updateValue?: string;
  updateRestartValue?: string | null;
}) {
  const ok = (value: string) => theme.success(value);
  const warn = (value: string) => theme.warn(value);
  const muted = (value: string) => theme.muted(value);
  const overviewRows = buildStatusCommandOverviewRows({
    env: params.env,
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
    ok,
    warn,
    muted,
    formatTimeAgo,
    formatKTokens,
    resolveMemoryVectorState,
    resolveMemoryFtsState,
    resolveMemoryCacheSummary,
    updateValue: params.updateValue,
    updateRestartValue: params.updateRestartValue,
  });

  const sessionsColumns = [
    { key: "Key", header: "Key", minWidth: 20, flex: true },
    { key: "Kind", header: "Kind", minWidth: 6 },
    { key: "Age", header: "Age", minWidth: 9 },
    { key: "Model", header: "Model", minWidth: 14 },
    { key: "Runtime", header: "Runtime", minWidth: 14 },
    { key: "Tokens", header: "Tokens", minWidth: 16 },
    // Verbose mode exposes prompt-cache details because it can widen rows substantially.
    ...(params.opts.verbose ? [{ key: "Cache", header: "Cache", minWidth: 16, flex: true }] : []),
  ] satisfies TableColumn[];
  const securityAuditLines = params.securityAudit
    ? buildStatusSecurityAuditLines({
        securityAudit: params.securityAudit,
        theme,
        shortenText,
        formatCliCommand,
      })
    : [
        theme.muted(
          `Skipped in fast status. Full report: ${formatCliCommand("openclaw security audit")}`,
        ),
        theme.muted(`Deep probe: ${formatCliCommand("openclaw status --deep")}`),
      ];
  const retainedLost = params.summary.taskAuditRetainedLost;
  // Lost task retention is operational noise unless the user requested deep/verbose status.
  const retainedLostLine =
    (params.opts.deep || params.opts.verbose) && retainedLost && retainedLost.count > 0
      ? theme.muted(
          `${retainedLost.count} lost task${retainedLost.count === 1 ? "" : "s"} retained until ${timestampMsToIsoString(retainedLost.nextCleanupAfter) ?? "cleanupAfter"}`,
        )
      : null;

  return {
    heading: theme.heading,
    muted: theme.muted,
    renderTable,
    width: params.tableWidth,
    overviewRows,
    showTaskMaintenanceHint: params.summary.taskAudit.errors > 0,
    taskMaintenanceHint: `Task maintenance: ${formatCliCommand("openclaw tasks maintenance --apply")}`,
    taskRegistryMigrationHint: params.summary.tasks.warning
      ? theme.warn(params.summary.tasks.warning)
      : null,
    retainedLostTaskLine: retainedLostLine,
    pluginCompatibilityLines: buildStatusPluginCompatibilityLines({
      notices: params.pluginCompatibility,
      formatNotice: formatPluginCompatibilityNotice,
      warn: theme.warn,
      muted: theme.muted,
    }),
    pairingRecoveryLines: buildStatusPairingRecoveryLines({
      pairingRecovery: params.pairingRecovery,
      warn: theme.warn,
      muted: theme.muted,
      formatCliCommand,
    }),
    modelSelectionLines: buildStatusModelSelectionLines({
      recent: params.summary.sessions.recent,
      shortenText,
      warn: theme.warn,
      muted: theme.muted,
    }),
    securityAuditLines,
    channelsColumns: statusChannelsTableColumns,
    channelsRows: buildStatusChannelsTableRows({
      rows: params.channels.rows,
      channelIssues: params.channelIssues,
      ok,
      warn,
      muted,
      accentDim: theme.accentDim,
      formatIssueMessage: (message) => shortenText(message, 84),
    }),
    sessionsColumns,
    sessionsRows: buildStatusSessionsRows({
      recent: params.summary.sessions.recent,
      verbose: params.opts.verbose,
      shortenText,
      formatTimeAgo,
      formatTokensCompact,
      formatPromptCacheCompact,
      muted,
    }),
    systemEventsRows: buildStatusSystemEventsRows({
      queuedSystemEvents: params.summary.queuedSystemEvents,
    }),
    systemEventsTrailer: buildStatusSystemEventsTrailer({
      queuedSystemEvents: params.summary.queuedSystemEvents,
      muted,
    }),
    healthColumns: params.health ? statusHealthColumns : undefined,
    healthRows: params.health
      ? buildStatusHealthRows({
          health: params.health,
          formatHealthChannelLines,
          ok,
          warn,
          muted,
        })
      : undefined,
    usageLines: params.usageLines,
    footerLines: buildStatusFooterLines({
      updateHint: formatUpdateAvailableHint(params.surface.update),
      warn: theme.warn,
      formatCliCommand,
      nodeOnlyGateway: params.surface.nodeOnlyGateway,
      gatewayReachable: params.surface.gatewayReachable,
    }),
  };
}
