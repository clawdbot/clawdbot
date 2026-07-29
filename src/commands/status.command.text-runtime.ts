// Text-mode status runtime barrel.
// Kept separate from command orchestration so JSON/fast status does not import table/theme helpers.

export { formatCliCommand } from "../cli/command-format.js";
export { info } from "../globals.js";
export { formatTimeAgo } from "../infra/format-time/format-relative.ts";
export { formatGitInstallLabel } from "../infra/update-check.js";
export {
  resolveMemoryCacheSummary,
  resolveMemoryFtsState,
  resolveMemoryVectorState,
} from "../memory-host-sdk/status.js";
export {
  formatPluginCompatibilityNotice,
  summarizePluginCompatibility,
} from "../plugins/status.js";
export { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
export { theme } from "../../packages/terminal-core/src/theme.js";
export { formatHealthChannelLines } from "./health-format.js";
export { groupChannelIssuesByChannel } from "./status-all/channel-issues.js";
export {
  buildStatusChannelsTableRows,
  statusChannelsTableColumns,
} from "./status-all/channels-table.js";
export {
  buildStatusGatewaySurfaceValues,
  buildStatusOverviewSurfaceRows,
  buildStatusOverviewRows,
  buildStatusUpdateSurface,
  buildGatewayStatusSummaryParts,
  formatStatusDashboardValue,
  formatGatewayAuthUsed,
  formatGatewaySelfSummary,
  resolveStatusUpdateChannelInfo,
  formatStatusServiceValue,
  formatStatusTailscaleValue,
  resolveStatusDashboardUrl,
} from "./status-all/format.js";
export {
  formatDuration,
  formatKTokens,
  formatPromptCacheCompact,
  formatTokensCompact,
  shortenText,
} from "./status.format.js";
export { formatUpdateAvailableHint } from "./status.update.js";
