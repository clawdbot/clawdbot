// Channels resolve tests cover channel/account selection and command output for message routing.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
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

const requireRecord = createRequireRecord("record", "expected-label");

function requireFirstMockArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return requireRecord(call[0], `${label} request`);
}

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
    const pluginResolutionRequest = requireFirstMockArg(
      mocks.resolveInstallableChannelPlugin,
      "installable channel resolution",
    );
    expect(pluginResolutionRequest.rawChannel).toBe("whatsapp");
    expect(pluginResolutionRequest.allowInstall).toBe(false);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
    expect(resolveTargets).toHaveBeenCalledTimes(1);
    const resolveRequest = requireFirstMockArg(resolveTargets, "target resolution");
    expect(resolveRequest.cfg).toStrictEqual({ channels: {} });
    expect(resolveRequest.inputs).toStrictEqual(["friends"]);
    expect(resolveRequest.kind).toBe("group");
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
    const resolveRequest = requireFirstMockArg(resolveTargets, "target resolution");
    expect(resolveRequest.cfg).toBe(autoEnabledConfig);
    expect(resolveRequest.inputs).toStrictEqual(["friends"]);
    expect(resolveRequest.kind).toBe("group");
  });
});
