import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../registry.js";

const mocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn<typeof import("../loader.js").loadOpenClawPlugins>(),
  resolveRuntimePluginRegistry: vi.fn<typeof import("../loader.js").resolveRuntimePluginRegistry>(),
  getActivePluginRegistry: vi.fn<typeof import("../runtime.js").getActivePluginRegistry>(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  resolveDiscoverableScopedChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveDiscoverableScopedChannelPluginIds>(),
  resolveChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveChannelPluginIds>(),
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

vi.mock("../loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
    mocks.loadOpenClawPlugins(...args),
  resolveRuntimePluginRegistry: (...args: Parameters<typeof mocks.resolveRuntimePluginRegistry>) =>
    mocks.resolveRuntimePluginRegistry(...args),
}));

vi.mock("../runtime.js", () => ({
  getActivePluginChannelRegistry: () => null,
  getActivePluginRegistry: (...args: Parameters<typeof mocks.getActivePluginRegistry>) =>
    mocks.getActivePluginRegistry(...args),
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
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.getActivePluginRegistry.mockReset();
    mocks.resolveConfiguredChannelPluginIds.mockReset();
    mocks.resolveDiscoverableScopedChannelPluginIds.mockReset();
    mocks.resolveChannelPluginIds.mockReset();
    mocks.applyPluginAutoEnable.mockReset();
    mocks.resolveAgentWorkspaceDir.mockClear();
    mocks.resolveDefaultAgentId.mockClear();
    resetPluginRegistryLoadedForTests();

    mocks.getActivePluginRegistry.mockReturnValue(createEmptyPluginRegistry());
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

    expect(mocks.resolveConfiguredChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        activationSourceConfig: { plugins: { allow: ["demo-channel"] } },
        env,
        workspaceDir: "/resolved-workspace",
      }),
    );
    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env,
    });
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          ...resolvedConfig,
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              demo: { enabled: true },
              "demo-channel": { enabled: true },
            }),
            allow: ["demo-channel"],
          }),
        }),
        activationSourceConfig: {
          plugins: {
            allow: ["demo-channel"],
            entries: {
              "demo-channel": { enabled: true },
            },
          },
        },
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
        workspaceDir: "/resolved-workspace",
        onlyPluginIds: ["demo-channel"],
        throwOnLoadError: true,
      }),
    );
  });

  it("temporarily activates configured-channel owners before loading them", () => {
    const rawConfig = { channels: { demo: { enabled: true } } };

    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["activation-only-channel"]);

    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: rawConfig as never,
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              "activation-only-channel": { enabled: true },
            }),
            allow: ["activation-only-channel"],
          }),
        }),
        activationSourceConfig: expect.objectContaining({
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              "activation-only-channel": { enabled: true },
            }),
            allow: ["activation-only-channel"],
          }),
        }),
        onlyPluginIds: ["activation-only-channel"],
      }),
    );
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
    expect(mocks.loadOpenClawPlugins).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ onlyPluginIds: ["demo-a"] }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ onlyPluginIds: ["demo-b"] }),
    );
  });

  it("maps explicit channel scopes to owner plugin ids before loading", () => {
    const rawConfig = { channels: { "external-chat": { token: "configured" } } };
    mocks.resolveDiscoverableScopedChannelPluginIds.mockReturnValue(["external-chat-plugin"]);

    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: rawConfig as never,
      onlyChannelIds: ["external-chat"],
    });

    expect(mocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          ...rawConfig,
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              demo: { enabled: true },
            }),
          }),
        }),
        activationSourceConfig: rawConfig,
        channelIds: ["external-chat"],
        workspaceDir: "/resolved-workspace",
      }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["external-chat-plugin"],
            entries: expect.objectContaining({
              "external-chat-plugin": { enabled: true },
            }),
          }),
        }),
        activationSourceConfig: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["external-chat-plugin"],
            entries: expect.objectContaining({
              "external-chat-plugin": { enabled: true },
            }),
          }),
        }),
        onlyPluginIds: ["external-chat-plugin"],
      }),
    );
  });

  it("forwards explicit empty scopes without widening to channel resolution", () => {
    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: {} as never,
      onlyPluginIds: [],
    });

    expect(mocks.resolveConfiguredChannelPluginIds).not.toHaveBeenCalled();
    expect(mocks.resolveChannelPluginIds).not.toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
  });

  it("preserves empty configured-channel scopes when no owners are activatable", () => {
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue([]);

    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: { channels: { demo: { enabled: true } } } as never,
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
  });

  it("does not forward empty channel scopes for broad channel loads", () => {
    mocks.resolveChannelPluginIds.mockReturnValue([]);

    ensurePluginRegistryLoaded({
      scope: "channels",
      config: {} as never,
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: [],
      }),
    );
    expect(
      (mocks.loadOpenClawPlugins.mock.calls[0]?.[0] as { onlyPluginIds?: string[] }).onlyPluginIds,
    ).toBeUndefined();
  });

  it("reuses a compatible active registry instead of forcing a broad reload", () => {
    const activeRegistry = createEmptyPluginRegistry();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(activeRegistry);

    ensurePluginRegistryLoaded({
      scope: "all",
      config: { plugins: { allow: ["demo"] } } as never,
    });

    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        throwOnLoadError: true,
      }),
    );
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: expect.any(Array),
      }),
    );
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
