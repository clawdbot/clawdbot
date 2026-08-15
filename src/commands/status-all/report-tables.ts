// Table row helpers for status report sections.
// These functions keep terminal styling decisions out of the scan/data layer.

import type { RenderTableOptions } from "../../../packages/terminal-core/src/table.js";
import { formatTimeAgo } from "./format.js";
import type { StatusReportSection } from "./text-report.js";

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

type ChannelDetailLike = {
  title: string;
  columns: string[];
  rows: Array<Record<string, string>>;
};

export const statusOverviewTableColumns = [
  { key: "Item", header: "Item", minWidth: 10 },
  { key: "Value", header: "Value", flex: true, minWidth: 24 },
] as const;

export const statusAgentsTableColumns = [
  { key: "Agent", header: "Agent", minWidth: 12 },
  { key: "BootstrapFile", header: "Bootstrap file", minWidth: 14 },
  { key: "Sessions", header: "Sessions", align: "right", minWidth: 8 },
  { key: "Active", header: "Active", minWidth: 10 },
  { key: "Store", header: "Store", flex: true, minWidth: 34 },
] as const;

/** Formats agent status rows for the status report table. */
export function buildStatusAgentTableRows(params: {
  agentStatus: AgentStatusLike;
  ok: (text: string) => string;
  warn: (text: string) => string;
}) {
  return params.agentStatus.agents.map((agent) => ({
    Agent: agent.name?.trim() ? `${agent.id} (${agent.name.trim()})` : agent.id,
    BootstrapFile:
      agent.bootstrapPending === true
        ? params.warn("PRESENT")
        : agent.bootstrapPending === false
          ? params.ok("ABSENT")
          : "unknown",
    Sessions: String(agent.sessionsCount),
    Active: agent.lastActiveAgeMs != null ? formatTimeAgo(agent.lastActiveAgeMs) : "unknown",
    Store: agent.sessionsPath,
  }));
}

/** Converts per-channel account detail rows into renderable table sections. */
export function buildStatusChannelDetailSections(params: {
  details: ChannelDetailLike[];
  width: number;
  renderTable: (input: RenderTableOptions) => string;
  ok: (text: string) => string;
  warn: (text: string) => string;
}): StatusReportSection[] {
  return params.details.map((detail) => ({
    kind: "table" as const,
    title: detail.title,
    width: params.width,
    renderTable: params.renderTable,
    columns: detail.columns.map((column) => ({
      key: column,
      header: column,
      // Notes can include file paths and credential source summaries; give them remaining width.
      flex: column === "Notes",
      minWidth: column === "Notes" ? 28 : 10,
    })),
    rows: detail.rows.map((row) => ({
      ...row,
      ...(row.Status === "OK"
        ? { Status: params.ok("OK") }
        : row.Status === "WARN"
          ? { Status: params.warn("WARN") }
          : {}),
    })),
  }));
}
