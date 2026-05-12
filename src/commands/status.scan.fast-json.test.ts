import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

function configureFastJsonStatus() {
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
}

beforeAll(async () => {
  configureFastJsonStatus();
  ({ scanStatusJsonFast } = await loadStatusScanModuleForTest(mocks, { fastJson: true }));
  ({ loggingState: loggingStateRef } = await import("../logging/state.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  configureFastJsonStatus();
  originalForceStderr = loggingStateRef.forceConsoleToStderr;
  loggingStateRef.forceConsoleToStderr = false;
});

afterEach(() => {
  loggingStateRef.forceConsoleToStderr = originalForceStderr;
});

describe("scanStatusJsonFast", () => {
  it("does not preload configured channel plugins for the lean JSON path", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.hasConfiguredChannelsForReadOnlyScope).not.toHaveBeenCalled();
    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
    expect(loggingStateRef.forceConsoleToStderr).toBe(false);
  });

  it("keeps resolved and source channel configs available without loading runtime plugins", async () => {
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

    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalled();
  });

  it("skips plugin compatibility loading even when configured channels are present", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
  });

  it("keeps the fast JSON summary off the channel plugin summary path", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.getStatusSummary).toHaveBeenCalledOnce();
    const summaryOptions = mocks.getStatusSummary.mock.calls.at(0)?.[0] as
      | { includeChannelSummary?: unknown }
      | undefined;
    expect(summaryOptions?.includeChannelSummary).toBe(false);
  });

  it("skips memory inspection for the lean status --json fast path", async () => {
    const result = await scanStatusJsonFast({}, {} as never);

    expect(result.memory).toBeNull();
    expect(mocks.hasPotentialConfiguredChannels).toHaveBeenCalledWith(
      createStatusMemorySearchConfig(),
      process.env,
      { includePersistedAuthState: false },
    );
    expect(mocks.resolveMemorySearchConfig).not.toHaveBeenCalled();
    expect(mocks.getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("restores memory inspection when --all is requested", async () => {
    const result = await scanStatusJsonFast({ all: true }, {} as never);

    expect(result.memory).toStrictEqual({
      agentId: "main",
      files: 0,
      chunks: 0,
      dirty: false,
    });
    expect(mocks.resolveMemorySearchConfig).toHaveBeenCalled();
    expect(mocks.getMemorySearchManager).toHaveBeenCalledOnce();
    expect(mocks.getMemorySearchManager.mock.calls.at(0)?.[0]).toStrictEqual({
      cfg: createStatusMemorySearchConfig(),
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
