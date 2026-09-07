// Channel doctor tests cover shared channel health checks and repair hints.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDoctorEmptyAllowlistAccountContext } from "../../../channels/plugins/types.adapters.js";
import { normalizeResolvedSecretInputString } from "../../../config/types.secrets.js";
import {
  collectChannelDoctorCompatibilityMutations,
  collectChannelDoctorEmptyAllowlistExtraWarnings,
  collectChannelDoctorMutableAllowlistWarnings,
  collectChannelDoctorPreviewWarnings,
  collectChannelDoctorStaleConfigMutations,
  createChannelDoctorEmptyAllowlistPolicyHooks,
} from "./channel-doctor.js";
import { scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan.js";

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

// Account-id resolution itself is covered by channel-capabilities.test.ts; here we
// only pin that the scanner forwards childAccounts through the hooks to adapters.
vi.mock("../channel-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel-capabilities.js")>();
  return {
    ...actual,
    resolveDoctorChannelAccountIds: (
      _channelName: string,
      _cfg: unknown,
      configuredAccountIds: string[],
    ) => ({ configured: configuredAccountIds, runtime: configuredAccountIds }),
  };
});

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

    expect(result).toStrictEqual([]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).not.toHaveBeenCalled();
  });

  it("skips plugin discovery when only channel defaults are configured", async () => {
    const result = await collectChannelDoctorStaleConfigMutations({
      channels: {
        defaults: {
          enabled: true,
        },
        modelByChannel: {
          discord: "openai/gpt-5.6-luna",
        },
        " ": { token: "dummy" },
      },
    } as never);

    expect(result).toStrictEqual([]);
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).not.toHaveBeenCalled();
    expect(mocks.getLoadedChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalled();
    expect(mocks.getBundledChannelPlugin).not.toHaveBeenCalled();
  });

  it("limits stale config cleanup to requested channel ids", async () => {
    const matrixCleanup = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["matrix cleanup"],
    }));
    const discordCleanup = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["discord cleanup"],
    }));
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) => ({
      id,
      doctor: {
        cleanStaleConfig: id === "matrix" ? matrixCleanup : discordCleanup,
      },
    }));
    const cfg = {
      channels: {
        discord: { enabled: true },
        matrix: { enabled: true },
      },
    };

    const result = await collectChannelDoctorStaleConfigMutations(cfg as never, {
      channelIds: ["matrix"],
    });

    expect(result).toHaveLength(1);
    expect(matrixCleanup).toHaveBeenCalledTimes(1);
    expect(discordCleanup).not.toHaveBeenCalled();
  });

  it("retains warning-only stale results without advancing config", async () => {
    const cfg = {
      channels: {
        matrix: { enabled: true },
        discord: { enabled: true },
      },
    };
    const alternateConfig = {
      ...cfg,
      channels: { ...cfg.channels, matrix: { enabled: false } },
    };
    const matrixCleanup = vi.fn(() => ({
      config: alternateConfig,
      changes: [],
      warnings: ["matrix warning"],
    }));
    const discordCleanup = vi.fn(({ cfg: currentCfg }: { cfg: unknown }) => ({
      config: currentCfg,
      changes: ["discord cleanup"],
    }));
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) => ({
      id,
      doctor: {
        cleanStaleConfig: id === "matrix" ? matrixCleanup : discordCleanup,
      },
    }));

    const result = await collectChannelDoctorStaleConfigMutations(cfg as never, {
      channelIds: ["matrix", "discord"],
    });

    expect(result).toEqual([
      { config: cfg, changes: [], warnings: ["matrix warning"] },
      { config: cfg, changes: ["discord cleanup"] },
    ]);
    expect(discordCleanup).toHaveBeenCalledWith({ cfg });
  });

  it("skips plugin discovery for explicitly disabled channels", () => {
    const result = collectChannelDoctorCompatibilityMutations({
      channels: {
        mattermost: {
          enabled: false,
        },
      },
    } as never);

    expect(result).toStrictEqual([]);
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

  it("keeps unresolved SecretRef preview reads non-fatal", async () => {
    const collectPreviewWarnings = vi.fn(() => {
      normalizeResolvedSecretInputString({
        value: { source: "exec", provider: "default", id: "matrix/access-token" },
        path: "channels.matrix.accessToken",
      });
      return ["unreachable"];
    });
    mockReadOnlyMatrixPlugin({ collectPreviewWarnings });
    const cfg = createMatrixEnabledConfig();

    const result = await collectChannelDoctorPreviewWarnings({
      cfg: cfg as never,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result).toEqual([
      "- channels.matrix: configured SecretRef at channels.matrix.accessToken is unavailable in doctor preview; skipping secret-backed channel preview checks.",
    ]);
    expect(collectPreviewWarnings).toHaveBeenCalledTimes(1);
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

    expect(result).toStrictEqual([]);
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

  it("forwards container-scope child accounts through the empty allowlist hooks", () => {
    const collectEmptyAllowlistExtraWarnings = vi.fn(
      (_context: ChannelDoctorEmptyAllowlistAccountContext): string[] => [],
    );
    const cfg = {
      channels: {
        matrix: {
          groupPolicy: "allowlist",
          accounts: {
            work: { groups: { "!room:example.org": {} } },
          },
        },
      },
    };
    const env = { OPENCLAW_HOME: "/tmp/openclaw-test-home" };
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [{ id: "matrix", doctor: { collectEmptyAllowlistExtraWarnings } }],
    });

    const hooks = createChannelDoctorEmptyAllowlistPolicyHooks({ cfg: cfg as never, env });
    scanEmptyAllowlistPolicyWarnings(cfg as never, {
      doctorFixCommand: "openclaw doctor --fix",
      ...hooks,
    });

    const contexts = collectEmptyAllowlistExtraWarnings.mock.calls.map(([context]) => context);
    const parent = contexts.find((context) => context.prefix === "channels.matrix");
    const account = contexts.find((context) => context.prefix === "channels.matrix.accounts.work");

    expect(parent?.childAccounts).toHaveLength(1);
    expect(account?.childAccounts).toBeUndefined();
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
