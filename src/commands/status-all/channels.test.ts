// Status-all channels tests cover plugin-generic channel rows, account inspection, and load failure reporting.
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
  missingConfiguredChannelIds: [] as string[],
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
    missingConfiguredChannelIds: [
      ...new Set([
        ...mocks.missingConfiguredChannelIds,
        ...mocks.readOnlyChannelLoadFailures.map((failure) => failure.channelId),
      ]),
    ],
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
    mocks.missingConfiguredChannelIds = [];
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

  it("does not warn on SecretRef credentials when credential resolution was skipped", async () => {
    const table = await buildChannelsTable(
      { channels: { discord: { enabled: true } } },
      { credentialResolutionSkipped: true },
    );

    const row = table.rows.find((entry) => entry.id === "discord");
    expect(row?.state).toBe("ok");
    expect(row?.detail).toBe("configured");
    const detailRow = table.details[0]?.rows[0];
    expect(detailRow?.Status).toBe("UNKNOWN");
    expect(detailRow?.Notes).toContain("credential not checked");
  });

  it("formats human phone identity while preserving raw account ids", async () => {
    const phonePlugin = {
      id: "signal",
      meta: { label: "Signal" },
      config: {
        listAccountIds: () => ["work"],
        defaultAccountId: () => "work",
        formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
          allowFrom.map((entry) => String(entry).replace(/^\+/u, "")),
      },
      configSchema: {
        schema: { type: "object" },
        uiHints: { allowFrom: { presentation: "phone-number" } },
      },
      status: {
        buildChannelSummary: async () => ({
          statusState: "linked",
          self: { e164: "+15551234567" },
        }),
      },
    };
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([phonePlugin]);
    mocks.resolveInspectedChannelAccount.mockResolvedValue({
      account: {
        name: "+12133734253",
        allowFrom: ["+442079460018", "bot-token"],
      },
      enabled: true,
      configured: true,
    });

    const table = await buildChannelsTable({ channels: { signal: { enabled: true } } });

    expect(table.rows).toContainEqual(
      expect.objectContaining({
        id: "signal",
        detail: "linked · +1 555 123 4567 (id: +15551234567)",
      }),
    );
    expect(table.details[0]?.rows[0]).toEqual({
      Account: "work (+12133734253)",
      Status: "OK",
      Notes: "allow:+44 20 7946 0018 (id: 442079460018),bot-token",
    });
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

  it("keeps configured channels visible when fast status skips setup fallback plugins", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.missingConfiguredChannelIds = ["telegram"];

    const table = await buildChannelsTable(
      { channels: { telegram: { botToken: "123:abc" } } },
      { includeSetupFallbackPlugins: false },
    );

    expect(table.rows).toStrictEqual([
      {
        id: "telegram",
        label: "telegram",
        enabled: true,
        state: "setup",
        detail: "configured; status unavailable in fast mode",
      },
    ]);
    expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
  });

  it("keeps explicit configured channels visible when the fast path skips their plugin", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);

    const table = await buildChannelsTable(
      { channels: { feishu: { appId: "cli_xxx" } } },
      { includeSetupFallbackPlugins: false },
    );

    expect(table.rows).toStrictEqual([
      {
        id: "feishu",
        label: "feishu",
        enabled: true,
        state: "setup",
        detail: "configured; status unavailable in fast mode",
      },
    ]);
    expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
  });

  it("sanitizes fast-path configured-channel labels", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    const osc = (value: string) =>
      `${String.fromCharCode(0x1b)}]0;${value}${String.fromCharCode(0x07)}`;
    const unsafeChannel = `${osc("owned")}telegram`;

    const table = await buildChannelsTable(
      {
        channels: {
          [unsafeChannel]: { botToken: "123:abc" },
          [osc("only-control")]: { botToken: "123:abc" },
        },
      },
      { includeSetupFallbackPlugins: false },
    );

    expect(table.rows.find((row) => row.id === unsafeChannel)).toMatchObject({
      id: unsafeChannel,
      label: "telegram",
    });
    expect(table.rows.find((row) => row.label === "configured-channel")).toBeDefined();
    expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
  });
});
