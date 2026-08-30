// Status scan overview tests cover overview collection and gateway/runtime summary inputs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";
import { withStatusScanOverview } from "./status.scan-overview.ts";

const mocks = vi.hoisted(() => ({
  hasConfiguredChannelsForReadOnlyScope: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
  getStatusCommandSecretTargetIds: vi.fn(),
  readConfigSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  resolveOsSummary: vi.fn(),
  createStatusScanCoreBootstrap: vi.fn(),
  callGateway: vi.fn(),
  collectChannelStatusIssues: vi.fn(),
  buildChannelsTable: vi.fn(),
  applyLoggingConfig: vi.fn(),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  hasConfiguredChannelsForReadOnlyScope: mocks.hasConfiguredChannelsForReadOnlyScope,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getStatusCommandSecretTargetIds: mocks.getStatusCommandSecretTargetIds,
}));

vi.mock("../cli/command-config-snapshot.js", () => ({
  withCommandConfigSnapshot: async (
    _options: unknown,
    run: (snapshot: ConfigFileSnapshot) => unknown,
  ) => run((await mocks.readConfigSnapshot()).snapshot),
}));

vi.mock("../config/config.js", () => ({
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: mocks.resolveOsSummary,
}));

vi.mock("../logging/logger.js", () => ({
  applyLoggingConfig: mocks.applyLoggingConfig,
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

function firstGatewayRequest(): { method?: string; url?: string; token?: string } {
  const call = mocks.callGateway.mock.calls[0];
  if (!call) {
    throw new Error("expected gateway call");
  }
  return call[0] as { method?: string; url?: string; token?: string };
}

function gatewayRequest(method: string): { method?: string; url?: string; token?: string } {
  const call = mocks.callGateway.mock.calls.find(([request]) => request?.method === method);
  if (!call) {
    throw new Error(`expected ${method} gateway call`);
  }
  return call[0] as { method?: string; url?: string; token?: string };
}

type ChannelsTableCall = [
  unknown,
  {
    includeSetupFallbackPlugins?: boolean;
    showSecrets?: boolean;
    sourceConfig?: unknown;
  },
];

function firstChannelsTableCall(): ChannelsTableCall {
  const call = mocks.buildChannelsTable.mock.calls[0];
  if (!call) {
    throw new Error("expected channels table call");
  }
  return call as ChannelsTableCall;
}

describe("withStatusScanOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.hasConfiguredChannelsForReadOnlyScope.mockReturnValue(true);
    mocks.getStatusCommandSecretTargetIds.mockReturnValue([]);
    mocks.readConfigSnapshot.mockResolvedValue({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        valid: true,
        runtimeConfig: { session: {} },
        sourceConfig: { session: { raw: true } },
      },
    });
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
    mocks.callGateway.mockImplementation(async ({ method }: { method?: string }) =>
      method === "status"
        ? { degradedSecretOwners: [], degradedPlugins: [] }
        : { channelAccounts: {} },
    );
    mocks.collectChannelStatusIssues.mockReturnValue([{ channel: "quietchat", message: "boom" }]);
    mocks.buildChannelsTable.mockResolvedValue({ rows: [], details: [] });
  });

  it("uses gateway fallback overrides for channels.status when requested", async () => {
    const result = await withStatusScanOverview(
      {
        commandName: "status --all",
        opts: { timeoutMs: 1234 },
        showSecrets: false,
        useGatewayCallOverridesForChannelsStatus: true,
      },
      (overview) => overview,
    );

    expect(mocks.readConfigSnapshot).toHaveBeenCalledOnce();
    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    const channelsRequest = gatewayRequest("channels.status");
    expect(channelsRequest?.url).toBe("ws://127.0.0.1:18789");
    expect(channelsRequest?.token).toBe("tok");
    expect(mocks.buildChannelsTable).toHaveBeenCalledOnce();
    const channelTableCall = firstChannelsTableCall();
    expect(typeof channelTableCall?.[0]).toBe("object");
    expect(channelTableCall?.[1]?.includeSetupFallbackPlugins).toBe(true);
    expect(channelTableCall?.[1]?.showSecrets).toBe(false);
    expect(channelTableCall?.[1]?.sourceConfig).toStrictEqual({ session: { raw: true } });
    expect(result.channelIssues).toEqual([{ channel: "quietchat", message: "boom" }]);
  });

  it("can keep channel overview on metadata-only status paths", async () => {
    const result = await withStatusScanOverview(
      {
        commandName: "status",
        opts: { timeoutMs: 1234 },
        showSecrets: false,
        includeLiveChannelStatus: false,
        includeChannelSetupRuntimeFallback: false,
      },
      (overview) => overview,
    );

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(firstGatewayRequest().method).toBe("status");
    expect(mocks.buildChannelsTable).toHaveBeenCalledOnce();
    const channelTableCall = firstChannelsTableCall();
    expect(typeof channelTableCall?.[0]).toBe("object");
    expect(channelTableCall?.[1]?.includeSetupFallbackPlugins).toBe(false);
    expect(channelTableCall?.[1]?.showSecrets).toBe(false);
    expect(channelTableCall?.[1]?.sourceConfig).toStrictEqual({ session: { raw: true } });
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
    const result = await withStatusScanOverview(
      {
        commandName: "status",
        opts: {},
        showSecrets: true,
      },
      (overview) => overview,
    );

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.channelsStatus).toBeNull();
    expect(result.channelIssues).toStrictEqual([]);
  });

  it("returns the base overview when a reachable gateway lacks read scope", async () => {
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
        gatewayProbe: {
          ok: false,
          connectLatencyMs: 12,
          error: "missing scope: operator.read",
          auth: {
            role: "operator",
            scopes: [],
            capability: "connected_no_operator_scope",
          },
        },
        gatewayReachable: true,
        gatewaySelf: null,
      }),
      resolveTailscaleHttpsUrl: vi.fn(async () => null),
      skipColdStartNetworkChecks: false,
    });
    mocks.callGateway.mockRejectedValueOnce(new Error("missing scope: operator.read"));

    const result = await withStatusScanOverview(
      {
        commandName: "status",
        opts: {},
        showSecrets: false,
        includeChannelsData: false,
      },
      (overview) => overview,
    );

    expect(result.gatewaySnapshot.gatewayReachable).toBe(true);
    expect(result.gatewaySnapshot.gatewayProbe).toMatchObject({
      ok: false,
      error: "missing scope: operator.read",
    });
    expect(result.runtimeDegradation).toBeNull();
  });
});
