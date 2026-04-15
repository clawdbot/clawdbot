import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStatusScanDefaults,
  createStatusMemorySearchConfig,
  createStatusMemorySearchManager,
  createStatusScanSharedMocks,
  createStatusSummary,
  loadStatusScanModuleForTest,
  withTemporaryEnv,
} from "./status.scan.test-helpers.js";

const mocks = {
  ...createStatusScanSharedMocks("status-fast-json"),
  getStatusCommandSecretTargetIds: vi.fn(() => []),
  resolveMemorySearchConfig: vi.fn(),
};

let originalForceStderr: boolean;
let loggingStateRef: typeof import("../logging/state.js").loggingState;
let scanStatusJsonFast: typeof import("./status.scan.fast-json.js").scanStatusJsonFast;

beforeEach(async () => {
  vi.clearAllMocks();
  applyStatusScanDefaults(mocks, {
    sourceConfig: createStatusMemorySearchConfig(),
    resolvedConfig: createStatusMemorySearchConfig(),
    summary: createStatusSummary({ byAgent: [] }),
    memoryManager: createStatusMemorySearchManager(),
  });
  mocks.getStatusCommandSecretTargetIds.mockReturnValue([]);
  mocks.resolveMemorySearchConfig.mockReturnValue({
    store: { path: "/tmp/main.sqlite" },
  });
  ({ scanStatusJsonFast } = await loadStatusScanModuleForTest(mocks, { fastJson: true }));
  ({ loggingState: loggingStateRef } = await import("../logging/state.js"));
  originalForceStderr = loggingStateRef.forceConsoleToStderr;
  loggingStateRef.forceConsoleToStderr = false;
});

afterEach(() => {
  loggingStateRef.forceConsoleToStderr = originalForceStderr;
});

describe("scanStatusJsonFast", () => {
  it("routes plugin logs to stderr during deferred plugin loading", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);

    let stderrDuringLoad = false;
    mocks.ensurePluginRegistryLoaded.mockImplementation(() => {
      stderrDuringLoad = loggingStateRef.forceConsoleToStderr;
    });

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalled();
    expect(stderrDuringLoad).toBe(true);
    expect(loggingStateRef.forceConsoleToStderr).toBe(false);
  });

  it("preloads configured channel plugins from the resolved snapshot while preserving source activation config", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    applyStatusScanDefaults(mocks, {
      hasConfiguredChannels: true,
      sourceConfig: {
        channels: {
          telegram: {
            botToken: {
              source: "file",
              provider: "vault",
              id: "/telegram/bot-token",
            },
          },
        },
      } as never,
      resolvedConfig: {
        marker: "resolved-snapshot",
        channels: {
          telegram: {
            botToken: "resolved-token",
          },
        },
      } as never,
    });

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "configured-channels",
        config: expect.objectContaining({ marker: "resolved-snapshot" }),
        activationSourceConfig: expect.objectContaining({
          channels: expect.objectContaining({
            telegram: expect.objectContaining({
              botToken: expect.objectContaining({
                source: "file",
                id: "/telegram/bot-token",
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("skips plugin compatibility loading even when configured channels are present", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
  });

  it("skips memory inspection for the lean status --json fast path", async () => {
    const result = await scanStatusJsonFast({}, {} as never);

    expect(result.memory).toBeNull();
    expect(mocks.hasPotentialConfiguredChannels).toHaveBeenCalledWith(
      expect.any(Object),
      process.env,
      { includePersistedAuthState: false },
    );
    expect(mocks.resolveMemorySearchConfig).not.toHaveBeenCalled();
    expect(mocks.getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("restores memory inspection when --all is requested", async () => {
    const result = await scanStatusJsonFast({ all: true }, {} as never);

    expect(result.memory).toEqual(expect.objectContaining({ agentId: "main" }));
    expect(mocks.resolveMemorySearchConfig).toHaveBeenCalled();
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

  it("skips gateway and update probes on cold-start status --json", async () => {
    await withTemporaryEnv(
      {
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        NODE_ENV: undefined,
      },
      async () => {
        await scanStatusJsonFast({}, {} as never);
      },
    );

    expect(mocks.getUpdateCheckResult).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });
});
