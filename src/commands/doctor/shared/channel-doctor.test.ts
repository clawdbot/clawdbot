import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectChannelDoctorCompatibilityMutations,
  collectChannelDoctorEmptyAllowlistExtraWarnings,
  collectChannelDoctorMutableAllowlistWarnings,
  collectChannelDoctorStaleConfigMutations,
  createChannelDoctorEmptyAllowlistPolicyHooks,
} from "./channel-doctor.js";

const mocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
  getBundledChannelPlugin: vi.fn(),
  getBundledChannelSetupPlugin: vi.fn(),
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
}));

const READ_ONLY_CHANNEL_DOCTOR_OPTIONS = {
  includePersistedAuthState: false,
  includeSetupFallbackPlugins: true,
} as const;

vi.mock("../../../channels/plugins/registry.js", () => ({
  getLoadedChannelPlugin: (...args: Parameters<typeof mocks.getLoadedChannelPlugin>) =>
    mocks.getLoadedChannelPlugin(...args),
}));

vi.mock("../../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: (...args: Parameters<typeof mocks.getBundledChannelPlugin>) =>
    mocks.getBundledChannelPlugin(...args),
  getBundledChannelSetupPlugin: (...args: Parameters<typeof mocks.getBundledChannelSetupPlugin>) =>
    mocks.getBundledChannelSetupPlugin(...args),
}));

vi.mock("../../../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: (
    ...args: Parameters<typeof mocks.resolveReadOnlyChannelPluginsForConfig>
  ) => mocks.resolveReadOnlyChannelPluginsForConfig(...args),
}));

function createMatrixEnabledConfig() {
  return {
    channels: {
      matrix: {
        enabled: true,
      },
    },
  };
}

function createNormalizeCompatibilityConfig(change = "matrix") {
  return vi.fn(({ cfg }: { cfg: unknown }) => ({
    config: cfg,
    changes: [change],
  }));
}

function mockReadOnlyMatrixPlugin(doctor?: Record<string, unknown>) {
  mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
    plugins: [
      {
        id: "matrix",
        ...(doctor ? { doctor } : {}),
      },
    ],
  });
}

function mockBundledMatrixSetupPlugin(doctor?: Record<string, unknown>) {
  mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) =>
    id === "matrix"
      ? {
          id: "matrix",
          ...(doctor ? { doctor } : {}),
        }
      : undefined,
  );
}

function mockBundledMatrixRuntimePlugin(doctor?: Record<string, unknown>) {
  mocks.getBundledChannelPlugin.mockImplementation((id: string) =>
    id === "matrix"
      ? {
          id: "matrix",
          ...(doctor ? { doctor } : {}),
        }
      : undefined,
  );
}

function expectMatrixDoctorLookupCalls(cfg?: unknown) {
  if (cfg) {
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      cfg,
      READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
    );
  }
  expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("matrix");
  expect(mocks.getBundledChannelSetupPlugin).toHaveBeenCalledWith("matrix");
  expect(mocks.getBundledChannelPlugin).toHaveBeenCalledWith("matrix");
}

async function expectRuntimeWarningFallback(params: {
  cfg: unknown;
  normalizeCompatibilityConfig: ReturnType<typeof vi.fn>;
  collectMutableAllowlistWarnings: ReturnType<typeof vi.fn>;
}) {
  expect(collectChannelDoctorCompatibilityMutations(params.cfg as never)).toHaveLength(1);
  await expect(
    collectChannelDoctorMutableAllowlistWarnings({ cfg: params.cfg as never }),
  ).resolves.toEqual(["runtime warning"]);
  expect(params.normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
  expect(params.collectMutableAllowlistWarnings).toHaveBeenCalledTimes(1);
}

describe("channel doctor compatibility mutations", () => {
  beforeEach(() => {
    mocks.getLoadedChannelPlugin.mockReset();
    mocks.getBundledChannelPlugin.mockReset();
    mocks.getBundledChannelSetupPlugin.mockReset();
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReset();
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
    mocks.getBundledChannelPlugin.mockReturnValue(undefined);
    mocks.getBundledChannelSetupPlugin.mockReturnValue(undefined);
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({ plugins: [] });
  });

  it("skips plugin discovery when no channels are configured", () => {
    const result = collectChannelDoctorCompatibilityMutations({} as never);

    expect(result).toEqual([]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).not.toHaveBeenCalled();
  });

  it("skips plugin discovery when only channel defaults are configured", async () => {
    const result = await collectChannelDoctorStaleConfigMutations({
      channels: {
        defaults: {
          enabled: true,
        },
      },
    } as never);

    expect(result).toEqual([]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).not.toHaveBeenCalled();
    expect(mocks.getLoadedChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelPlugin).not.toHaveBeenCalled();
  });

  it("skips plugin discovery for explicitly disabled channels", () => {
    const result = collectChannelDoctorCompatibilityMutations({
      channels: {
        mattermost: {
          enabled: false,
        },
      },
    } as never);

    expect(result).toEqual([]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).not.toHaveBeenCalled();
    expect(mocks.getLoadedChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelPlugin).not.toHaveBeenCalled();
  });

  it("uses read-only doctor adapters for configured channel ids", () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig();
    mockReadOnlyMatrixPlugin({ normalizeCompatibilityConfig });
    const cfg = createMatrixEnabledConfig();

    const result = collectChannelDoctorCompatibilityMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expectMatrixDoctorLookupCalls(cfg);
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalledWith("discord");
  });

  it("merges partial doctor adapters instead of masking runtime-only hooks", async () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig();
    const collectMutableAllowlistWarnings = vi.fn(() => ["runtime warning"]);
    mockReadOnlyMatrixPlugin({ normalizeCompatibilityConfig });
    mockBundledMatrixRuntimePlugin({ collectMutableAllowlistWarnings });
    const cfg = createMatrixEnabledConfig();

    await expectRuntimeWarningFallback({
      cfg,
      normalizeCompatibilityConfig,
      collectMutableAllowlistWarnings,
    });
  });

  it("ignores malformed doctor adapter values so valid fallbacks still run", async () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig("setup");
    const collectMutableAllowlistWarnings = vi.fn(() => ["runtime warning"]);
    mockReadOnlyMatrixPlugin({
      normalizeCompatibilityConfig: null,
      collectMutableAllowlistWarnings: "not-a-function",
      warnOnEmptyGroupSenderAllowlist: "yes",
    });
    mockBundledMatrixSetupPlugin({ normalizeCompatibilityConfig });
    mockBundledMatrixRuntimePlugin({ collectMutableAllowlistWarnings });
    const cfg = createMatrixEnabledConfig();

    await expectRuntimeWarningFallback({
      cfg,
      normalizeCompatibilityConfig,
      collectMutableAllowlistWarnings,
    });
  });

  it("falls back to setup doctor adapters when read-only plugins lack doctor hooks", () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig();
    mockReadOnlyMatrixPlugin();
    mockBundledMatrixSetupPlugin({ normalizeCompatibilityConfig });
    const cfg = createMatrixEnabledConfig();

    const result = collectChannelDoctorCompatibilityMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expectMatrixDoctorLookupCalls(cfg);
  });

  it("falls back to bundled runtime doctor adapters when setup adapters lack doctor hooks", () => {
    const normalizeCompatibilityConfig = createNormalizeCompatibilityConfig();
    mockReadOnlyMatrixPlugin();
    mockBundledMatrixSetupPlugin();
    mockBundledMatrixRuntimePlugin({ normalizeCompatibilityConfig });
    const cfg = createMatrixEnabledConfig();

    const result = collectChannelDoctorCompatibilityMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expectMatrixDoctorLookupCalls();
  });

  it("passes explicit env into read-only channel plugin discovery", () => {
    const cfg = createMatrixEnabledConfig();
    const env = { OPENCLAW_HOME: "/tmp/openclaw-test-home" };

    collectChannelDoctorCompatibilityMutations(cfg as never, { env });

    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      env,
      ...READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
    });
  });

  it("keeps configured channel doctor lookup non-fatal when setup loading fails", () => {
    mocks.resolveReadOnlyChannelPluginsForConfig.mockImplementation(() => {
      throw new Error("missing runtime dep");
    });
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) => {
      if (id === "discord") {
        throw new Error("missing runtime dep");
      }
      return undefined;
    });

    const result = collectChannelDoctorCompatibilityMutations({
      channels: {
        discord: {
          enabled: true,
        },
      },
    } as never);

    expect(result).toEqual([]);
    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("discord");
    expect(mocks.getBundledChannelSetupPlugin).toHaveBeenCalledWith("discord");
    expect(mocks.getBundledChannelPlugin).toHaveBeenCalledWith("discord");
  });

  it("uses config for empty allowlist lookup without exposing it to plugin hooks", () => {
    const collectEmptyAllowlistExtraWarnings = vi.fn(({ prefix }: { prefix: string }) => [
      `${prefix} extra`,
    ]);
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
        },
      },
    };
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          doctor: { collectEmptyAllowlistExtraWarnings },
        },
      ],
    });

    const result = collectChannelDoctorEmptyAllowlistExtraWarnings({
      account: {},
      channelName: "matrix",
      cfg: cfg as never,
      prefix: "channels.matrix",
    });

    expect(result).toEqual(["channels.matrix extra"]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      cfg,
      READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
    );
    expect(collectEmptyAllowlistExtraWarnings.mock.calls[0]?.[0]).not.toHaveProperty("cfg");
  });

  it("reuses empty allowlist doctor entries across per-account hooks", () => {
    const collectEmptyAllowlistExtraWarnings = vi.fn(({ prefix }: { prefix: string }) => [
      `${prefix} extra`,
    ]);
    const shouldSkipDefaultEmptyGroupAllowlistWarning = vi.fn(() => true);
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            work: {},
            personal: {},
          },
        },
        slack: {
          accounts: {
            team: {},
          },
        },
      },
    };
    const env = { OPENCLAW_HOME: "/tmp/openclaw-test-home" };
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          doctor: {
            collectEmptyAllowlistExtraWarnings,
            shouldSkipDefaultEmptyGroupAllowlistWarning,
          },
        },
        {
          id: "slack",
          doctor: {
            collectEmptyAllowlistExtraWarnings,
          },
        },
      ],
    });

    const hooks = createChannelDoctorEmptyAllowlistPolicyHooks({ cfg: cfg as never, env });

    expect(
      hooks.extraWarningsForAccount({
        account: {},
        channelName: "matrix",
        prefix: "channels.matrix.accounts.work",
      }),
    ).toEqual(["channels.matrix.accounts.work extra"]);
    expect(
      hooks.shouldSkipDefaultEmptyGroupAllowlistWarning({
        account: {},
        channelName: "matrix",
        prefix: "channels.matrix.accounts.work",
      }),
    ).toBe(true);
    expect(
      hooks.extraWarningsForAccount({
        account: {},
        channelName: "matrix",
        prefix: "channels.matrix.accounts.personal",
      }),
    ).toEqual(["channels.matrix.accounts.personal extra"]);
    expect(
      hooks.extraWarningsForAccount({
        account: {},
        channelName: "slack",
        prefix: "channels.slack.accounts.team",
      }),
    ).toEqual(["channels.slack.accounts.team extra"]);

    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      env,
      ...READ_ONLY_CHANNEL_DOCTOR_OPTIONS,
    });
    expect(collectEmptyAllowlistExtraWarnings).toHaveBeenCalledTimes(3);
    expect(shouldSkipDefaultEmptyGroupAllowlistWarning).toHaveBeenCalledTimes(1);
  });
});
