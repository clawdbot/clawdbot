// Channels resolve tests cover channel/account selection and command output for message routing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelResolverAdapter } from "../channels/plugins/types.adapters.js";
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
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: mocks.getChannelsCommandSecretTargetIds,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: mocks.loadConfig,
    loadConfig: mocks.loadConfig,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../plugins/registry-refresh.js", () => ({
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
      plugin: { id: "telegram" },
      configured: ["telegram"],
      source: "explicit",
    });
  });

  it("uses installed channel plugins for explicit target resolution without installing", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "ops" }] },
      channels: {},
    });
    const resolveTargets = vi.fn<ChannelResolverAdapter["resolveTargets"]>().mockResolvedValue([
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
        agent: "ops",
        channel: "whatsapp",
        entries: ["friends"],
      },
      runtime,
    );

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentId: "ops", rawChannel: "whatsapp", allowInstall: false }),
    );
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
    expect(resolveTargets).toHaveBeenCalledTimes(1);
    expect(resolveTargets.mock.calls[0]?.[0].cfg).toStrictEqual({ channels: {} });
    expect(resolveTargets.mock.calls[0]?.[0].inputs).toStrictEqual(["friends"]);
    expect(resolveTargets).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "group" }));
    expect(runtime.log).toHaveBeenCalledWith("friends -> 120363000000@g.us (Friends)");
  });

  it.each([
    [
      "unknown",
      "nope-agent",
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ],
    ["empty", "", "--agent must not be blank"],
    ["whitespace-only", "   ", "--agent must not be blank"],
  ])("rejects an %s explicit agent before channel resolution", async (_label, agent, message) => {
    mocks.loadConfig.mockReturnValue({
      agents: { list: [{ id: "main" }] },
      channels: {},
    });

    await expect(
      channelsResolveCommand({ agent, channel: "telegram", entries: ["friends"] }, runtime),
    ).rejects.toThrow(message);

    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.resolveMessageChannelSelection).not.toHaveBeenCalled();
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
    const resolveTargets = vi.fn<ChannelResolverAdapter["resolveTargets"]>().mockResolvedValue([
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
      plugin: {
        id: "whatsapp",
        resolver: { resolveTargets },
      },
      configured: ["whatsapp"],
      source: "single-configured",
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
    expect(resolveTargets.mock.calls[0]?.[0].cfg).toBe(autoEnabledConfig);
    expect(resolveTargets.mock.calls[0]?.[0].inputs).toStrictEqual(["friends"]);
    expect(resolveTargets).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "group" }));
  });
});
