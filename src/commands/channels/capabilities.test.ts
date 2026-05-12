process.env.NO_COLOR = "1";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { channelsCapabilitiesCommand } from "./capabilities.js";

const logs: string[] = [];
const errors: string[] = [];
const resolveDefaultAccountId = () => DEFAULT_ACCOUNT_ID;
const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
  resolveInstallableChannelPlugin: vi.fn(),
}));

vi.mock("./shared.js", () => ({
  requireValidConfig: vi.fn(async () => ({ channels: {} })),
  formatChannelAccountLabel: vi.fn(
    ({ channel, accountId }: { channel: string; accountId: string }) => `${channel}:${accountId}`,
  ),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
  getChannelPlugin: vi.fn(),
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

vi.mock("../../cli/plugins-registry-refresh.js", () => ({
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

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

function buildPlugin(params: {
  id: string;
  capabilities?: ChannelPlugin["capabilities"];
  account?: Record<string, unknown>;
  probe?: unknown;
}): ChannelPlugin {
  const capabilities =
    params.capabilities ?? ({ chatTypes: ["direct"] } as ChannelPlugin["capabilities"]);
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      docsPath: "/channels/test",
      blurb: "test",
    },
    capabilities,
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
    resetOutput();
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1" });
    mocks.replaceConfigFile.mockResolvedValue(undefined);
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
    vi.mocked(listChannelPlugins).mockReturnValue([plugin]);
    vi.mocked(getChannelPlugin).mockReturnValue(plugin);
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
    vi.mocked(listChannelPlugins).mockReturnValue([plugin]);
    vi.mocked(getChannelPlugin).mockReturnValue(plugin);
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
    vi.mocked(listChannelPlugins).mockReturnValue([]);
    vi.mocked(getChannelPlugin).mockReturnValue(undefined);

    await channelsCapabilitiesCommand({ channel: "whatsapp" }, runtime);

    const resolveParams = requireFirstMockArg(
      mocks.resolveInstallableChannelPlugin,
      "installable channel resolution",
    );
    expect(resolveParams.rawChannel).toBe("whatsapp");
    expect(resolveParams.allowInstall).toBe(true);

    const replaceParams = requireFirstMockArg(mocks.replaceConfigFile, "config replace");
    expect(requireRecord(replaceParams.nextConfig, "replace next config").plugins).toStrictEqual({
      entries: { whatsapp: { enabled: true } },
    });
    expect(replaceParams.baseHash).toBe("config-1");

    const refreshCalls = mocks.refreshPluginRegistryAfterConfigMutation.mock
      .calls as unknown as Array<[{ reason?: string }]>;
    const refreshParams = refreshCalls[0]?.[0];
    expect(refreshParams?.reason).toBe("source-changed");
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
