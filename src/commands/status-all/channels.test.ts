import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChannelsTable } from "./channels.js";

const mocks = vi.hoisted(() => ({
  resolveInspectedChannelAccount: vi.fn(),
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
  listReadOnlyChannelPluginsForConfig: () => [discordPlugin],
}));

describe("buildChannelsTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(table.rows).toContainEqual(
      expect.objectContaining({
        id: "discord",
        state: "ok",
        detail: expect.not.stringContaining("unavailable"),
      }),
    );
    expect(table.details[0]?.rows[0]).toEqual(
      expect.objectContaining({
        Status: "OK",
        Notes: expect.stringContaining("credential available in gateway runtime"),
      }),
    );
  });

  it("warns when a configured token is unavailable and there is no live account proof", async () => {
    const table = await buildChannelsTable({ channels: { discord: { enabled: true } } });

    expect(table.rows).toContainEqual(
      expect.objectContaining({
        id: "discord",
        state: "warn",
        detail: expect.stringContaining("unavailable"),
      }),
    );
  });
});
