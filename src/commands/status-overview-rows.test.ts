import { describe, expect, it } from "vitest";
import {
  buildStatusAllOverviewRows,
  buildStatusCommandOverviewRows,
} from "./status-overview-rows.ts";
import {
  baseStatusOverviewSurface,
  createStatusCommandOverviewRowsParams,
} from "./status.test-support.ts";

describe("status-overview-rows", () => {
  it("builds command overview rows from the shared surface", () => {
    expect(buildStatusCommandOverviewRows(createStatusCommandOverviewRowsParams())).toEqual(
      expect.arrayContaining([
        { Item: "OS", Value: `macOS · node ${process.versions.node}` },
        {
          Item: "Memory",
          Value:
            "1 files · 2 chunks · plugin memory · ok(vector ready) · warn(fts ready) · muted(cache warm)",
        },
        { Item: "Plugin compatibility", Value: "warn(1 notice · 1 plugin)" },
        { Item: "Sessions", Value: "2 active · default gpt-5.5 (12k ctx) · store.json" },
      ]),
    );
  });

  it("marks skipped memory inspection as not checked in fast status output", () => {
    expect(
      buildStatusCommandOverviewRows(
        createStatusCommandOverviewRowsParams({
          memory: null,
          memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          Item: "Memory",
          Value: "muted(enabled (plugin memory-lancedb-pro) · not checked)",
        },
      ]),
    );
  });

  it("builds status-all overview rows from the shared surface", () => {
    expect(
      buildStatusAllOverviewRows({
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
      }),
    ).toEqual(
      expect.arrayContaining([
        { Item: "Version", Value: expect.any(String) },
        { Item: "OS", Value: "macOS" },
        { Item: "Config", Value: "/tmp/openclaw.json" },
        { Item: "Security", Value: "Run: openclaw security audit --deep" },
        { Item: "Secrets", Value: "2 diagnostics" },
      ]),
    );
  });
});
