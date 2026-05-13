import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveStatusGatewayHealth,
  resolveStatusGatewayHealthSafe,
  resolveStatusLastHeartbeat,
  resolveStatusRuntimeDetails,
  resolveStatusRuntimeSnapshot,
  resolveStatusSecurityAudit,
  resolveStatusServiceSummaries,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";

const mocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn(),
  runSecurityAudit: vi.fn(),
  callGateway: vi.fn(),
  getDaemonStatusSummary: vi.fn(),
  getNodeDaemonStatusSummary: vi.fn(),
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: mocks.resolveReadOnlyChannelPluginsForConfig,
}));

vi.mock("../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.getDaemonStatusSummary,
  getNodeDaemonStatusSummary: mocks.getNodeDaemonStatusSummary,
}));

function requireProviderUsageCall(): {
  timeoutMs?: number;
  config?: unknown;
  agentDir?: string;
} {
  const call = mocks.loadProviderUsageSummary.mock.calls[0];
  if (!call) {
    throw new Error("expected provider usage summary call");
  }
  const params = call.at(0);
  if (!params || typeof params !== "object") {
    throw new Error("expected provider usage summary params");
  }
  return params as {
    timeoutMs?: number;
    config?: unknown;
    agentDir?: string;
  };
}

describe("status-runtime-shared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadProviderUsageSummary.mockResolvedValue({ providers: [] });
    mocks.runSecurityAudit.mockResolvedValue({ summary: { critical: 0 }, findings: [] });
    mocks.callGateway.mockResolvedValue({ ok: true });
    mocks.getDaemonStatusSummary.mockResolvedValue({ label: "LaunchAgent" });
    mocks.getNodeDaemonStatusSummary.mockResolvedValue({ label: "node" });
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [{ id: "telegram" }],
      configuredChannelIds: ["telegram"],
      missingConfiguredChannelIds: [],
    });
  });

  it("resolves the shared security audit payload", async () => {
    await resolveStatusSecurityAudit({
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
    });

    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
      plugins: [{ id: "telegram" }],
    });
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      { gateway: {} },
      {
        activationSourceConfig: { gateway: {} },
        includeSetupFallbackPlugins: false,
      },
    );
  });

  it("lets the security audit load configured channel plugins when read-only discovery is incomplete", async () => {
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [],
      configuredChannelIds: ["external"],
      missingConfiguredChannelIds: ["external"],
    });

    await resolveStatusSecurityAudit({
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
    });

    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
    });
  });

  it("resolves usage summaries with the provided timeout", async () => {
    await resolveStatusUsageSummary({
      timeoutMs: 1234,
      config: { gateway: {} },
    });

    const usageCall = requireProviderUsageCall();
    expect(usageCall.timeoutMs).toBe(1234);
    expect(usageCall.config).toEqual({ gateway: {} });
    expect(usageCall.agentDir).toContain("main");
  });

  it("resolves usage summaries with explicit agent scope", async () => {
    await resolveStatusUsageSummary({
      timeoutMs: 2345,
      config: { gateway: {} },
      agentDir: "/tmp/status-agent",
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      timeoutMs: 2345,
      config: { gateway: {} },
      agentDir: "/tmp/status-agent",
    });
  });

  it("resolves gateway health with the shared probe call shape", async () => {
    await resolveStatusGatewayHealth({
      config: { gateway: {} },
      timeoutMs: 5000,
    });

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "health",
      params: { probe: true },
      timeoutMs: 5000,
      config: { gateway: {} },
    });
  });

  it("returns a fallback health error when the gateway is unreachable", async () => {
    await expect(
      resolveStatusGatewayHealthSafe({
        config: { gateway: {} },
        gatewayReachable: false,
        gatewayProbeError: "timeout",
      }),
    ).resolves.toEqual({ error: "timeout" });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("passes gateway call overrides through the safe health path", async () => {
    await resolveStatusGatewayHealthSafe({
      config: { gateway: {} },
      timeoutMs: 4321,
      gatewayReachable: true,
      callOverrides: {
        url: "ws://127.0.0.1:18789",
        token: "tok",
      },
    });

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "health",
      params: { probe: true },
      timeoutMs: 4321,
      config: { gateway: {} },
      url: "ws://127.0.0.1:18789",
      token: "tok",
    });
  });

  it("returns null for heartbeat when the gateway is unreachable", async () => {
    expect(
      await resolveStatusLastHeartbeat({
        config: { gateway: {} },
        timeoutMs: 1000,
        gatewayReachable: false,
      }),
    ).toBeNull();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("catches heartbeat gateway errors and returns null", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("boom"));

    expect(
      await resolveStatusLastHeartbeat({
        config: { gateway: {} },
        timeoutMs: 1000,
        gatewayReachable: true,
      }),
    ).toBeNull();
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "last-heartbeat",
      params: {},
      timeoutMs: 1000,
      config: { gateway: {} },
    });
  });

  it("resolves daemon summaries together", async () => {
    await expect(resolveStatusServiceSummaries()).resolves.toEqual([
      { label: "LaunchAgent" },
      { label: "node" },
    ]);
  });

  it("resolves shared runtime details with optional usage and deep fields", async () => {
    await expect(
      resolveStatusRuntimeDetails({
        config: { gateway: {} },
        timeoutMs: 1234,
        usage: true,
        deep: true,
        gatewayReachable: true,
      }),
    ).resolves.toEqual({
      usage: { providers: [] },
      health: { ok: true },
      lastHeartbeat: { ok: true },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });
    const usageCall = requireProviderUsageCall();
    expect(usageCall.timeoutMs).toBe(1234);
    expect(usageCall.config).toEqual({ gateway: {} });
    expect(usageCall.agentDir).toContain("main");
    expect(mocks.callGateway).toHaveBeenNthCalledWith(1, {
      method: "health",
      params: { probe: true },
      timeoutMs: 1234,
      config: { gateway: {} },
    });
    expect(mocks.callGateway).toHaveBeenNthCalledWith(2, {
      method: "last-heartbeat",
      params: {},
      timeoutMs: 1234,
      config: { gateway: {} },
    });
  });

  it("skips optional runtime details when flags are off", async () => {
    await expect(
      resolveStatusRuntimeDetails({
        config: { gateway: {} },
        timeoutMs: 1234,
        usage: false,
        deep: false,
        gatewayReachable: true,
      }),
    ).resolves.toEqual({
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("suppresses health failures inside shared runtime details", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("boom"));

    await expect(
      resolveStatusRuntimeDetails({
        config: { gateway: {} },
        timeoutMs: 1234,
        deep: true,
        gatewayReachable: false,
        suppressHealthErrors: true,
      }),
    ).resolves.toEqual({
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });
  });

  it("resolves the shared runtime snapshot with security audit and runtime details", async () => {
    await expect(
      resolveStatusRuntimeSnapshot({
        config: { gateway: {} },
        sourceConfig: { gateway: { mode: "local" } },
        timeoutMs: 1234,
        usage: true,
        deep: true,
        gatewayReachable: true,
        includeSecurityAudit: true,
      }),
    ).resolves.toEqual({
      securityAudit: { summary: { critical: 0 }, findings: [] },
      usage: { providers: [] },
      health: { ok: true },
      lastHeartbeat: { ok: true },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });
    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      sourceConfig: { gateway: { mode: "local" } },
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
      plugins: [{ id: "telegram" }],
    });
  });
});
