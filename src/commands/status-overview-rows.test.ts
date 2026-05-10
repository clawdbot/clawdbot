import { describe, expect, it } from "vitest";
import { VERSION } from "../version.js";
import {
  buildStatusAllOverviewRows,
  buildStatusCommandOverviewRows,
} from "./status-overview-rows.ts";
import {
  baseStatusOverviewSurface,
  createStatusCommandOverviewRowsParams,
} from "./status.test-support.ts";

function findRowValue(rows: Array<{ Item: string; Value: string }>, item: string) {
  return rows.find((row) => row.Item === item)?.Value;
}

describe("status-overview-rows", () => {
  it("builds command overview rows from the shared surface", () => {
    const rows = buildStatusCommandOverviewRows(createStatusCommandOverviewRowsParams());

    expect(findRowValue(rows, "OS")).toBe(`macOS · node ${process.versions.node}`);
    expect(findRowValue(rows, "Memory")).toBe(
      "1 files · 2 chunks · plugin memory · ok(vector ready) · warn(fts ready) · muted(cache warm)",
    );
    expect(findRowValue(rows, "Plugin compatibility")).toBe("warn(1 notice · 1 plugin)");
    expect(findRowValue(rows, "Sessions")).toBe(
      "2 active · default gpt-5.5 (12k ctx) · store.json",
    );
  });

  it("marks skipped memory inspection as not checked in fast status output", () => {
    const rows = buildStatusCommandOverviewRows(
      createStatusCommandOverviewRowsParams({
        memory: null,
        memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
      }),
    );

    expect(findRowValue(rows, "Memory")).toBe(
      "muted(enabled (plugin memory-lancedb-pro) · not checked)",
    );
  });

  it("builds status-all overview rows from the shared surface", () => {
    const rows = buildStatusAllOverviewRows({
      surface: {
        ...baseStatusOverviewSurface,
        tailscaleMode: "off",
        tailscaleHttpsUrl: null,
        gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
      },
      osLabel: "macOS",
      configPath: "/tmp/openclaw.json",
      secretDiagnosticsCount: 2,
      agentStatus: {
        bootstrapPendingCount: 1,
        totalSessions: 2,
        agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
      },
      tailscaleBackendState: "Running",
    });

    expect(findRowValue(rows, "Version")).toBe(VERSION);
    expect(findRowValue(rows, "OS")).toBe("macOS");
    expect(findRowValue(rows, "Config")).toBe("/tmp/openclaw.json");
    expect(findRowValue(rows, "Security")).toBe("Run: openclaw security audit --deep");
    expect(findRowValue(rows, "Secrets")).toBe("2 diagnostics");
  });
});
