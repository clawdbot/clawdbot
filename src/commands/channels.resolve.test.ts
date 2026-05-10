import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelsResolveCommand } from "./channels/resolve.js";

const mocks = vi.hoisted(() => ({
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getChannelsCommandSecretTargetIds: vi.fn(() => []),
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  replaceConfigFile: vi.fn(),
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
  resolveMessageChannelSelection: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
  getChannelPlugin: vi.fn(),
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: mocks.getChannelsCommandSecretTargetIds,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../cli/plugins-registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshPluginRegistryAfterConfigMutation,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("./channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin: mocks.resolveInstallableChannelPlugin,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
}));

describe("channelsResolveCommand", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1" });
    mocks.refreshPluginRegistryAfterConfigMutation.mockResolvedValue(undefined);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { channels: {} },
      diagnostics: [],
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "telegram",
      configured: ["telegram"],
      source: "explicit",
    });
  });

  it("uses installed channel plugins for explicit target resolution without installing", async () => {
    const resolveTargets = vi.fn().mockResolvedValue([
      {
        input: "friends",
        resolved: true,
        id: "120363000000@g.us",
        name: "Friends",
      },
    ]);
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "whatsapp",
      configChanged: false,
      pluginInstalled: false,
      plugin: {
        id: "whatsapp",
        resolver: { resolveTargets },
      },
    });

    await channelsResolveCommand(
      {
        channel: "whatsapp",
        entries: ["friends"],
      },
      runtime,
    );

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(1);
    const pluginResolutionRequest = mocks.resolveInstallableChannelPlugin.mock.calls[0]?.[0];
    expect(pluginResolutionRequest?.rawChannel).toBe("whatsapp");
    expect(pluginResolutionRequest?.allowInstall).toBe(false);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
    expect(resolveTargets).toHaveBeenCalledTimes(1);
    const resolveRequest = resolveTargets.mock.calls[0]?.[0];
    expect(resolveRequest?.cfg).toStrictEqual({ channels: {} });
    expect(resolveRequest?.inputs).toStrictEqual(["friends"]);
    expect(resolveRequest?.kind).toBe("group");
    expect(runtime.log).toHaveBeenCalledWith("friends -> 120363000000@g.us (Friends)");
  });

  it("tells users to add an explicit catalog channel before resolving", async () => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "external-chat",
      catalogEntry: { id: "external-chat" },
      configChanged: false,
      pluginInstalled: false,
    });

    await expect(
      channelsResolveCommand(
        {
          channel: "external-chat",
          entries: ["friends"],
        },
        runtime,
      ),
    ).rejects.toThrow(
      /Channel plugin "external-chat" is not installed\. Run .*channels add --channel external-chat.* first\./,
    );
  });

  it("uses the auto-enabled config snapshot for omitted channel resolution", async () => {
    const autoEnabledConfig = {
      channels: { whatsapp: {} },
      plugins: { allow: ["whatsapp"] },
    };
    const resolveTargets = vi.fn().mockResolvedValue([
      {
        input: "friends",
        resolved: true,
        id: "120363000000@g.us",
        name: "Friends",
      },
    ]);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { channels: {} },
      diagnostics: [],
    });
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "whatsapp",
      configured: ["whatsapp"],
      source: "single-configured",
    });
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      resolver: { resolveTargets },
    });

    await channelsResolveCommand(
      {
        entries: ["friends"],
      },
      runtime,
    );

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: { channels: {} },
      env: process.env,
    });
    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({
      cfg: autoEnabledConfig,
      channel: null,
    });
    expect(resolveTargets).toHaveBeenCalledTimes(1);
    const resolveRequest = resolveTargets.mock.calls[0]?.[0];
    expect(resolveRequest?.cfg).toBe(autoEnabledConfig);
    expect(resolveRequest?.inputs).toStrictEqual(["friends"]);
    expect(resolveRequest?.kind).toBe("group");
  });
});
