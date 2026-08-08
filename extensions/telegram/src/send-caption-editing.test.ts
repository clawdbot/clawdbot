import { describe, expect, it } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi, loadConfig } = getTelegramSendTestMocks();
const { editMessageTelegram } = await importTelegramSendModule();

describe("Telegram caption edits", () => {
  it.each([
    {
      description: "non-empty plain",
      caption: "Updated **caption**",
      expected: "Updated <b>caption</b>",
      richMessages: false,
    },
    { description: "empty plain", caption: "", expected: "", richMessages: false },
    {
      description: "non-empty rich",
      caption: "Updated **caption**",
      expected: "Updated <b>caption</b>",
      richMessages: true,
    },
    { description: "empty rich", caption: "", expected: "", richMessages: true },
  ])(
    "preserves $description captions at the Bot API boundary",
    async ({ caption, expected, richMessages }) => {
      loadConfig.mockReturnValue({ channels: { telegram: { botToken: "tok", richMessages } } });
      botApi.editMessageCaption.mockResolvedValue({ message_id: 321, chat: { id: "123456" } });

      await editMessageTelegram("123456", 321, caption, {
        cfg: { channels: { telegram: { botToken: "tok", richMessages } } },
        token: "tok",
        accountId: "default",
        editMode: "caption",
      });

      expect(botApi.editMessageText).not.toHaveBeenCalled();
      expect(botApi.editMessageCaption).toHaveBeenCalledWith("123456", 321, {
        caption: expected,
        parse_mode: "HTML",
      });
    },
  );
});
