import { describe, expect, it, vi } from "vitest";

const listChannelPluginsMock = vi.hoisted(() => vi.fn());

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => listChannelPluginsMock(),
}));

import { collectChannelStatusIssues } from "./channels-status-issues.js";

describe("collectChannelStatusIssues", () => {
  it("returns no issues when payload accounts are missing or not arrays", () => {
    const collectTelegramIssues = vi.fn(() => [{ code: "telegram" }]);
    listChannelPluginsMock.mockReturnValue([
      { id: "telegram", status: { collectStatusIssues: collectTelegramIssues } },
    ]);

    expect(collectChannelStatusIssues({})).toStrictEqual([]);
    expect(collectChannelStatusIssues({ channelAccounts: { telegram: { bad: true } } })).toEqual(
      [],
    );
    expect(collectTelegramIssues).not.toHaveBeenCalled();
  });

  it("skips plugins without collectors and concatenates collector output in plugin order", () => {
    const collectTelegramIssues = vi.fn(() => [{ code: "telegram.down" }]);
    const collectSlackIssues = vi.fn(() => [{ code: "slack.warn" }, { code: "slack.auth" }]);
    const telegramAccounts = [{ id: "tg-1" }];
    const slackAccounts = [{ id: "sl-1" }];
    listChannelPluginsMock.mockReturnValueOnce([
      { id: "discord" },
      { id: "telegram", status: { collectStatusIssues: collectTelegramIssues } },
      { id: "slack", status: { collectStatusIssues: collectSlackIssues } },
    ]);

    expect(
      collectChannelStatusIssues({
        channelAccounts: {
          discord: [{ id: "dc-1" }],
          telegram: telegramAccounts,
          slack: slackAccounts,
        },
      }),
    ).toEqual([{ code: "telegram.down" }, { code: "slack.warn" }, { code: "slack.auth" }]);

    expect(collectTelegramIssues).toHaveBeenCalledWith(telegramAccounts);
    expect(collectSlackIssues).toHaveBeenCalledWith(slackAccounts);
  });
});
