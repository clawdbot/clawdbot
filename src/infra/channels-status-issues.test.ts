// Covers channel plugin status issue collection.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin, ChannelStatusIssue } from "../channels/plugins/types.public.js";
import { DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS } from "../gateway/channel-health-policy.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

import { collectChannelStatusIssues } from "./channels-status-issues.js";

function createPlugin(
  id: string,
  collectStatusIssues?: NonNullable<ChannelPlugin["status"]>["collectStatusIssues"],
) {
  return {
    id,
    status: collectStatusIssues ? { collectStatusIssues } : undefined,
  } as ChannelPlugin;
}

describe("collectChannelStatusIssues", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns no issues when payload accounts are missing or not arrays", () => {
    const collectTelegramIssues = vi.fn((): ChannelStatusIssue[] => [
      {
        channel: "telegram",
        accountId: "default",
        kind: "runtime",
        message: "telegram down",
      },
    ]);
    mocks.listChannelPlugins.mockReturnValue([createPlugin("telegram", collectTelegramIssues)]);

    expect(collectChannelStatusIssues({})).toStrictEqual([]);
    expect(collectChannelStatusIssues({ channelAccounts: { telegram: { bad: true } } })).toEqual(
      [],
    );
    expect(collectTelegramIssues).not.toHaveBeenCalled();
  });

  it("skips plugins without collectors and concatenates collector output in plugin order", () => {
    const collectTelegramIssues = vi.fn((): ChannelStatusIssue[] => [
      {
        channel: "telegram",
        accountId: "default",
        kind: "runtime",
        message: "telegram down",
      },
    ]);
    const collectSlackIssues = vi.fn((): ChannelStatusIssue[] => [
      {
        channel: "slack",
        accountId: "default",
        kind: "permissions",
        message: "slack warning",
      },
      {
        channel: "slack",
        accountId: "default",
        kind: "auth",
        message: "slack auth failed",
      },
    ]);
    const telegramAccounts = [{ accountId: "tg-1" }];
    const slackAccounts = [{ accountId: "sl-1" }];
    mocks.listChannelPlugins.mockReturnValueOnce([
      createPlugin("discord"),
      createPlugin("telegram", collectTelegramIssues),
      createPlugin("slack", collectSlackIssues),
    ]);

    expect(
      collectChannelStatusIssues({
        channelAccounts: {
          discord: [{ accountId: "dc-1" }],
          telegram: telegramAccounts,
          slack: slackAccounts,
        },
      }),
    ).toEqual([
      {
        channel: "telegram",
        accountId: "default",
        kind: "runtime",
        message: "telegram down",
      },
      {
        channel: "slack",
        accountId: "default",
        kind: "permissions",
        message: "slack warning",
      },
      {
        channel: "slack",
        accountId: "default",
        kind: "auth",
        message: "slack auth failed",
      },
    ]);

    expect(collectTelegramIssues).toHaveBeenCalledWith(telegramAccounts);
    expect(collectSlackIssues).toHaveBeenCalledWith(slackAccounts);
  });

  it("adds runtime warnings for stale connected channel transports", () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.listChannelPlugins.mockReturnValue([createPlugin("feishu")]);

    const issues = collectChannelStatusIssues({
      channelAccounts: {
        feishu: [
          {
            accountId: "work",
            enabled: true,
            configured: true,
            running: true,
            connected: true,
            lastStartAt: now - DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS - 120_000,
            lastTransportActivityAt: now - DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS - 60_000,
          },
        ],
      },
    });

    expect(issues).toContainEqual({
      channel: "feishu",
      accountId: "work",
      kind: "runtime",
      message:
        "Channel reports connected, but transport activity is stale; inbound delivery may be broken.",
      fix: "restart the channel or gateway",
    });
  });

  it("keeps plugin-specific status issues while adding generic runtime issues", () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.listChannelPlugins.mockReturnValue([
      createPlugin("signal", () => [
        {
          channel: "signal",
          accountId: "default",
          kind: "auth",
          message: "Linked device credentials are invalid.",
        },
      ]),
    ]);

    const issues = collectChannelStatusIssues({
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: true,
            connected: false,
          },
        ],
      },
    });

    expect(issues).toEqual([
      {
        channel: "signal",
        accountId: "default",
        kind: "runtime",
        message: "Channel reports running, but the runtime is disconnected.",
        fix: "restart the channel or gateway",
      },
      {
        channel: "signal",
        accountId: "default",
        kind: "auth",
        message: "Linked device credentials are invalid.",
      },
    ]);
  });
});
