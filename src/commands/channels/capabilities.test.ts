// Channels capabilities tests cover capability reporting, account selection, probes, and installable plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { ExpectedCliError } from "../../cli/failure-output.js";
import type { replaceConfigFile } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { channelsCapabilitiesCommand } from "./capabilities.js";

const logs: string[] = [];
const errors: string[] = [];
const resolveDefaultAccountId = () => DEFAULT_ACCOUNT_ID;
const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn<(params: Parameters<typeof replaceConfigFile>[0]) => Promise<void>>(),
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
  resolveInstallableChannelPlugin: vi.fn(),
  listReadOnlyChannelPluginsForConfig: vi.fn(),
}));

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return {
    ...actual,
    requireValidChannelConfig: vi.fn(async () => ({ channels: {} })),
    formatChannelAccountLabel: vi.fn(
      ({ channel, accountId }: { channel: string; accountId: string }) => `${channel}:${accountId}`,
    ),
  };
});

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshPluginRegistryAfterConfigMutation,
}));

vi.mock("../channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin: mocks.resolveInstallableChannelPlugin,
}));

const runtime = {
  log: (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  },
  error: (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  },
  exit: (code: number) => {
    throw new Error(`exit:${code}`);
  },
};

function resetOutput() {
  logs.length = 0;
  errors.length = 0;
}

function buildPlugin(params: {
  id: string;
  capabilities?: ChannelPlugin["capabilities"];
  account?: Record<string, unknown>;
  probe?: unknown;
}): ChannelPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      docsPath: "/channels/test",
      blurb: "test",
    },
    capabilities: params.capabilities ?? { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => params.account ?? { accountId: "default" },
      defaultAccountId: resolveDefaultAccountId,
      isConfigured: () => true,
      isEnabled: () => true,
    },
    status: params.probe
      ? {
          probeAccount: async () => params.probe,
        }
      : undefined,
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
    },
  };
}

describe("channelsCapabilitiesCommand", () => {
  beforeEach(() => {
    vi.stubEnv("NO_COLOR", "1");
    resetOutput();
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1" });
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      configChanged: false,
    });
  });

  it("prints Slack bot + user scopes when user token is configured", async () => {
    const plugin = buildPlugin({
      id: "slack",
      account: {
        accountId: "default",
        botToken: "xoxb-bot",
        userToken: "xoxp-user",
        config: { userToken: "xoxp-user" },
      },
      probe: { ok: true, bot: { name: "openclaw" }, team: { name: "team" } },
    });
    plugin.status = {
      ...plugin.status,
      formatCapabilitiesProbe: () => [{ text: "Bot: @openclaw" }, { text: "Team: team" }],
      buildCapabilitiesDiagnostics: async () => ({
        lines: [
          { text: "Bot scopes (auth.scopes): chat:write" },
          { text: "User scopes (auth.scopes): users:read" },
        ],
        details: {
          botScopes: { ok: true, scopes: ["chat:write"], source: "auth.scopes" },
          userScopes: { ok: true, scopes: ["users:read"], source: "auth.scopes" },
        },
      }),
    };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "slack",
      plugin,
      configChanged: false,
    });

    await channelsCapabilitiesCommand({ channel: "slack" }, runtime);

    expect(logs).toStrictEqual([
      [
        "slack:default",
        "Support: chatTypes=direct",
        "Actions: send, broadcast, poll",
        "Bot: @openclaw",
        "Team: team",
        "Bot scopes (auth.scopes): chat:write",
        "User scopes (auth.scopes): users:read",
      ].join("\n"),
    ]);
  });

  it("prints an empty all-channel report when no channels are configured", async () => {
    await channelsCapabilitiesCommand({ json: true }, runtime);

    expect(errors).toStrictEqual([]);
    expect(logs).toStrictEqual([JSON.stringify({ channels: [] }, null, 2)]);
  });

  it.each([
    {
      name: "account without a channel",
      options: { account: "ghost", json: true },
      message: "--account requires a specific --channel. Run openclaw channels list to choose one.",
      discoversChannels: false,
    },
    {
      name: "account with all channels",
      options: { channel: "all", account: "ghost" },
      message: "--account requires a specific --channel. Run openclaw channels list to choose one.",
      discoversChannels: false,
    },
    {
      name: "target without a channel",
      options: { target: "channel:1", json: true },
      message: "--target requires a specific --channel. Run openclaw channels list to choose one.",
      discoversChannels: false,
    },
    {
      name: "target with all channels",
      options: { channel: "all", target: "channel:1" },
      message: "--target requires a specific --channel. Run openclaw channels list to choose one.",
      discoversChannels: false,
    },
    {
      name: "account before target when both lack a channel",
      options: { account: "ghost", target: "channel:1" },
      message: "--account requires a specific --channel. Run openclaw channels list to choose one.",
      discoversChannels: false,
    },
    {
      name: "unknown channel after installable plugin lookup",
      options: { channel: "definitely-not-a-channel", json: true },
      message:
        'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
      discoversChannels: true,
    },
  ])("rejects $name before resolving or probing an account", async (testCase) => {
    const plugin = buildPlugin({ id: "slack" });
    const listAccountIds = vi.fn(() => ["default"]);
    const resolveAccount = vi.fn(() => ({ accountId: "default" }));
    const probeAccount = vi.fn(async () => ({ ok: true }));
    plugin.config.listAccountIds = listAccountIds;
    plugin.config.resolveAccount = resolveAccount;
    plugin.status = { probeAccount };
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);

    const failure = channelsCapabilitiesCommand(testCase.options, runtime);

    await expect(failure).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(failure).rejects.toMatchObject({
      message: testCase.message,
      humanOutput: testCase.message,
      machineOutput: testCase.message,
    });
    expect(logs).toStrictEqual([]);
    expect(errors).toStrictEqual([]);
    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledTimes(
      testCase.discoversChannels ? 1 : 0,
    );
    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(
      testCase.discoversChannels ? 1 : 0,
    );
    expect(listAccountIds).not.toHaveBeenCalled();
    expect(resolveAccount).not.toHaveBeenCalled();
    expect(probeAccount).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
  });

  it("rejects malformed timeouts before capability probes", async () => {
    const probeAccount = vi.fn(async () => ({ ok: true }));
    const plugin = buildPlugin({
      id: "slack",
      account: {
        accountId: "default",
        botToken: "xoxb-bot",
      },
      probe: { ok: true },
    });
    plugin.status = { ...plugin.status, probeAccount };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "slack",
      plugin,
      configChanged: false,
    });

    await expect(
      channelsCapabilitiesCommand({ channel: "slack", timeout: "10s" }, runtime),
    ).rejects.toThrow('Received: "10s"');
    expect(probeAccount).not.toHaveBeenCalled();
  });

  it("caps oversized timeouts before invoking capability probes", async () => {
    const probeAccount = vi.fn(async () => ({ ok: true }));
    const buildCapabilitiesDiagnostics = vi.fn(async () => ({
      lines: [{ text: "Diagnostics: ok" }],
    }));
    const plugin = buildPlugin({
      id: "slack",
      account: {
        accountId: "default",
        botToken: "xoxb-bot",
      },
    });
    plugin.status = { probeAccount, buildCapabilitiesDiagnostics };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "slack",
      plugin,
      configChanged: false,
    });

    await channelsCapabilitiesCommand({ channel: "slack", timeout: "999999" }, runtime);

    expect(probeAccount).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
    expect(buildCapabilitiesDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("serializes a failed probe when a capability probe exceeds its timeout", async () => {
    const probeAccount = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally never settles; command timeout should win.
        }),
    );
    const plugin = buildPlugin({
      id: "slack",
      account: {
        accountId: "default",
        botToken: "xoxb-bot",
      },
    });
    plugin.status = { probeAccount };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "slack",
      plugin,
      configChanged: false,
    });

    await channelsCapabilitiesCommand({ channel: "slack", json: true, timeout: "1" }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      channels?: Array<{ probe?: unknown }>;
    };
    expect(payload.channels?.[0]?.probe).toStrictEqual({
      ok: false,
      timedOut: true,
      error: "probe timed out after 1ms",
    });
  });

  it("prints timed-out probes when a channel formatter has no custom output", async () => {
    const probeAccount = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally never settles; command timeout should win.
        }),
    );
    const plugin = buildPlugin({
      id: "telegram",
      account: {
        accountId: "default",
        botToken: "bot-token",
      },
    });
    plugin.status = { probeAccount, formatCapabilitiesProbe: () => [] };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "telegram",
      plugin,
      configChanged: false,
    });

    await channelsCapabilitiesCommand({ channel: "telegram", timeout: "1" }, runtime);

    expect(logs[0]?.split("\n")).toContain("Probe: failed (probe timed out after 1ms)");
  });

  it("serializes diagnostics when capability diagnostics exceed their timeout", async () => {
    const buildCapabilitiesDiagnostics = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally never settles; command timeout should win.
        }),
    );
    const plugin = buildPlugin({
      id: "slack",
      account: {
        accountId: "default",
        botToken: "xoxb-bot",
      },
      probe: { ok: true },
    });
    plugin.status = { ...plugin.status, buildCapabilitiesDiagnostics };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "slack",
      plugin,
      configChanged: false,
    });

    await channelsCapabilitiesCommand({ channel: "slack", json: true, timeout: "1" }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      channels?: Array<{ diagnostics?: unknown }>;
    };
    expect(payload.channels?.[0]?.diagnostics).toStrictEqual({
      lines: [
        {
          text: "Diagnostics: timed out after 1ms",
          tone: "error",
        },
      ],
      details: { timedOut: true },
    });
  });

  it("prints Teams Graph permission hints when present", async () => {
    const plugin = buildPlugin({
      id: "msteams",
      probe: {
        ok: true,
        appId: "app-id",
        graph: {
          ok: true,
          roles: ["ChannelMessage.Read.All", "Files.Read.All"],
        },
      },
    });
    plugin.status = {
      ...plugin.status,
      formatCapabilitiesProbe: () => [
        { text: "App: app-id" },
        {
          text: "Graph roles: ChannelMessage.Read.All (channel history), Files.Read.All (files (OneDrive))",
        },
      ],
    };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "msteams",
      plugin,
      configChanged: false,
    });

    await channelsCapabilitiesCommand({ channel: "msteams" }, runtime);

    expect(logs).toStrictEqual([
      [
        "msteams:default",
        "Support: chatTypes=direct",
        "Actions: send, broadcast, poll",
        "App: app-id",
        "Graph roles: ChannelMessage.Read.All (channel history), Files.Read.All (files (OneDrive))",
      ].join("\n"),
    ]);
  });

  it("installs an explicit optional channel before rendering capabilities", async () => {
    const plugin = buildPlugin({
      id: "whatsapp",
      probe: { ok: true },
    });
    plugin.status = {
      ...plugin.status,
      formatCapabilitiesProbe: () => [{ text: "Probe: linked" }],
    };
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: {
        channels: {},
        plugins: { entries: { whatsapp: { enabled: true } } },
      },
      channelId: "whatsapp",
      plugin,
      configChanged: true,
      pluginInstalled: true,
    });

    await channelsCapabilitiesCommand({ channel: "whatsapp" }, runtime);

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ rawChannel: "whatsapp", allowInstall: true }),
    );

    expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ baseHash: "config-1" }),
    );
    expect(mocks.replaceConfigFile.mock.calls[0]?.[0].nextConfig.plugins).toStrictEqual({
      entries: { whatsapp: { enabled: true } },
    });

    expect(mocks.refreshPluginRegistryAfterConfigMutation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ reason: "source-changed" }),
    );
    expect(logs).toStrictEqual([
      [
        "whatsapp:default",
        "Support: chatTypes=direct",
        "Actions: send, broadcast, poll",
        "Probe: linked",
      ].join("\n"),
    ]);
  });
});
