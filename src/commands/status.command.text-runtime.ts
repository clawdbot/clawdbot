// Text-mode status runtime barrel.
// Command orchestration loads this owner only for text diagnostics and reports.

export { getTerminalTableWidth } from "../../packages/terminal-core/src/table.js";
export { theme } from "../../packages/terminal-core/src/theme.js";
export { info } from "../globals.js";
export { formatUsageReportLines } from "../infra/provider-usage.format.js";
export { formatTimeAgo } from "../infra/format-time/format-relative.ts";
export { buildStatusUpdateSurface } from "./status-all/format.js";
export { buildStatusCommandReportData } from "./status.command-report-data.ts";
export { buildStatusCommandReportLines } from "./status.command-report.ts";
export { formatStatusConfigDiagnosticEntries } from "./status.format.js";
