import { describe, expect, it, vi } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi, maybePersistResolvedTelegramTarget } = getTelegramSendTestMocks();
const { deleteMessageTelegram, pinMessageTelegram, reactMessageTelegram, unpinMessageTelegram } =
  await importTelegramSendModule();

const chatId = "-1001234567890";
const messageId = 321;
const getChat = vi.fn(async () => ({ id: Number(chatId) }));
const opts = {
  cfg: {},
  token: "tok",
  accountId: "default",
  api: { ...botApi, getChat } as unknown as Parameters<typeof reactMessageTelegram>[3]["api"],
  gatewayClientScopes: ["operator.write"],
};

const mutations = [
  {
    name: "reaction",
    run: (target: string) => reactMessageTelegram(target, messageId, "✅", opts),
    assertCall: () =>
      expect(botApi.setMessageReaction).toHaveBeenCalledWith(chatId, messageId, [
        { type: "emoji", emoji: "✅" },
      ]),
  },
  {
    name: "delete",
    run: (target: string) => deleteMessageTelegram(target, messageId, opts),
    assertCall: () => expect(botApi.deleteMessage).toHaveBeenCalledWith(chatId, messageId),
  },
  {
    name: "pin",
    run: (target: string) => pinMessageTelegram(target, messageId, opts),
    assertCall: () =>
      expect(botApi.pinChatMessage).toHaveBeenCalledWith(chatId, messageId, {
        disable_notification: true,
      }),
  },
  {
    name: "unpin",
    run: (target: string) => unpinMessageTelegram(target, messageId, opts),
    assertCall: () => expect(botApi.unpinChatMessage).toHaveBeenCalledWith(chatId, messageId),
  },
  {
    name: "unpin without an explicit message",
    run: (target: string) => unpinMessageTelegram(target, undefined, opts),
    assertCall: () => expect(botApi.unpinChatMessage).toHaveBeenCalledWith(chatId, undefined),
  },
] as const;

describe("Telegram topic-qualified message mutations", () => {
  it.each(
    mutations.flatMap((mutation) => [
      { ...mutation, target: `${chatId}:topic:77` },
      { ...mutation, target: `telegram:group:${chatId}:topic:77` },
      { ...mutation, target: "@mychannel:topic:77" },
    ]),
  )(
    "routes $name mutations for $target to their base chat",
    async ({ run, assertCall, target }) => {
      botApi.setMessageReaction.mockResolvedValue(true);
      botApi.deleteMessage.mockResolvedValue(true);
      botApi.pinChatMessage.mockResolvedValue(true);
      botApi.unpinChatMessage.mockResolvedValue(true);
      getChat.mockClear();

      await run(target);

      assertCall();
      expect(maybePersistResolvedTelegramTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          rawTarget: target,
          resolvedChatId: chatId,
          gatewayClientScopes: ["operator.write"],
        }),
      );
      if (target.startsWith("@")) {
        expect(getChat).toHaveBeenCalledWith("@mychannel");
      }
    },
  );
});
