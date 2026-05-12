import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectStatusScanOverview } from "./status.scan-overview.ts";

const mocks = vi.hoisted(() => ({
  hasPotentialConfiguredChannels: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
  getStatusCommandSecretTargetIds: vi.fn(),
  readBestEffortConfig: vi.fn(),
  resolveOsSummary: vi.fn(),
  createStatusScanCoreBootstrap: vi.fn(),
  callGateway: vi.fn(),
  collectChannelStatusIssues: vi.fn(),
  buildChannelsTable: vi.fn(),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  hasConfiguredChannelsForReadOnlyScope: mocks.hasPotentialConfiguredChannels,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getStatusCommandSecretTargetIds: mocks.getStatusCommandSecretTargetIds,
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: mocks.resolveOsSummary,
}));

vi.mock("./status.scan.bootstrap-shared.js", () => ({
  createStatusScanCoreBootstrap: mocks.createStatusScanCoreBootstrap,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.scan.runtime.js", () => ({
  statusScanRuntime: {
    collectChannelStatusIssues: mocks.collectChannelStatusIssues,
    buildChannelsTable: mocks.buildChannelsTable,
  },
}));

describe("collectStatusScanOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    mocks.getStatusCommandSecretTargetIds.mockReturnValue([]);
    mocks.readBestEffortConfig.mockResolvedValue({ session: {} });
    mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
      resolvedConfig: { session: {} },
      diagnostics: ["secret warning"],
    });
    mocks.resolveOsSummary.mockReturnValue({ label: "test-os" });
    mocks.createStatusScanCoreBootstrap.mockResolvedValue({
      tailscaleMode: "serve",
      tailscaleDnsPromise: Promise.resolve("box.tail.ts.net"),
      updatePromise: Promise.resolve({ installKind: "git" }),
      agentStatusPromise: Promise.resolve({
        defaultId: "main",
        agents: [],
        totalSessions: 0,
        bootstrapPendingCount: 0,
      }),
      gatewayProbePromise: Promise.resolve({
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "missing gateway.remote.url (fallback local)",
        },
        remoteUrlMissing: true,
        gatewayMode: "remote",
        gatewayProbeAuth: { token: "tok" },
        gatewayProbeAuthWarning: "warn",
        gatewayProbe: { ok: true, error: null },
        gatewayReachable: true,
        gatewaySelf: { host: "box" },
        gatewayCallOverrides: {
          url: "ws://127.0.0.1:18789",
          token: "tok",
        },
      }),
      resolveTailscaleHttpsUrl: vi.fn(async () => "https://box.tail.ts.net"),
      skipColdStartNetworkChecks: false,
    });
    mocks.callGateway.mockResolvedValue({ channelAccounts: {} });
    mocks.collectChannelStatusIssues.mockReturnValue([{ channel: "quietchat", message: "boom" }]);
    mocks.buildChannelsTable.mockResolvedValue({ rows: [], details: [] });
  });

  it("uses gateway fallback overrides for channels.status when requested", async () => {
    const result = await collectStatusScanOverview({
      commandName: "status --all",
      opts: { timeoutMs: 1234 },
      showSecrets: false,
      useGatewayCallOverridesForChannelsStatus: true,
    });

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    const gatewayRequest = mocks.callGateway.mock.calls.at(0)?.[0];
    expect(gatewayRequest?.method).toBe("channels.status");
    expect(gatewayRequest?.url).toBe("ws://127.0.0.1:18789");
    expect(gatewayRequest?.token).toBe("tok");
    expect(mocks.buildChannelsTable).toHaveBeenCalledOnce();
    const channelTableCall = mocks.buildChannelsTable.mock.calls.at(0);
    expect(typeof channelTableCall?.[0]).toBe("object");
    expect(channelTableCall?.[1]?.includeSetupFallbackPlugins).toBe(true);
    expect(channelTableCall?.[1]?.showSecrets).toBe(false);
    expect(channelTableCall?.[1]?.sourceConfig).toStrictEqual({ session: {} });
    expect(result.channelIssues).toEqual([{ channel: "quietchat", message: "boom" }]);
  });

  it("can keep channel overview on metadata-only status paths", async () => {
    const result = await collectStatusScanOverview({
      commandName: "status",
      opts: { timeoutMs: 1234 },
      showSecrets: false,
      includeLiveChannelStatus: false,
      includeChannelSetupRuntimeFallback: false,
    });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.buildChannelsTable).toHaveBeenCalledOnce();
    const channelTableCall = mocks.buildChannelsTable.mock.calls.at(0);
    expect(typeof channelTableCall?.[0]).toBe("object");
    expect(channelTableCall?.[1]?.includeSetupFallbackPlugins).toBe(false);
    expect(channelTableCall?.[1]?.showSecrets).toBe(false);
    expect(channelTableCall?.[1]?.sourceConfig).toStrictEqual({ session: {} });
    expect(result.channelIssues).toStrictEqual([]);
  });

  it("skips channels.status when the gateway is unreachable", async () => {
    mocks.createStatusScanCoreBootstrap.mockResolvedValueOnce({
      tailscaleMode: "off",
      tailscaleDnsPromise: Promise.resolve(null),
      updatePromise: Promise.resolve({ installKind: "git" }),
      agentStatusPromise: Promise.resolve({
        defaultId: "main",
        agents: [],
        totalSessions: 0,
        bootstrapPendingCount: 0,
      }),
      gatewayProbePromise: Promise.resolve({
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "default",
        },
        remoteUrlMissing: false,
        gatewayMode: "local",
        gatewayProbeAuth: {},
        gatewayProbeAuthWarning: undefined,
        gatewayProbe: null,
        gatewayReachable: false,
        gatewaySelf: null,
      }),
      resolveTailscaleHttpsUrl: vi.fn(async () => null),
      skipColdStartNetworkChecks: false,
    });
    const result = await collectStatusScanOverview({
      commandName: "status",
      opts: {},
      showSecrets: true,
    });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.channelsStatus).toBeNull();
    expect(result.channelIssues).toStrictEqual([]);
  });
});
