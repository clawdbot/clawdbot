// Plugin registry CLI tests cover canonical process-root load scopes.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function withActivatedPluginIdsForTest<T extends Record<string, unknown>>(
  config: T,
  pluginIds: string[],
): T & {
  plugins: {
    allow: string[];
    entries: Record<string, { enabled: true }>;
  };
} {
  return {
    ...config,
    plugins: {
      ...(typeof config.plugins === "object" && config.plugins ? config.plugins : {}),
      allow: pluginIds,
      entries: Object.fromEntries(pluginIds.map((pluginId) => [pluginId, { enabled: true }])),
    },
  };
}

function expectConfiguredChannelPluginIdsParams(expected: {
  config: unknown;
  workspaceDir?: string;
}) {
  expect(mocks.resolveConfiguredChannelPluginIds).toHaveBeenCalledTimes(1);
  const params = mocks.resolveConfiguredChannelPluginIds.mock.calls[0]?.[0] as
    | { config?: unknown; env?: NodeJS.ProcessEnv; workspaceDir?: string }
    | undefined;
  expect(params?.config).toBe(expected.config);
  // Compare identity without exposing ambient credentials in failure output.
  expect(params?.env === process.env).toBe(true);
  expect(params?.workspaceDir).toBe(expected.workspaceDir);
}

function expectLoadOpenClawPluginsCall(
  callIndex: number,
  expected: {
    config?: unknown;
    activationSourceConfig?: unknown;
    autoEnabledReasons?: unknown;
    onlyPluginIds: string[];
    throwOnLoadError: boolean;
    workspaceDir?: string;
  },
) {
  const params = mocks.loadOpenClawPlugins.mock.calls[callIndex]?.[0] as
    | {
        config?: unknown;
        activationSourceConfig?: unknown;
        autoEnabledReasons?: unknown;
        onlyPluginIds?: string[];
        throwOnLoadError?: boolean;
        workspaceDir?: string;
      }
    | undefined;
  if ("config" in expected) {
    expect(params?.config).toEqual(expected.config);
  }
  if ("activationSourceConfig" in expected) {
    expect(params?.activationSourceConfig).toEqual(expected.activationSourceConfig);
  }
  if ("autoEnabledReasons" in expected) {
    expect(params?.autoEnabledReasons).toEqual(expected.autoEnabledReasons);
  }
  expect(params?.onlyPluginIds).toEqual(expected.onlyPluginIds);
  expect(params?.throwOnLoadError).toBe(expected.throwOnLoadError);
  if ("workspaceDir" in expected) {
    expect(params?.workspaceDir).toBe(expected.workspaceDir);
  }
}

const mocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn<typeof import("../plugins/loader.js").loadOpenClawPlugins>(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("../plugins/channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  resolveChannelPluginIds:
    vi.fn<typeof import("../plugins/channel-plugin-ids.js").resolveChannelPluginIds>(),
  resolveEffectivePluginIds:
    vi.fn<typeof import("../plugins/effective-plugin-ids.js").resolveEffectivePluginIds>(),
  resolvePluginRuntimeLoadContext:
    vi.fn<
      typeof import("../plugins/runtime/load-context.resolve.js").resolvePluginRuntimeLoadContext
    >(),
}));

let ensurePluginRegistryLoaded: typeof import("./plugin-registry.js").ensurePluginRegistryLoaded;

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
    mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: (
    ...args: Parameters<typeof mocks.resolveConfiguredChannelPluginIds>
  ) => mocks.resolveConfiguredChannelPluginIds(...args),
  resolveChannelPluginIds: (...args: Parameters<typeof mocks.resolveChannelPluginIds>) =>
    mocks.resolveChannelPluginIds(...args),
}));

vi.mock("../plugins/effective-plugin-ids.js", () => ({
  resolveEffectivePluginIds: (...args: Parameters<typeof mocks.resolveEffectivePluginIds>) =>
    mocks.resolveEffectivePluginIds(...args),
}));

vi.mock("../plugins/runtime/load-context.resolve.js", () => ({
  resolvePluginRuntimeLoadContext: (
    ...args: Parameters<typeof mocks.resolvePluginRuntimeLoadContext>
  ) => mocks.resolvePluginRuntimeLoadContext(...args),
}));

vi.mock("../plugins/runtime/load-context.js", () => ({
  buildPluginRuntimeLoadOptions: (
    values: {
      config: unknown;
      activationSourceConfig: unknown;
      autoEnabledReasons: Readonly<Record<string, string[]>>;
      workspaceDir: string | undefined;
      env: NodeJS.ProcessEnv;
      logger: typeof logger;
    },
    overrides?: Record<string, unknown>,
  ) => ({
    config: values.config,
    activationSourceConfig: values.activationSourceConfig,
    autoEnabledReasons: values.autoEnabledReasons,
    workspaceDir: values.workspaceDir,
    env: values.env,
    logger: values.logger,
    ...overrides,
  }),
}));

describe("ensurePluginRegistryLoaded", () => {
  beforeAll(async () => {
    const mod = await import("./plugin-registry.js");
    ensurePluginRegistryLoaded = mod.ensurePluginRegistryLoaded;
  });

  beforeEach(() => {
    mocks.loadOpenClawPlugins.mockReset();
    mocks.resolveConfiguredChannelPluginIds.mockReset();
    mocks.resolveChannelPluginIds.mockReset();
    mocks.resolveEffectivePluginIds.mockReset();
    mocks.resolvePluginRuntimeLoadContext.mockReset();
    mocks.resolveEffectivePluginIds.mockReturnValue(["demo"]);
    mocks.resolvePluginRuntimeLoadContext.mockImplementation((options) => {
      const rawConfig = (options?.config ?? {}) as Record<string, unknown>;
      return {
        rawConfig,
        config: rawConfig,
        activationSourceConfig: (options?.activationSourceConfig ?? rawConfig) as Record<
          string,
          unknown
        >,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/workspace",
        env: options?.env ?? process.env,
        logger,
      } as never;
    });
  });

  it("uses the resolved runtime load context for configured channel scope", () => {
    const baseConfig = {
      channels: {
        "demo-chat": {
          botToken: "demo-bot-token",
          appToken: "demo-app-token",
        },
      },
    };
    const autoEnabledConfig = withActivatedPluginIdsForTest(baseConfig, ["demo-chat"]);

    mocks.resolvePluginRuntimeLoadContext.mockReturnValue({
      rawConfig: baseConfig,
      config: autoEnabledConfig,
      activationSourceConfig: baseConfig,
      autoEnabledReasons: {
        "demo-chat": ["demo-chat configured"],
      },
      workspaceDir: "/tmp/workspace",
      env: process.env,
      logger,
    } as never);
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-chat"]);

    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expectConfiguredChannelPluginIdsParams({
      config: autoEnabledConfig,
      workspaceDir: "/tmp/workspace",
    });
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expectLoadOpenClawPluginsCall(0, {
      config: autoEnabledConfig,
      activationSourceConfig: autoEnabledConfig,
      autoEnabledReasons: {
        "demo-chat": ["demo-chat configured"],
      },
      onlyPluginIds: ["demo-chat"],
      throwOnLoadError: true,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("reloads when escalating from configured-channels to channels", () => {
    const config = {
      plugins: { enabled: true },
      channels: { "demo-channel-a": { enabled: false } },
    };

    mocks.resolvePluginRuntimeLoadContext.mockReturnValue({
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
      logger,
    } as never);
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-channel-a"]);
    mocks.resolveChannelPluginIds.mockReturnValue(["demo-channel-a", "demo-channel-b"]);

    ensurePluginRegistryLoaded({ scope: "configured-channels" });
    ensurePluginRegistryLoaded({ scope: "channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
    expectLoadOpenClawPluginsCall(0, {
      onlyPluginIds: ["demo-channel-a"],
      throwOnLoadError: true,
    });
    expectLoadOpenClawPluginsCall(1, {
      onlyPluginIds: ["demo-channel-a", "demo-channel-b"],
      throwOnLoadError: true,
    });
  });
});
