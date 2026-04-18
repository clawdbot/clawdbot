import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStatusScanDefaults,
  createStatusMemorySearchConfig,
  createStatusMemorySearchManager,
  createStatusScanSharedMocks,
  createStatusScanConfig,
  createStatusSummary,
  loadStatusScanModuleForTest,
  withTemporaryEnv,
} from "./status.scan.test-helpers.js";

const mocks = {
  ...createStatusScanSharedMocks("status-scan"),
  buildChannelsTable: vi.fn(),
  callGateway: vi.fn(),
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
  mocks.callGateway.mockResolvedValue(null);
}

describe("scanStatus", () => {
  it("passes sourceConfig into buildChannelsTable for summary-mode status output", async () => {
    configureScanStatus({
      sourceConfig: createStatusScanConfig({
        marker: "source",
        plugins: { enabled: false },
      }),
      resolvedConfig: createStatusScanConfig({
        marker: "resolved",
        plugins: { enabled: false },
      }),
      summary: createStatusSummary({ linkChannel: { linked: false } }),
    });

    await scanStatus({ json: false }, {} as never);

    expect(mocks.buildChannelsTable).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "resolved" }),
      expect.objectContaining({
        sourceConfig: expect.objectContaining({ marker: "source" }),
      }),
    );
  });

  it("skips channel plugin preload for status --json with no channel config", async () => {
    configureScanStatus({
      sourceConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
      resolvedConfig: createStatusScanConfig({
        plugins: { enabled: false },
      }),
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
  });

  it("skips plugin compatibility loading for status --json when the config file is missing", async () => {
    configureScanStatus({
      sourceConfig: createStatusScanConfig({
        plugins: { enabled: true },
      }),
      resolvedConfig: createStatusScanConfig({
        plugins: { enabled: true },
      }),
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
  });

  it("skips plugin compatibility loading for status --json even with configured channels", async () => {
    configureScanStatus({
      hasConfiguredChannels: true,
      sourceConfig: createStatusScanConfig({
        channels: { discord: {} },
      }),
      resolvedConfig: createStatusScanConfig({
        channels: { discord: {} },
      }),
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
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

    await scanStatus({ json: true }, {} as never);
    await scanStatus({ json: false }, {} as never);

    expect(mocks.getUpdateCheckResult).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });

  it("skips memory backend inspection for default memory-core with no existing store", async () => {
    configureScanStatus();

    await scanStatus({ json: true }, {} as never);

    expect(mocks.getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("inspects memory backend when memory search is explicitly configured", async () => {
    configureScanStatus({ memoryConfigured: true });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.getMemorySearchManager).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            memorySearch: expect.any(Object),
          }),
        }),
      }),
      agentId: "main",
      purpose: "status",
    });
  });

  it("preloads configured channel plugins for status --json when channel config exists", async () => {
    configureScanStatus({
      hasConfiguredChannels: true,
      sourceConfig: createStatusScanConfig({
        marker: "source-preload",
        plugins: { enabled: false },
        channels: { telegram: { enabled: false } },
      }),
      resolvedConfig: createStatusScanConfig({
        marker: "resolved-preload",
        plugins: { enabled: false },
        channels: { telegram: { enabled: false } },
      }),
      summary: createStatusSummary({ linkChannel: { linked: false } }),
    });

    await scanStatus({ json: true }, {} as never);

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "configured-channels",
        config: expect.objectContaining({ marker: "resolved-preload" }),
        activationSourceConfig: expect.objectContaining({ marker: "source-preload" }),
      }),
    );
    // Verify plugin logs were routed to stderr during loading and restored after
    expect(loggingStateRef.forceConsoleToStderr).toBe(false);
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ detailLevel: "presence" }),
    );
    expect(mocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "channels.status" }),
    );
  });

  it("preloads configured channel plugins for status --json when channel auth is env-only", async () => {
    configureScanStatus({
      hasConfiguredChannels: true,
      sourceConfig: createStatusScanConfig({
        marker: "source-env-only",
        plugins: { enabled: false },
      }),
      resolvedConfig: createStatusScanConfig({
        marker: "resolved-env-only",
        plugins: { enabled: false },
      }),
      summary: createStatusSummary({ linkChannel: { linked: false } }),
    });

    await withTemporaryEnv({ MATRIX_ACCESS_TOKEN: "token" }, async () => {
      await scanStatus({ json: true }, {} as never);
    });

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "configured-channels",
        config: expect.objectContaining({ marker: "resolved-env-only" }),
        activationSourceConfig: expect.objectContaining({ marker: "source-env-only" }),
      }),
    );
  });
});
