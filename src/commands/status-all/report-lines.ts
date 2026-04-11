import type { ProgressReporter } from "../../cli/progress.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { isRich, theme } from "../../terminal/theme.js";
import { appendStatusAllDiagnosis } from "./diagnosis.js";
import {
  buildStatusAgentsSection,
  buildStatusChannelDetailsSections,
  buildStatusChannelsSection,
  buildStatusOverviewSection,
} from "./report-sections.js";
import { appendStatusReportSections, appendStatusSectionHeading } from "./text-report.js";

type OverviewRow = { Item: string; Value: string };

type ChannelsTable = {
  rows: Array<{
    id: string;
    label: string;
    enabled: boolean;
    state: "ok" | "warn" | "off" | "setup";
    detail: string;
  }>;
  details: Array<{
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
  }>;
};

type ChannelIssueLike = {
  channel: string;
  message: string;
};

type AgentStatusLike = {
  agents: Array<{
    id: string;
    name?: string | null;
    bootstrapPending?: boolean | null;
    sessionsCount: number;
    lastActiveAgeMs?: number | null;
    sessionsPath: string;
  }>;
};

export async function buildStatusAllReportLines(params: {
  progress: ProgressReporter;
  overviewRows: OverviewRow[];
  channels: ChannelsTable;
  channelIssues: ChannelIssueLike[];
  agentStatus: AgentStatusLike;
  connectionDetailsForReport: string;
  diagnosis: Omit<
    Parameters<typeof appendStatusAllDiagnosis>[0],
    "lines" | "progress" | "muted" | "ok" | "warn" | "fail" | "connectionDetailsForReport"
  >;
}) {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const ok = (text: string) => (rich ? theme.success(text) : text);
  const warn = (text: string) => (rich ? theme.warn(text) : text);
  const fail = (text: string) => (rich ? theme.error(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);

  const tableWidth = getTerminalTableWidth();

  const lines: string[] = [];
  lines.push(heading("OpenClaw status --all"));
  appendStatusReportSections({
    lines,
    heading,
    sections: [
      buildStatusOverviewSection({
        width: tableWidth,
        renderTable,
        rows: params.overviewRows,
      }),
      buildStatusChannelsSection({
        width: tableWidth,
        renderTable,
        rows: params.channels.rows,
        channelIssues: params.channelIssues,
        ok,
        warn,
        muted,
        accentDim: theme.accentDim,
        formatIssueMessage: (message) => message.slice(0, 90),
      }),
      ...buildStatusChannelDetailsSections({
        details: params.channels.details,
        width: tableWidth,
        renderTable,
        ok,
        warn,
      }),
      buildStatusAgentsSection({
        width: tableWidth,
        renderTable,
        agentStatus: params.agentStatus,
        ok,
        warn,
      }),
    ],
  });
  appendStatusSectionHeading({
    lines,
    heading,
    title: "Diagnosis (read-only)",
  });

  await appendStatusAllDiagnosis({
    lines,
    progress: params.progress,
    muted,
    ok,
    warn,
    fail,
    connectionDetailsForReport: params.connectionDetailsForReport,
    ...params.diagnosis,
  });

  return lines;
}
