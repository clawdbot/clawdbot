import type { ProgressReporter } from "../../cli/progress.js";
import { renderTable } from "../../terminal/table.js";
import { isRich, theme } from "../../terminal/theme.js";
import { appendStatusAllDiagnosis } from "./diagnosis.js";
import { formatAge } from "./format.js";

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

  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);

  const overview = renderTable({
    width: tableWidth,
    columns: [
      { key: "Item", header: "Item", minWidth: 10 },
      { key: "Value", header: "Value", flex: true, minWidth: 24 },
    ],
    rows: params.overviewRows,
  });

  const channelRows = params.channels.rows.map((row) => ({
    channelId: row.id,
    Channel: row.label,
    Enabled: row.enabled ? ok("ON") : muted("OFF"),
    State:
      row.state === "ok"
        ? ok("OK")
        : row.state === "warn"
          ? warn("WARN")
          : row.state === "off"
            ? muted("OFF")
            : theme.accentDim("SETUP"),
    Detail: row.detail,
  }));
  const channelIssuesByChannel = (() => {
    const map = new Map<string, ChannelIssueLike[]>();
    for (const issue of params.channelIssues) {
      const key = issue.channel;
      const list = map.get(key);
      if (list) list.push(issue);
      else map.set(key, [issue]);
    }
    return map;
  })();
  const channelRowsWithIssues = channelRows.map((row) => {
    const issues = channelIssuesByChannel.get(row.channelId) ?? [];
    if (issues.length === 0) return row;
    const issue = issues[0];
    const suffix = ` · ${warn(`gateway: ${String(issue.message).slice(0, 90)}`)}`;
    return {
      ...row,
      State: warn("WARN"),
      Detail: `${row.Detail}${suffix}`,
    };
  });

  const channelsTable = renderTable({
    width: tableWidth,
    columns: [
      { key: "Channel", header: "Channel", minWidth: 10 },
      { key: "Enabled", header: "Enabled", minWidth: 7 },
      { key: "State", header: "State", minWidth: 8 },
      { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
    ],
    rows: channelRowsWithIssues,
  });

  const agentRows = params.agentStatus.agents.map((a) => ({
    Agent: a.name?.trim() ? `${a.id} (${a.name.trim()})` : a.id,
    Bootstrap:
      a.bootstrapPending === true
        ? warn("PENDING")
        : a.bootstrapPending === false
          ? ok("OK")
          : "unknown",
    Sessions: String(a.sessionsCount),
    Active: a.lastActiveAgeMs != null ? formatAge(a.lastActiveAgeMs) : "unknown",
    Store: a.sessionsPath,
  }));

  const agentsTable = renderTable({
    width: tableWidth,
    columns: [
      { key: "Agent", header: "Agent", minWidth: 12 },
      { key: "Bootstrap", header: "Bootstrap", minWidth: 10 },
      { key: "Sessions", header: "Sessions", align: "right", minWidth: 8 },
      { key: "Active", header: "Active", minWidth: 10 },
      { key: "Store", header: "Store", flex: true, minWidth: 34 },
    ],
    rows: agentRows,
  });

  const lines: string[] = [];
  lines.push(heading("Moltbot status --all"));
  lines.push("");
  lines.push(heading("Overview"));
  lines.push(overview.trimEnd());
  lines.push("");
  lines.push(heading("Channels"));
  lines.push(channelsTable.trimEnd());
  for (const detail of params.channels.details) {
    lines.push("");
    lines.push(heading(detail.title));
    lines.push(
      renderTable({
        width: tableWidth,
        columns: detail.columns.map((c) => ({
          key: c,
          header: c,
          flex: c === "Notes",
          minWidth: c === "Notes" ? 28 : 10,
        })),
        rows: detail.rows.map((r) => ({
          ...r,
          ...(r.Status === "OK"
            ? { Status: ok("OK") }
            : r.Status === "WARN"
              ? { Status: warn("WARN") }
              : {}),
        })),
      }).trimEnd(),
    );
  }
  lines.push("");
  lines.push(heading("Agents"));
  lines.push(agentsTable.trimEnd());
  lines.push("");
  lines.push(heading("Diagnosis (read-only)"));

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
