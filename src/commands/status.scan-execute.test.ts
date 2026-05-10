import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import type { MemoryStatusSnapshot } from "./status.scan.shared.js";

const { resolveStatusSummaryFromOverview, resolveMemoryPluginStatus } = vi.hoisted(() => ({
  resolveStatusSummaryFromOverview: vi.fn(async () => ({ sessions: { count: 1 } })),
  resolveMemoryPluginStatus: vi.fn(() => ({
    enabled: false,
    slot: null,
    reason: "memorySearch not configured",
  })),
}));

vi.mock("./status.scan-overview.ts", () => ({
  resolveStatusSummaryFromOverview,
}));

vi.mock("./status.scan.shared.js", () => ({
  resolveMemoryPluginStatus,
}));

describe("executeStatusScanFromOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves memory and summary, then builds the final scan result", async () => {
    const overview = {
      cfg: { channels: {} },
      sourceConfig: { channels: {} },
      secretDiagnostics: ["diag"],
      osSummary: { label: "linux" },
      tailscaleMode: "tailnet",
      tailscaleDns: "box.tail.ts.net",
      tailscaleHttpsUrl: "https://box.tail.ts.net",
      update: { available: false, installKind: "package" },
      gatewaySnapshot: {
        gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "local" },
        remoteUrlMissing: false,
        gatewayMode: "local",
        gatewayProbeAuth: {},
        gatewayProbeAuthWarning: undefined,
        gatewayProbe: null,
        gatewayReachable: true,
        gatewaySelf: null,
      },
      agentStatus: { agents: [{ id: "main" }], defaultId: "main" },
      skipColdStartNetworkChecks: false,
    } as unknown as StatusScanOverviewResult;
    const resolveMemory = vi.fn<
      (args: {
        cfg: unknown;
        agentStatus: unknown;
        memoryPlugin: unknown;
        runtime?: unknown;
      }) => Promise<MemoryStatusSnapshot>
    >(async () => ({
      agentId: "main",
      backend: "builtin",
      provider: "memory-core",
    }));

    const result = await executeStatusScanFromOverview({
      overview,
      runtime: {} as never,
      resolveMemory,
      channelIssues: [],
      channels: { rows: [], details: [] },
      pluginCompatibility: [],
    });

    expect(resolveMemoryPluginStatus).toHaveBeenCalledWith(overview.cfg);
    expect(resolveStatusSummaryFromOverview).toHaveBeenCalledWith({
      overview,
      includeChannelSummary: undefined,
    });
    expect(resolveMemory).toHaveBeenCalledWith({
      cfg: overview.cfg,
      agentStatus: overview.agentStatus,
      memoryPlugin: { enabled: false, slot: null, reason: "memorySearch not configured" },
      runtime: {},
    });
    expect(result.cfg).toBe(overview.cfg);
    expect(result.sourceConfig).toBe(overview.sourceConfig);
    expect(result.secretDiagnostics).toEqual(["diag"]);
    expect(result.tailscaleDns).toBe("box.tail.ts.net");
    expect(result.tailscaleHttpsUrl).toBe("https://box.tail.ts.net");
    expect(result.gatewayConnection).toEqual({ url: "ws://127.0.0.1:18789", urlSource: "local" });
    expect(result.gatewayMode).toBe("local");
    expect(result.gatewayReachable).toBe(true);
    expect(result.channels).toEqual({ rows: [], details: [] });
    expect(result.summary).toEqual({ sessions: { count: 1 } });
    expect(result.memory).toEqual({ agentId: "main", backend: "builtin", provider: "memory-core" });
    expect(result.pluginCompatibility).toEqual([]);
  });
});
