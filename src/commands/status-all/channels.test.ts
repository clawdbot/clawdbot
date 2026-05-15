import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChannelsTable } from "./channels.js";

const mocks = vi.hoisted(() => ({
  resolveInspectedChannelAccount: vi.fn(),
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  readOnlyChannelLoadFailures: [] as Array<{
    channelId: string;
    pluginId: string;
    message: string;
  }>,
  missingOfficialExternalChannels: new Set<string>(),
}));

const discordPlugin = {
  id: "discord",
  meta: { label: "Discord" },
  config: {
    listAccountIds: () => ["default"],
  },
};

vi.mock("../../channels/account-inspection.js", () => ({
  resolveInspectedChannelAccount: mocks.resolveInspectedChannelAccount,
}));

vi.mock("../../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: () => ({
    plugins: mocks.listReadOnlyChannelPluginsForConfig(),
    configuredChannelIds: [],
    missingConfiguredChannelIds: mocks.readOnlyChannelLoadFailures.map(
      (failure) => failure.channelId,
    ),
    loadFailures: mocks.readOnlyChannelLoadFailures,
  }),
}));

vi.mock("../../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHint: ({ channelId }: { channelId: string }) =>
    mocks.missingOfficialExternalChannels.has(channelId)
      ? {
          pluginId: channelId,
          channelId,
          label: "Feishu",
          installSpec: "@openclaw/feishu",
          installCommand: "openclaw plugins install @openclaw/feishu",
          doctorFixCommand: "openclaw doctor --fix",
          repairHint:
            "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
        }
      : null,
}));

describe("buildChannelsTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readOnlyChannelLoadFailures = [];
    mocks.missingOfficialExternalChannels.clear();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([discordPlugin]);
    mocks.resolveInspectedChannelAccount.mockResolvedValue({
      account: {
        tokenStatus: "configured_unavailable",
        tokenSource: "secretref",
      },
      enabled: true,
      configured: true,
    });
  });

  it("keeps a live gateway-backed account OK when local status cannot resolve the token", async () => {
    const table = await buildChannelsTable(
      { channels: { discord: { enabled: true } } },
      {
        liveChannelStatus: {
          channelAccounts: {
            discord: [
              {
                accountId: "default",
                running: true,
                connected: true,
                tokenStatus: "available",
              },
            ],
          },
        },
      },
    );

    const row = table.rows.find((entry) => entry.id === "discord");
    expect(row?.state).toBe("ok");
    expect(row?.detail).not.toContain("unavailable");
    const detailRow = table.details[0]?.rows[0];
    expect(detailRow?.Status).toBe("OK");
    expect(detailRow?.Notes).toContain("credential available in gateway runtime");
  });

  it("warns when a configured token is unavailable and there is no live account proof", async () => {
    const table = await buildChannelsTable({ channels: { discord: { enabled: true } } });

    const row = table.rows.find((entry) => entry.id === "discord");
    expect(row?.state).toBe("warn");
    expect(row?.detail).toContain("unavailable");
  });

  it("shows configured official external channels when the plugin is missing", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.missingOfficialExternalChannels.add("feishu");

    const table = await buildChannelsTable({ channels: { feishu: { appId: "cli_xxx" } } });

    expect(table).toStrictEqual({
      rows: [
        {
          id: "feishu",
          label: "Feishu",
          enabled: true,
          state: "warn",
          detail:
            "plugin not installed - run openclaw plugins install @openclaw/feishu or openclaw doctor --fix",
        },
      ],
      details: [],
    });
    expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
  });

  it("shows plugin load failures for configured channels whose setup registration fails", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.readOnlyChannelLoadFailures = [
      {
        channelId: "telegram",
        pluginId: "telegram",
        message: 'failed to load setup entry: Cannot find module "ansi-escapes"',
      },
    ];

    const table = await buildChannelsTable({ channels: { telegram: { botToken: "123:abc" } } });

    expect(table).toStrictEqual({
      rows: [
        {
          id: "telegram",
          label: "telegram",
          enabled: true,
          state: "warn",
          detail: "plugin load failed: dependency tree corrupted; run openclaw doctor --fix",
        },
      ],
      details: [],
    });
    expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
  });

  it("does not show install repair rows when an external channel owner is policy-blocked", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);

    const table = await buildChannelsTable({ channels: { feishu: { appId: "cli_xxx" } } });

    expect(table.rows).toStrictEqual([]);
    expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
  });
});
