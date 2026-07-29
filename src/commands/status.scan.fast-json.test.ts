// Status scan fast-json tests cover scan defaults, memory config, and JSON-safe status payloads.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
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
  callGateway: vi.fn(),
  getStatusCommandSecretTargetIds: vi.fn(() => []),
  resolveMemorySearchConfig: vi.fn(),
};

let originalForceStderr: boolean;
let loggingStateRef: typeof import("../logging/state.js").loggingState;
let scanStatusJsonFast: typeof import("./status.scan.fast-json.js").scanStatusJsonFast;

const STATUS_JSON_TEST_CHANNEL_ENV_PREFIXES = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter(
  (entry) => entry.configurable !== false,
).map((entry) => `${entry.channelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`);
const STATUS_JSON_TEST_CHANNEL_ENV_VARS = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter(
  (entry) => entry.configurable !== false,
).flatMap((entry) => entry.channelEnvVars ?? []);

function clearStatusJsonChannelEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of STATUS_JSON_TEST_CHANNEL_ENV_VARS) {
    env[key] = undefined;
  }
  for (const key of Object.keys(process.env)) {
    if (STATUS_JSON_TEST_CHANNEL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = undefined;
    }
  }
  return env;
}

function configureFastJsonStatus() {
  applyStatusScanDefaults(mocks, {
    sourceConfig: createStatusMemorySearchConfig(),
    resolvedConfig: createStatusMemorySearchConfig(),
    summary: createStatusSummary({ byAgent: [] }),
    memoryManager: createStatusMemorySearchManager(),
  });
  mocks.getStatusCommandSecretTargetIds.mockReturnValue([]);
  mocks.resolveMemorySearchConfig.mockReturnValue({
    store: { databasePath: "/tmp/main.sqlite" },
  });
}

function firstCallArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  const arg = mock.mock.calls[0]?.[0];
  if (arg === undefined) {
    throw new Error(`expected ${label}`);
  }
  return arg;
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
    mocks.hasConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.getStatusCommandSecretTargetIds).toHaveBeenCalledWith(
      createStatusMemorySearchConfig(),
      process.env,
      { includeChannelTargets: false },
    );
    expect(mocks.hasConfiguredChannelsForReadOnlyScope).not.toHaveBeenCalled();
    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
    expect(loggingStateRef.forceConsoleToStderr).toBe(false);
  });

  it("keeps resolved and source channel configs available without loading runtime plugins", async () => {
    mocks.hasConfiguredChannels.mockReturnValue(true);
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
    mocks.hasConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
  });

  it("keeps default fast JSON update scans local-only", async () => {
    mocks.hasConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({ timeoutMs: 1234 }, {} as never);

    expect(mocks.getUpdateCheckResult).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1234,
        fetchGit: false,
        includeRegistry: false,
      }),
    );
  });

  it("restores registry-backed update checks and remote git fetches when --all is requested", async () => {
    mocks.hasConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({ all: true }, {} as never);

    expect(mocks.getUpdateCheckResult).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 6500,
        fetchGit: true,
        includeRegistry: true,
      }),
    );
  });

  it("keeps the local status RPC fallback off the default fast JSON path", async () => {
    mocks.hasConfiguredChannels.mockReturnValue(true);
    mocks.callGateway.mockResolvedValue({ sessions: 1 });

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.probeGateway).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("honors explicit gateway probe timeouts on the lean JSON path", async () => {
    mocks.hasConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({ timeoutMs: 5000 }, {} as never);

    expect(mocks.probeGateway).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5000 }));
  });

  it("restores the local status RPC fallback when --all is requested", async () => {
    mocks.hasConfiguredChannels.mockReturnValue(true);
    mocks.callGateway.mockResolvedValue({ sessions: 1 });

    await scanStatusJsonFast({ all: true }, {} as never);

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "status",
        timeoutMs: 2000,
      }),
    );
  });

  it("keeps the fast JSON summary off the channel plugin summary path", async () => {
    mocks.hasConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.getStatusSummary).toHaveBeenCalledOnce();
    const summaryOptions = firstCallArg(mocks.getStatusSummary, "status summary options") as {
      includeChannelSummary?: unknown;
    };
    expect(summaryOptions.includeChannelSummary).toBe(false);
  });

  it("skips memory inspection for the lean status --json fast path", async () => {
    const result = await scanStatusJsonFast({}, {} as never);

    expect(result.memory).toBeNull();
    expect(mocks.hasConfiguredChannels).not.toHaveBeenCalled();
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
    expect(
      firstCallArg(mocks.getMemorySearchManager, "memory search manager options"),
    ).toStrictEqual({
      cfg: createStatusMemorySearchConfig(),
      agentId: "main",
      purpose: "status",
    });
  });

  it("skips gateway and update probes on cold-start status --json", async () => {
    await withTemporaryEnv(
      {
        ...clearStatusJsonChannelEnv(),
        OPENCLAW_TWITCH_ACCESS_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN: undefined,
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

  it("keeps cold-start gateway probes with local-only updates when a channel is configured from manifest env vars", async () => {
    await withTemporaryEnv(
      {
        ...clearStatusJsonChannelEnv(),
        OPENCLAW_TWITCH_ACCESS_TOKEN: "token",
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        NODE_ENV: undefined,
      },
      async () => {
        await scanStatusJsonFast({}, {} as never);
      },
    );

    expect(mocks.getUpdateCheckResult).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchGit: false,
        includeRegistry: false,
      }),
    );
    expect(mocks.probeGateway).toHaveBeenCalled();
  });
});
