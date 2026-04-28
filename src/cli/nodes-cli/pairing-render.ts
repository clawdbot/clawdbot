import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { sanitizeTerminalText } from "../../terminal/safe-text.js";
import { renderTable } from "../../terminal/table.js";
import type { PendingRequest } from "./types.js";

export function renderPendingPairingRequestsTable(params: {
  pending: PendingRequest[];
  now: number;
  tableWidth: number;
  theme: {
    heading: (text: string) => string;
    warn: (text: string) => string;
    muted: (text: string) => string;
  };
}) {
  const { pending, now, tableWidth, theme } = params;
  const rows = pending.map((r) => {
    const nodeLabel = r.displayName?.trim() ? r.displayName.trim() : r.nodeId;
    return {
      Request: sanitizeTerminalText(r.requestId),
      Node: sanitizeTerminalText(nodeLabel),
      IP: sanitizeTerminalText(r.remoteIp ?? ""),
      Requested:
        typeof r.ts === "number" ? formatTimeAgo(Math.max(0, now - r.ts)) : theme.muted("unknown"),
    };
  });
  return {
    heading: theme.heading("Pending"),
    table: renderTable({
      width: tableWidth,
      columns: [
        { key: "Request", header: "Request", minWidth: 8 },
        { key: "Node", header: "Node", minWidth: 14, flex: true },
        { key: "IP", header: "IP", minWidth: 10 },
        { key: "Requested", header: "Requested", minWidth: 12 },
      ],
      rows,
    }).trimEnd(),
  };
}
