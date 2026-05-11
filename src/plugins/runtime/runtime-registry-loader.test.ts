import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../registry.js";

const mocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn<typeof import("../loader.js").loadOpenClawPlugins>(),
  resolveCompatibleRuntimePluginRegistry:
    vi.fn<typeof import("../loader.js").resolveCompatibleRuntimePluginRegistry>(),
  resolveRuntimePluginRegistry: vi.fn<typeof import("../loader.js").resolveRuntimePluginRegistry>(),
  getActivePluginRegistry: vi.fn<typeof import("../runtime.js").getActivePluginRegistry>(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  resolveDiscoverableScopedChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveDiscoverableScopedChannelPluginIds>(),
  resolveChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveChannelPluginIds>(),
  resolveEffectivePluginIds:
    vi.fn<typeof import("../effective-plugin-ids.js").resolveEffectivePluginIds>(),
  applyPluginAutoEnable:
    vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>(),
  resolveAgentWorkspaceDir: vi.fn<
    typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir
  >(() => "/resolved-workspace"),
  resolveDefaultAgentId: vi.fn<typeof import("../../agents/agent-scope.js").resolveDefaultAgentId>(
    () => "default",
  ),
}));

let ensurePluginRegistryLoaded: typeof import("./runtime-registry-loader.js").ensurePluginRegistryLoaded;
let resetPluginRegistryLoadedForTests: typeof import("./runtime-registry-loader.js").__testing.resetPluginRegistryLoadedForTests;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function loadOptions(index = 0) {
  return requireRecord(mocks.loadOpenClawPlugins.mock.calls[index]?.[0], `load options ${index}`);
}

function configuredChannelOptions(index = 0) {
  return requireRecord(
    mocks.resolveConfiguredChannelPluginIds.mock.calls[index]?.[0],
    `configured channel options ${index}`,
  );
}

function scopedChannelOptions(index = 0) {
  return requireRecord(
    mocks.resolveDiscoverableScopedChannelPluginIds.mock.calls[index]?.[0],
    `scoped channel options ${index}`,
  );
}

function pluginsConfig(config: Record<string, unknown>) {
  return requireRecord(config.plugins, "plugins config");
}

function pluginEntries(config: Record<string, unknown>) {
  return requireRecord(pluginsConfig(config).entries, "plugin entries");
}

vi.mock("../loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
    mocks.loadOpenClawPlugins(...args),
  resolveCompatibleRuntimePluginRegistry: (
    ...args: Parameters<typeof mocks.resolveCompatibleRuntimePluginRegistry>
  ) => mocks.resolveCompatibleRuntimePluginRegistry(...args),
  resolveRuntimePluginRegistry: (...args: Parameters<typeof mocks.resolveRuntimePluginRegistry>) =>
    mocks.resolveRuntimePluginRegistry(...args),
}));

vi.mock("../runtime.js", () => ({
  getActivePluginChannelRegistry: () => null,
  getActivePluginHttpRouteRegistry: () => null,
  getActivePluginRegistry: (...args: Parameters<typeof mocks.getActivePluginRegistry>) =>
    mocks.getActivePluginRegistry(...args),
  getActivePluginRegistryWorkspaceDir: () => undefined,
}));

vi.mock("../channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: (
    ...args: Parameters<typeof mocks.resolveConfiguredChannelPluginIds>
  ) => mocks.resolveConfiguredChannelPluginIds(...args),
  resolveDiscoverableScopedChannelPluginIds: (
    ...args: Parameters<typeof mocks.resolveDiscoverableScopedChannelPluginIds>
  ) => mocks.resolveDiscoverableScopedChannelPluginIds(...args),
  resolveChannelPluginIds: (...args: Parameters<typeof mocks.resolveChannelPluginIds>) =>
    mocks.resolveChannelPluginIds(...args),
}));

vi.mock("../effective-plugin-ids.js", () => ({
  resolveEffectivePluginIds: (...args: Parameters<typeof mocks.resolveEffectivePluginIds>) =>
    mocks.resolveEffectivePluginIds(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: Parameters<typeof mocks.applyPluginAutoEnable>) =>
    mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: Parameters<typeof mocks.resolveAgentWorkspaceDir>) =>
    mocks.resolveAgentWorkspaceDir(...args),
  resolveDefaultAgentId: (...args: Parameters<typeof mocks.resolveDefaultAgentId>) =>
    mocks.resolveDefaultAgentId(...args),
}));

describe("ensurePluginRegistryLoaded", () => {
  beforeAll(async () => {
    const mod = await import("./runtime-registry-loader.js");
    ensurePluginRegistryLoaded = mod.ensurePluginRegistryLoaded;
    resetPluginRegistryLoadedForTests = () => mod.__testing.resetPluginRegistryLoadedForTests();
  });

  beforeEach(() => {
    mocks.loadOpenClawPlugins.mockReset();
    mocks.resolveCompatibleRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.getActivePluginRegistry.mockReset();
    mocks.resolveConfiguredChannelPluginIds.mockReset();
    mocks.resolveDiscoverableScopedChannelPluginIds.mockReset();
    mocks.resolveChannelPluginIds.mockReset();
    mocks.resolveEffectivePluginIds.mockReset();
    mocks.applyPluginAutoEnable.mockReset();
    mocks.resolveAgentWorkspaceDir.mockClear();
    mocks.resolveDefaultAgentId.mockClear();
    resetPluginRegistryLoadedForTests();

    mocks.getActivePluginRegistry.mockReturnValue(null);
    mocks.resolveCompatibleRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.loadOpenClawPlugins.mockReturnValue(createEmptyPluginRegistry());
    mocks.resolveRuntimePluginRegistry.mockImplementation(
      (...args: Parameters<typeof mocks.loadOpenClawPlugins>) => mocks.loadOpenClawPlugins(...args),
    );
    mocks.applyPluginAutoEnable.mockImplementation((params) => ({
      config:
        params.config && typeof params.config === "object"
          ? {
              ...params.config,
              plugins: {
                entries: {
                  demo: { enabled: true },
                },
              },
            }
          : {},
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    }));
    mocks.resolveDiscoverableScopedChannelPluginIds.mockReturnValue([]);
    mocks.resolveEffectivePluginIds.mockReturnValue(["demo"]);
  });

  it("uses the shared runtime load context for configured-channel loads", () => {
    const rawConfig = { channels: { demo: { enabled: true } } };
    const resolvedConfig = {
      ...rawConfig,
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-channel"]);
    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: rawConfig as never,
      env,
      activationSourceConfig: { plugins: { allow: ["demo-channel"] } } as never,
    });

    const channelOptions = configuredChannelOptions();
    expect(channelOptions.config).toEqual(resolvedConfig);
    expect(channelOptions.activationSourceConfig).toEqual({ plugins: { allow: ["demo-channel"] } });
    expect(channelOptions.env).toBe(env);
    expect(channelOptions.workspaceDir).toBe("/resolved-workspace");
    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env,
    });
    const load = loadOptions();
    const loadConfig = requireRecord(load.config, "load config");
    expect(loadConfig.channels).toEqual(rawConfig.channels);
    expect(pluginEntries(loadConfig)).toEqual({
      demo: { enabled: true },
      "demo-channel": { enabled: true },
    });
    expect(pluginsConfig(loadConfig).allow).toEqual(["demo-channel"]);
    expect(load.activationSourceConfig).toEqual({
      plugins: {
        allow: ["demo-channel"],
        entries: {
          "demo-channel": { enabled: true },
        },
      },
    });
    expect(load.autoEnabledReasons).toEqual({
      demo: ["demo configured"],
    });
    expect(load.workspaceDir).toBe("/resolved-workspace");
    expect(load.onlyPluginIds).toEqual(["demo-channel"]);
    expect(load.throwOnLoadError).toBe(true);
  });

  it("temporarily activates configured-channel owners before loading them", () => {
    const rawConfig = { channels: { demo: { enabled: true } } };

    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["activation-only-channel"]);

    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: rawConfig as never,
    });

    const load = loadOptions();
    const loadConfig = requireRecord(load.config, "load config");
    expect(pluginEntries(loadConfig)["activation-only-channel"]).toEqual({ enabled: true });
    expect(pluginsConfig(loadConfig).allow).toEqual(["activation-only-channel"]);
    const activation = requireRecord(load.activationSourceConfig, "activation config");
    expect(pluginEntries(activation)["activation-only-channel"]).toEqual({ enabled: true });
    expect(pluginsConfig(activation).allow).toEqual(["activation-only-channel"]);
    expect(load.onlyPluginIds).toEqual(["activation-only-channel"]);
  });

  it("does not cache scoped loads by explicit plugin ids", () => {
    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: {} as never,
      onlyPluginIds: ["demo-a"],
    });
    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: {} as never,
      onlyPluginIds: ["demo-b"],
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
    expect(loadOptions(0).onlyPluginIds).toEqual(["demo-a"]);
    expect(loadOptions(1).onlyPluginIds).toEqual(["demo-b"]);
  });

  it("maps explicit channel scopes to owner plugin ids before loading", () => {
    const rawConfig = { channels: { "external-chat": { token: "configured" } } };
    mocks.resolveDiscoverableScopedChannelPluginIds.mockReturnValue(["external-chat-plugin"]);

    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: rawConfig as never,
      onlyChannelIds: ["external-chat"],
    });

    const channelOptions = scopedChannelOptions();
    const channelConfig = requireRecord(channelOptions.config, "scoped channel config");
    expect(channelConfig.channels).toEqual(rawConfig.channels);
    expect(pluginEntries(channelConfig).demo).toEqual({ enabled: true });
    expect(channelOptions.activationSourceConfig).toBe(rawConfig);
    expect(channelOptions.channelIds).toEqual(["external-chat"]);
    expect(channelOptions.workspaceDir).toBe("/resolved-workspace");
    const load = loadOptions();
    const loadConfig = requireRecord(load.config, "load config");
    expect(pluginsConfig(loadConfig).allow).toEqual(["external-chat-plugin"]);
    expect(pluginEntries(loadConfig)["external-chat-plugin"]).toEqual({ enabled: true });
    const activation = requireRecord(load.activationSourceConfig, "activation config");
    expect(pluginsConfig(activation).allow).toEqual(["external-chat-plugin"]);
    expect(pluginEntries(activation)["external-chat-plugin"]).toEqual({ enabled: true });
    expect(load.onlyPluginIds).toEqual(["external-chat-plugin"]);
  });

  it("forwards explicit empty scopes without widening to channel resolution", () => {
    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: {} as never,
      onlyPluginIds: [],
    });

    expect(mocks.resolveConfiguredChannelPluginIds).not.toHaveBeenCalled();
    expect(mocks.resolveChannelPluginIds).not.toHaveBeenCalled();
    expect(loadOptions().onlyPluginIds).toEqual([]);
  });

  it("preserves empty configured-channel scopes when no owners are activatable", () => {
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue([]);

    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: { channels: { demo: { enabled: true } } } as never,
    });

    expect(loadOptions().onlyPluginIds).toEqual([]);
  });

  it("does not forward empty channel scopes for broad channel loads", () => {
    mocks.resolveChannelPluginIds.mockReturnValue([]);

    ensurePluginRegistryLoaded({
      scope: "channels",
      config: {} as never,
    });

    expect(loadOptions().onlyPluginIds).toBeUndefined();
  });

  it("derives all-scope runtime loads from effective plugin ids", () => {
    const config = {
      plugins: { enabled: true },
      channels: { "demo-channel-a": { enabled: true } },
    };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    mocks.resolveEffectivePluginIds.mockReturnValue(["demo-effective", "demo-hook"]);

    ensurePluginRegistryLoaded({ scope: "all", config: config as never, env });

    expect(mocks.resolveEffectivePluginIds).toHaveBeenCalledWith({
      config,
      env,
      workspaceDir: "/resolved-workspace",
    });
    const load = loadOptions();
    const loadConfig = requireRecord(load.config, "load config");
    expect(loadConfig.channels).toEqual(config.channels);
    expect(pluginEntries(loadConfig).demo).toEqual({ enabled: true });
    expect(load.onlyPluginIds).toEqual(["demo-effective", "demo-hook"]);
    expect(load.throwOnLoadError).toBe(true);
    expect(load.workspaceDir).toBe("/resolved-workspace");
  });

  it("preserves empty all-scope loads instead of widening to all discovered plugins", () => {
    mocks.resolveEffectivePluginIds.mockReturnValue([]);

    ensurePluginRegistryLoaded({
      scope: "all",
      config: { plugins: { enabled: true } } as never,
    });

    expect(loadOptions().onlyPluginIds).toEqual([]);
  });

  it("reuses a compatible active registry instead of forcing a broad reload", () => {
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.plugins.push({
      id: "demo",
      source: "/tmp/demo.js",
      origin: "workspace",
      enabled: true,
      status: "loaded",
    } as never);
    mocks.getActivePluginRegistry.mockReturnValue(activeRegistry);
    mocks.resolveCompatibleRuntimePluginRegistry.mockReturnValue(activeRegistry);

    ensurePluginRegistryLoaded({
      scope: "all",
      config: { plugins: { allow: ["demo"] } } as never,
    });

    expect(mocks.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
