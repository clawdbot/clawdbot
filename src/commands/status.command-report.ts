// Renders the standard `openclaw status` report from prebuilt section data.
// Report data assembly stays separate so tests can validate rows without terminal formatting.

import type { RenderTableOptions, TableColumn } from "../../packages/terminal-core/src/table.js";
import { statusOverviewTableColumns } from "./status-all/report-tables.js";
import { appendStatusReportSections } from "./status-all/text-report.js";

/** Builds terminal lines for the standard status report. */
export async function buildStatusCommandReportLines(params: {
  heading: (text: string) => string;
  muted: (text: string) => string;
  renderTable: (input: RenderTableOptions) => string;
  width: number;
  overviewRows: Array<{ Item: string; Value: string }>;
  showTaskMaintenanceHint: boolean;
  taskMaintenanceHint: string;
  taskRegistryMigrationHint?: string | null;
  retainedLostTaskLine?: string | null;
  pluginCompatibilityLines: string[];
  pairingRecoveryLines: string[];
  modelSelectionLines: string[];
  securityAuditLines: string[];
  channelsColumns: readonly TableColumn[];
  channelsRows: Array<Record<string, string>>;
  sessionsColumns: readonly TableColumn[];
  sessionsRows: Array<Record<string, string>>;
  systemEventsRows?: Array<Record<string, string>>;
  systemEventsTrailer?: string | null;
  healthColumns?: readonly TableColumn[];
  healthRows?: Array<Record<string, string>>;
  usageLines?: string[];
  footerLines: string[];
}) {
  const lines: string[] = [];
  lines.push(params.heading("OpenClaw status"));

  appendStatusReportSections({
    lines,
    heading: params.heading,
    sections: [
      {
        kind: "table",
        title: "Overview",
        width: params.width,
        renderTable: params.renderTable,
        columns: [...statusOverviewTableColumns],
        rows: params.overviewRows,
      },
      {
        kind: "raw",
        body:
          params.showTaskMaintenanceHint ||
          params.taskRegistryMigrationHint ||
          params.retainedLostTaskLine
            ? [
                "",
                // Raw section keeps maintenance hints directly below the overview table.
                ...(params.showTaskMaintenanceHint
                  ? [params.muted(params.taskMaintenanceHint)]
                  : []),
                ...(params.taskRegistryMigrationHint ? [params.taskRegistryMigrationHint] : []),
                ...(params.retainedLostTaskLine ? [params.retainedLostTaskLine] : []),
              ]
            : [],
        skipIfEmpty: true,
      },
      {
        kind: "lines",
        title: "Plugin compatibility",
        body: params.pluginCompatibilityLines,
        skipIfEmpty: true,
      },
      {
        kind: "raw",
        body: params.pairingRecoveryLines.length > 0 ? ["", ...params.pairingRecoveryLines] : [],
        skipIfEmpty: true,
      },
      {
        kind: "lines",
        title: "Model selection",
        body: params.modelSelectionLines,
        skipIfEmpty: true,
      },
      {
        kind: "lines",
        title: "Security audit",
        body: params.securityAuditLines,
      },
      params.channelsRows.length === 0
        ? {
            kind: "lines",
            title: "Channels",
            body: [params.muted("No channels configured")],
          }
        : {
            kind: "table",
            title: "Channels",
            width: params.width,
            renderTable: params.renderTable,
            columns: [...params.channelsColumns],
            rows: params.channelsRows,
          },
      params.sessionsRows.length === 0
        ? {
            kind: "lines",
            title: "Sessions",
            body: [params.muted("No sessions")],
          }
        : {
            kind: "table",
            title: "Sessions",
            width: params.width,
            renderTable: params.renderTable,
            columns: [...params.sessionsColumns],
            rows: params.sessionsRows,
          },
      {
        kind: "table",
        title: "System events",
        width: params.width,
        renderTable: params.renderTable,
        columns: [{ key: "Event", header: "Event", flex: true, minWidth: 24 }],
        rows: params.systemEventsRows ?? [],
        trailer: params.systemEventsTrailer,
        skipIfEmpty: true,
      },
      {
        kind: "table",
        title: "Health",
        width: params.width,
        renderTable: params.renderTable,
        columns: [...(params.healthColumns ?? [])],
        rows: params.healthRows ?? [],
        skipIfEmpty: true,
      },
      {
        kind: "lines",
        title: "Usage",
        body: params.usageLines ?? [],
        skipIfEmpty: true,
      },
      {
        kind: "raw",
        body: ["", ...params.footerLines],
      },
    ],
  });
  return lines;
}
