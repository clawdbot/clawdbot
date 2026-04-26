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

  it("persists install-on-demand channel setup before resolving explicit targets", async () => {
    const resolveTargets = vi.fn().mockResolvedValue([
      {
        input: "friends",
        resolved: true,
        id: "120363000000@g.us",
        name: "Friends",
      },
    ]);
    const installedCfg = {
      channels: {},
      plugins: {
        entries: {
          whatsapp: { enabled: true },
        },
      },
    };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: installedCfg,
      channelId: "whatsapp",
      configChanged: true,
      pluginInstalled: true,
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

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        rawChannel: "whatsapp",
        allowInstall: true,
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: installedCfg,
      baseHash: "config-1",
    });
    expect(mocks.refreshPluginRegistryAfterConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        config: installedCfg,
        reason: "source-changed",
      }),
    );
    expect(resolveTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: installedCfg,
        inputs: ["friends"],
        kind: "group",
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("friends -> 120363000000@g.us (Friends)");
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
    expect(resolveTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: autoEnabledConfig,
        inputs: ["friends"],
        kind: "group",
      }),
    );
  });
});
