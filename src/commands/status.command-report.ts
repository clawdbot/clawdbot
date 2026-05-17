import type { RenderTableOptions, TableColumn } from "../terminal/table.js";
import {
  buildStatusChannelsTableSection,
  buildStatusHealthSection,
  buildStatusOverviewSection,
  buildStatusSessionsSection,
  buildStatusSystemEventsSection,
  buildStatusUsageSection,
} from "./status-all/report-sections.js";
import { appendStatusReportSections } from "./status-all/text-report.js";

export async function buildStatusCommandReportLines(params: {
  heading: (text: string) => string;
  muted: (text: string) => string;
  renderTable: (input: RenderTableOptions) => string;
  width: number;
  overviewRows: Array<{ Item: string; Value: string }>;
  showTaskMaintenanceHint: boolean;
  taskMaintenanceHint: string;
  pluginCompatibilityLines: string[];
  pairingRecoveryLines: string[];
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
        ...buildStatusOverviewSection({
          width: params.width,
          renderTable: params.renderTable,
          rows: params.overviewRows,
        }),
      },
      {
        kind: "raw",
        body: params.showTaskMaintenanceHint ? ["", params.muted(params.taskMaintenanceHint)] : [],
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
            ...buildStatusChannelsTableSection({
              width: params.width,
              renderTable: params.renderTable,
              columns: params.channelsColumns,
              rows: params.channelsRows,
            }),
          },
      params.sessionsRows.length === 0
        ? {
            kind: "lines",
            title: "Sessions",
            body: [params.muted("No sessions")],
          }
        : {
            ...buildStatusSessionsSection({
              width: params.width,
              renderTable: params.renderTable,
              columns: params.sessionsColumns,
              rows: params.sessionsRows,
            }),
          },
      {
        ...buildStatusSystemEventsSection({
          width: params.width,
          renderTable: params.renderTable,
          rows: params.systemEventsRows,
          trailer: params.systemEventsTrailer,
        }),
      },
      {
        ...buildStatusHealthSection({
          width: params.width,
          renderTable: params.renderTable,
          columns: params.healthColumns,
          rows: params.healthRows,
        }),
      },
      {
        ...buildStatusUsageSection({ usageLines: params.usageLines }),
      },
      {
        kind: "raw",
        body: ["", ...params.footerLines],
      },
    ],
  });
  return lines;
}
