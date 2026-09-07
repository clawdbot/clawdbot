// Status scan tests cover fast scan defaults, memory setup, gateway probes, and status aggregation.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStatusScanDefaults,
  createStatusMemorySearchConfig,
  createStatusMemorySearchManager,
  createStatusScanSharedMocks,
  createStatusScanConfig,
  createStatusSummary,
  loadStatusScanModuleForTest,
} from "./status.scan.test-helpers.js";

const mocks = {
  ...createStatusScanSharedMocks("status-scan"),
  buildChannelsTable: vi.fn(),
  callGateway: vi.fn(),
  getStatusCommandSecretTargetIds: vi.fn(() => new Set<string>()),
};

let originalForceStderr: boolean;
let loggingStateRef: typeof import("../logging/state.js").loggingState;
let scanStatus: typeof import("./status.scan.js").scanStatus;

beforeAll(async () => {
  configureScanStatus();
  ({ scanStatus } = await loadStatusScanModuleForTest(mocks));
  ({ loggingState: loggingStateRef } = await import("../logging/state.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  configureScanStatus();
  originalForceStderr = loggingStateRef.forceConsoleToStderr;
  loggingStateRef.forceConsoleToStderr = false;
});

afterEach(() => {
  loggingStateRef.forceConsoleToStderr = originalForceStderr;
});

function configureScanStatus(
  options: {
    hasConfiguredChannels?: boolean;
    sourceConfig?: ReturnType<typeof createStatusScanConfig>;
    resolvedConfig?: ReturnType<typeof createStatusScanConfig>;
    summary?: ReturnType<typeof createStatusSummary>;
    update?: false;
    gatewayProbe?: false;
    memoryConfigured?: boolean;
  } = {},
) {
  const sourceConfig = options.memoryConfigured
    ? createStatusMemorySearchConfig()
    : (options.sourceConfig ?? createStatusScanConfig());
  const resolvedConfig = options.memoryConfigured
    ? createStatusMemorySearchConfig()
    : (options.resolvedConfig ?? sourceConfig);

  applyStatusScanDefaults(mocks, {
    hasConfiguredChannels: options.hasConfiguredChannels,
    sourceConfig,
    resolvedConfig,
    summary: options.summary,
    update: options.update,
    gatewayProbe: options.gatewayProbe,
    ...(options.memoryConfigured ? { memoryManager: createStatusMemorySearchManager() } : {}),
  });
  mocks.buildChannelsTable.mockResolvedValue({
    rows: [],
    details: [],
  });
  mocks.callGateway.mockImplementation(async ({ method }: { method?: string }) =>
    method === "status" ? { degradedSecretOwners: [], degradedPlugins: [] } : null,
  );
  mocks.getStatusCommandSecretTargetIds.mockReturnValue(new Set<string>());
}

function firstBuildChannelsTableCall(): unknown[] {
  const call = mocks.buildChannelsTable.mock.calls[0];
  if (!call) {
    throw new Error("expected buildChannelsTable call");
  }
  return call;
}

describe("scanStatus", () => {
  it("passes sourceConfig into buildChannelsTable for summary-mode status output", async () => {
    const sourceConfig = createStatusScanConfig({
      marker: "source",
      plugins: { enabled: false },
    });
    const resolvedConfig = createStatusScanConfig({
      marker: "resolved",
      plugins: { enabled: false },
    });
    configureScanStatus({
      hasConfiguredChannels: true,
      sourceConfig,
      resolvedConfig,
      summary: createStatusSummary({ linkChannel: { linked: false } }),
    });

    await scanStatus({});

    expect(mocks.getStatusSummary).toHaveBeenCalledWith({
      config: resolvedConfig,
      sourceConfig,
      includeChannelSummary: false,
    });
    expect(mocks.buildChannelsTable).toHaveBeenCalledOnce();
    expect(firstBuildChannelsTableCall()).toStrictEqual([
      resolvedConfig,
      {
        showSecrets: true,
        includeSetupFallbackPlugins: false,
        sourceConfig,
        liveChannelStatus: null,
      },
    ]);
  });

  it("keeps default text status off live channel status and setup fallback while resolving channel credentials", async () => {
    const cfg = createStatusScanConfig();
    configureScanStatus({
      hasConfiguredChannels: true,
      sourceConfig: cfg,
      resolvedConfig: cfg,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 12,
      error: null,
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    await scanStatus({});

    expect(
      mocks.callGateway.mock.calls.some(([call]) => {
        return (call as { method?: unknown } | undefined)?.method === "channels.status";
      }),
    ).toBe(false);
    expect(mocks.getUpdateCheckResult).toHaveBeenCalledWith({
      timeoutMs: 2500,
      fetchGit: false,
      includeRegistry: false,
      updateConfigChannel: null,
    });
    expect(mocks.getStatusCommandSecretTargetIds).toHaveBeenCalledWith(cfg, process.env);
    expect(mocks.buildChannelsTable).toHaveBeenCalledOnce();
    expect(firstBuildChannelsTableCall()).toStrictEqual([
      cfg,
      {
        showSecrets: true,
        includeSetupFallbackPlugins: false,
        sourceConfig: cfg,
        liveChannelStatus: null,
      },
    ]);
  });

  it("bounds gateway secret resolution by the fast status probe budget", async () => {
    configureScanStatus();

    await scanStatus({});

    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({ gatewaySecretResolveTimeoutMs: 2500 }),
    );
  });

  it("uses live channel status and setup fallback for deep text status", async () => {
    const cfg = createStatusScanConfig();
    const liveChannelStatus = {
      ok: true,
      accounts: [],
      checkedAt: "2026-05-09T07:30:00.000Z",
    };
    configureScanStatus({
      hasConfiguredChannels: true,
      sourceConfig: cfg,
      resolvedConfig: cfg,
    });
    mocks.callGateway.mockImplementation(async ({ method }: { method?: string }) =>
      method === "status" ? { degradedSecretOwners: [], degradedPlugins: [] } : liveChannelStatus,
    );
    mocks.probeGateway.mockResolvedValue({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 12,
      error: null,
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    await scanStatus({ deep: true, timeoutMs: 5000 });

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(
      mocks.callGateway.mock.calls.find(([call]) => call?.method === "channels.status")?.[0],
    ).toStrictEqual({
      config: cfg,
      configPath: mocks.resolveConfigPath(),
      method: "channels.status",
      params: {
        probe: false,
        timeoutMs: 5000,
      },
      timeoutMs: 2500,
    });
    expect(mocks.buildChannelsTable).toHaveBeenCalledOnce();
    expect(firstBuildChannelsTableCall()).toStrictEqual([
      cfg,
      {
        showSecrets: true,
        sourceConfig: cfg,
        includeSetupFallbackPlugins: true,
        liveChannelStatus,
      },
    ]);
  });

  it("skips gateway and update probes on cold-start status paths", async () => {
    configureScanStatus({
      sourceConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
      resolvedConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
      update: false,
      gatewayProbe: false,
    });

    await scanStatus({});

    expect(mocks.getUpdateCheckResult).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });

  it("keeps default text status off plugin compatibility and memory scans", async () => {
    configureScanStatus({ memoryConfigured: true });

    await scanStatus({});

    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
    expect(mocks.getMemorySearchManager).not.toHaveBeenCalled();
  });
});
