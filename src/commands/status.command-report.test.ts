import { describe, expect, it } from "vitest";
import { buildStatusCommandReportLines } from "./status.command-report.ts";

function createRenderTable() {
  return ({ columns, rows }: { columns: Array<Record<string, unknown>>; rows: unknown[] }) =>
    `table:${String(columns[0]?.header)}:${rows.length}`;
}

describe("buildStatusCommandReportLines", () => {
  it("builds the full command report with optional sections", async () => {
    const lines = await buildStatusCommandReportLines({
      heading: (text) => `# ${text}`,
      muted: (text) => `muted(${text})`,
      renderTable: createRenderTable(),
      width: 120,
      overviewRows: [{ Item: "OS", Value: "macOS" }],
      showTaskMaintenanceHint: true,
      taskMaintenanceHint: "maintenance hint",
      pluginCompatibilityLines: ["warn 1"],
      pairingRecoveryLines: ["pairing needed"],
      securityAuditLines: ["audit line"],
      channelsColumns: [{ key: "Channel", header: "Channel" }],
      channelsRows: [{ Channel: "quietchat" }],
      sessionsColumns: [{ key: "Key", header: "Key" }],
      sessionsRows: [{ Key: "main" }],
      systemEventsRows: [{ Event: "queued" }],
      systemEventsTrailer: "muted(… +1 more)",
      healthColumns: [{ key: "Item", header: "Item" }],
      healthRows: [{ Item: "Gateway" }],
      usageLines: ["usage line"],
      footerLines: ["FAQ", "Next steps:"],
    });

    expect(lines).toEqual([
      "# OpenClaw status",
      "",
      "# Overview",
      "table:Item:1",
      "",
      "muted(maintenance hint)",
      "",
      "# Plugin compatibility",
      "warn 1",
      "",
      "pairing needed",
      "",
      "# Security audit",
      "audit line",
      "",
      "# Channels",
      "table:Channel:1",
      "",
      "# Sessions",
      "table:Key:1",
      "",
      "# System events",
      "table:Event:1",
      "muted(… +1 more)",
      "",
      "# Health",
      "table:Item:1",
      "",
      "# Usage",
      "usage line",
      "",
      "FAQ",
      "Next steps:",
    ]);
  });

  it("omits optional sections when inputs are absent", async () => {
    const lines = await buildStatusCommandReportLines({
      heading: (text) => `# ${text}`,
      muted: (text) => text,
      renderTable: createRenderTable(),
      width: 120,
      overviewRows: [{ Item: "OS", Value: "macOS" }],
      showTaskMaintenanceHint: false,
      taskMaintenanceHint: "ignored",
      pluginCompatibilityLines: [],
      pairingRecoveryLines: [],
      securityAuditLines: ["audit line"],
      channelsColumns: [{ key: "Channel", header: "Channel" }],
      channelsRows: [{ Channel: "quietchat" }],
      sessionsColumns: [{ key: "Key", header: "Key" }],
      sessionsRows: [{ Key: "main" }],
      footerLines: ["FAQ"],
    });

    expect(lines).not.toContain("# Plugin compatibility");
    expect(lines).not.toContain("# System events");
    expect(lines).not.toContain("# Health");
    expect(lines).not.toContain("# Usage");
    expect(lines.at(-1)).toBe("FAQ");
  });

  it("renders empty channels and sessions as plain messages", async () => {
    const lines = await buildStatusCommandReportLines({
      heading: (text) => `# ${text}`,
      muted: (text) => `muted(${text})`,
      renderTable: createRenderTable(),
      width: 120,
      overviewRows: [{ Item: "OS", Value: "macOS" }],
      showTaskMaintenanceHint: false,
      taskMaintenanceHint: "ignored",
      pluginCompatibilityLines: [],
      pairingRecoveryLines: [],
      securityAuditLines: ["audit line"],
      channelsColumns: [{ key: "Channel", header: "Channel" }],
      channelsRows: [],
      sessionsColumns: [{ key: "Key", header: "Key" }],
      sessionsRows: [],
      footerLines: ["FAQ"],
    });

    expect(lines).toContain("# Channels");
    expect(lines).toContain("muted(No channels configured)");
    expect(lines).toContain("# Sessions");
    expect(lines).toContain("muted(No sessions)");
    expect(lines).not.toContain("table:Channel:0");
    expect(lines).not.toContain("table:Key:0");
  });
});
