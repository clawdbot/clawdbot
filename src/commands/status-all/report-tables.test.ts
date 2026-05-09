import { describe, expect, it } from "vitest";
import {
  buildStatusAgentTableRows,
  buildStatusChannelDetailSections,
  statusAgentsTableColumns,
  statusOverviewTableColumns,
} from "./report-tables.js";

describe("status-all report tables", () => {
  it("builds agent rows with bootstrap semantics", () => {
    expect(
      buildStatusAgentTableRows({
        agentStatus: {
          agents: [
            {
              id: "main",
              name: "Primary",
              bootstrapPending: true,
              sessionsCount: 2,
              lastActiveAgeMs: 12_000,
              sessionsPath: "/tmp/main.json",
            },
            {
              id: "ops",
              bootstrapPending: false,
              sessionsCount: 0,
              lastActiveAgeMs: null,
              sessionsPath: "/tmp/ops.json",
            },
          ],
        },
        ok: (value) => `ok(${value})`,
        warn: (value) => `warn(${value})`,
      }),
    ).toEqual([
      {
        Agent: "main (Primary)",
        BootstrapFile: "warn(PRESENT)",
        Sessions: "2",
        Active: "just now",
        Store: "/tmp/main.json",
      },
      {
        Agent: "ops",
        BootstrapFile: "ok(ABSENT)",
        Sessions: "0",
        Active: "unknown",
        Store: "/tmp/ops.json",
      },
    ]);
  });

  it("builds colored detail table sections", () => {
    const renderTable = ({ rows }: { rows: unknown[] }) => `rows:${rows.length}`;
    const [section] = buildStatusChannelDetailSections({
      details: [
        {
          title: "Channel detail",
          columns: ["Channel", "Status", "Notes"],
          rows: [{ Channel: "quietchat", Status: "WARN", Notes: "setup" }],
        },
      ],
      width: 120,
      renderTable,
      ok: (value) => `ok(${value})`,
      warn: (value) => `warn(${value})`,
    });

    expect(section).toEqual({
      kind: "table",
      title: "Channel detail",
      width: 120,
      renderTable,
      columns: [
        { key: "Channel", header: "Channel", flex: false, minWidth: 10 },
        { key: "Status", header: "Status", flex: false, minWidth: 10 },
        { key: "Notes", header: "Notes", flex: true, minWidth: 28 },
      ],
      rows: [{ Channel: "quietchat", Status: "warn(WARN)", Notes: "setup" }],
    });
  });

  it("exports stable shared columns", () => {
    expect(statusOverviewTableColumns).toEqual([
      { key: "Item", header: "Item", minWidth: 10 },
      { key: "Value", header: "Value", flex: true, minWidth: 24 },
    ]);
    expect(statusAgentsTableColumns).toEqual([
      { key: "Agent", header: "Agent", minWidth: 12 },
      { key: "BootstrapFile", header: "Bootstrap file", minWidth: 14 },
      { key: "Sessions", header: "Sessions", align: "right", minWidth: 8 },
      { key: "Active", header: "Active", minWidth: 10 },
      { key: "Store", header: "Store", flex: true, minWidth: 34 },
    ]);
  });
});
