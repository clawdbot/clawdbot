import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

type ReportChannelRoomJoin =
  typeof import("openclaw/plugin-sdk/channel-join-intro-runtime").reportChannelRoomJoin;

const { reportChannelRoomJoinMock } = vi.hoisted(() => ({
  reportChannelRoomJoinMock: vi.fn<ReportChannelRoomJoin>(async () => ({ kind: "posted" })),
}));

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", () => ({
  reportChannelRoomJoin: reportChannelRoomJoinMock,
}));

const { getChatSpy, getLoadConfigMock, getOnHandler, telegramBotDepsForTest } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");

const TELEGRAM_GROUP_CHAT_ID = -1001234567890;

function createMembershipContext(params?: {
  chatType?: "private" | "group" | "supergroup" | "channel";
  oldStatus?: "left" | "member";
  newStatus?: "left" | "member";
  memberId?: number;
  contextBotId?: number;
}) {
  const member = {
    id: params?.memberId ?? telegramBotInfoForTest.id,
    is_bot: true,
    first_name: "OpenClaw",
  };
  const membership = {
    chat: {
      id: TELEGRAM_GROUP_CHAT_ID,
      type: params?.chatType ?? "supergroup",
      title: "Incident Response",
    },
    from: { id: 12345, is_bot: false, first_name: "Sam", last_name: "Rivera" },
    date: 1736380800,
    old_chat_member: { status: params?.oldStatus ?? "left", user: member },
    new_chat_member: { status: params?.newStatus ?? "member", user: member },
  };
  return {
    update: { update_id: 900, my_chat_member: membership },
    myChatMember: membership,
    me: { ...telegramBotInfoForTest, id: params?.contextBotId ?? telegramBotInfoForTest.id },
  };
}

function registerJoinHandler(config: OpenClawConfig) {
  getLoadConfigMock().mockReturnValue(config);
  createTelegramBotCore({
    token: "tok",
    botInfo: telegramBotInfoForTest,
    telegramDeps: telegramBotDepsForTest,
  });
  return getOnHandler("my_chat_member");
}

describe("Telegram group join introductions", () => {
  beforeEach(() => {
    reportChannelRoomJoinMock.mockClear();
  });

  it("reports the bot's native group join with metadata-only room context", async () => {
    const config: OpenClawConfig = {
      channels: {
        telegram: {
          groupPolicy: "open",
          groupAllowFrom: ["99999"],
        },
      },
    };
    getChatSpy.mockResolvedValue({
      id: TELEGRAM_GROUP_CHAT_ID,
      type: "supergroup",
      title: "Incident Response",
      description: "Coordinate production incidents",
      pinned_message: { text: "Start with the incident checklist" },
    });
    const handler = registerJoinHandler(config);

    await handler(createMembershipContext());

    expect(reportChannelRoomJoinMock).toHaveBeenCalledTimes(1);
    const params = reportChannelRoomJoinMock.mock.calls[0]?.[0];
    if (!params) {
      throw new Error("Expected a group join introduction");
    }
    expect(params).toMatchObject({
      cfg: config,
      channel: "telegram",
      accountId: "default",
      conversationId: String(TELEGRAM_GROUP_CHAT_ID),
      deliverTo: String(TELEGRAM_GROUP_CHAT_ID),
      inviterLabel: "Sam Rivera",
      roomAllowed: true,
      route: { agentId: "main" },
    });
    await expect(params.resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "Incident Response",
      purpose: "Coordinate production incidents",
      pinned: "Start with the incident checklist",
      historyUnavailable: true,
    });
    expect(getChatSpy).toHaveBeenCalledWith(TELEGRAM_GROUP_CHAT_ID);
  });

  it.each([
    { name: "a private chat", membership: { chatType: "private" as const } },
    { name: "a channel", membership: { chatType: "channel" as const } },
    { name: "an existing member", membership: { oldStatus: "member" as const } },
    { name: "a departure", membership: { newStatus: "left" as const } },
    { name: "another member", membership: { memberId: 321 } },
  ])("ignores $name", async ({ membership }) => {
    const handler = registerJoinHandler({
      channels: { telegram: { groupPolicy: "open" } },
    });

    await handler(createMembershipContext(membership));

    expect(reportChannelRoomJoinMock).not.toHaveBeenCalled();
    expect(getChatSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "disabled group policy",
      config: { groupPolicy: "disabled" as const },
    },
    {
      name: "an explicitly disabled group",
      config: {
        groupPolicy: "open" as const,
        groups: { [String(TELEGRAM_GROUP_CHAT_ID)]: { enabled: false } },
      },
    },
    {
      name: "a group outside the room allowlist",
      config: {
        groupPolicy: "allowlist" as const,
        groups: { "-1009999999999": { enabled: true } },
      },
    },
  ])("passes a rejected conversation to the shared owner for $name", async ({ config }) => {
    const handler = registerJoinHandler({ channels: { telegram: config } });

    await handler(createMembershipContext());

    expect(reportChannelRoomJoinMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: String(TELEGRAM_GROUP_CHAT_ID),
        roomAllowed: false,
      }),
    );
    expect(getChatSpy).not.toHaveBeenCalled();
  });
});
