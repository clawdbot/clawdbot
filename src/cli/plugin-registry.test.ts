import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";

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

const mocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn<typeof import("../plugins/loader.js").loadOpenClawPlugins>(),
  getActivePluginRegistry: vi.fn<typeof import("../plugins/runtime.js").getActivePluginRegistry>(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("../plugins/channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  resolveChannelPluginIds:
    vi.fn<typeof import("../plugins/channel-plugin-ids.js").resolveChannelPluginIds>(),
  resolvePluginRuntimeLoadContext:
    vi.fn<typeof import("../plugins/runtime/load-context.js").resolvePluginRuntimeLoadContext>(),
}));

let ensurePluginRegistryLoaded: typeof import("./plugin-registry.js").ensurePluginRegistryLoaded;
let resetPluginRegistryLoadedForTests: typeof import("./plugin-registry.js").__testing.resetPluginRegistryLoadedForTests;

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
    mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: (...args: Parameters<typeof mocks.getActivePluginRegistry>) =>
    mocks.getActivePluginRegistry(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: (
    ...args: Parameters<typeof mocks.resolveConfiguredChannelPluginIds>
  ) => mocks.resolveConfiguredChannelPluginIds(...args),
  resolveChannelPluginIds: (...args: Parameters<typeof mocks.resolveChannelPluginIds>) =>
    mocks.resolveChannelPluginIds(...args),
}));

vi.mock("../plugins/runtime/load-context.js", () => ({
  resolvePluginRuntimeLoadContext: (
    ...args: Parameters<typeof mocks.resolvePluginRuntimeLoadContext>
  ) => mocks.resolvePluginRuntimeLoadContext(...args),
  buildPluginRuntimeLoadOptionsFromValues: (
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
  buildPluginRuntimeLoadOptions: (
    context: {
      config: unknown;
      activationSourceConfig: unknown;
      autoEnabledReasons: Readonly<Record<string, string[]>>;
      workspaceDir: string | undefined;
      env: NodeJS.ProcessEnv;
      logger: typeof logger;
    },
    overrides?: Record<string, unknown>,
  ) => ({
    config: context.config,
    activationSourceConfig: context.activationSourceConfig,
    autoEnabledReasons: context.autoEnabledReasons,
    workspaceDir: context.workspaceDir,
    env: context.env,
    logger: context.logger,
    ...overrides,
  }),
}));

describe("ensurePluginRegistryLoaded", () => {
  beforeAll(async () => {
    const mod = await import("./plugin-registry.js");
    ensurePluginRegistryLoaded = mod.ensurePluginRegistryLoaded;
    resetPluginRegistryLoadedForTests = () => mod.__testing.resetPluginRegistryLoadedForTests();
  });

  beforeEach(() => {
    mocks.loadOpenClawPlugins.mockReset();
    mocks.getActivePluginRegistry.mockReset();
    mocks.resolveConfiguredChannelPluginIds.mockReset();
    mocks.resolveChannelPluginIds.mockReset();
    mocks.resolvePluginRuntimeLoadContext.mockReset();
    resetPluginRegistryLoadedForTests();

    mocks.getActivePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
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

    expect(mocks.resolveConfiguredChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        env: process.env,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        activationSourceConfig: autoEnabledConfig,
        autoEnabledReasons: {
          "demo-chat": ["demo-chat configured"],
        },
        onlyPluginIds: ["demo-chat"],
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
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
    expect(mocks.loadOpenClawPlugins).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        onlyPluginIds: ["demo-channel-a"],
        throwOnLoadError: true,
      }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        onlyPluginIds: ["demo-channel-a", "demo-channel-b"],
        throwOnLoadError: true,
      }),
    );
  });

  it("does not treat a pre-seeded partial registry as all scope", () => {
    const config = {
      plugins: { enabled: true },
      channels: { "demo-channel-a": { enabled: true } },
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
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [],
      channels: [{ plugin: { id: "demo-channel-a" } }],
      tools: [],
    } as never);

    ensurePluginRegistryLoaded({ scope: "all" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("does not treat a tools-only pre-seeded registry as channel scope", () => {
    const config = {
      plugins: { enabled: true },
      channels: { "demo-channel-a": { enabled: true } },
    };
    const activatedConfig = withActivatedPluginIdsForTest(config, ["demo-channel-a"]);

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
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [],
      channels: [],
      tools: [{ pluginId: "demo-tool" }],
    } as never);

    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: activatedConfig,
        activationSourceConfig: activatedConfig,
        onlyPluginIds: ["demo-channel-a"],
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("reloads when a pre-seeded channel registry is missing the configured channel plugin ids", () => {
    const config = {
      plugins: { enabled: true },
      channels: {
        "demo-channel-a": {
          botToken: "demo-bot-token",
          appToken: "demo-app-token",
        },
      },
    };
    const activatedConfig = withActivatedPluginIdsForTest(config, ["demo-channel-a"]);

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
    mocks.getActivePluginRegistry.mockReturnValue({
      plugins: [{ id: "demo-channel-b" }],
      channels: [{ plugin: { id: "demo-channel-b" } }],
      tools: [],
    } as never);
    ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: activatedConfig,
        activationSourceConfig: activatedConfig,
        onlyPluginIds: ["demo-channel-a"],
        throwOnLoadError: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });
});
