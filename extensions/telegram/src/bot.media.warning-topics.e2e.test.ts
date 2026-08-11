import { describe, expect, it } from "vitest";
import {
  readRemoteMediaBufferSpy,
  telegramBotDepsForTest,
  telegramMediaHarnessSendMessageSpy,
} from "./bot.media.e2e.test-harness.js";
import { createBotHandlerWithOptions } from "./bot.media.test-utils.js";

describe("Telegram single-media warnings", () => {
  it.each([
    {
      description: "forum topic",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 202,
      expectedThreadId: 202,
      failure: new Error("Telegram media exceeds 20 MB limit"),
      expectedWarning: "File too large",
    },
    {
      description: "bot DM topic",
      chat: { id: 4242, type: "private" as const },
      threadId: 303,
      expectedThreadId: 303,
      failure: new Error("Telegram media exceeds 20 MB limit"),
      expectedWarning: "File too large",
    },
    {
      description: "forum General topic",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 1,
      expectedThreadId: undefined,
      failure: new Error("Telegram media exceeds 20 MB limit"),
      expectedWarning: "File too large",
    },
    {
      description: "forum topic after an ordinary download failure",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 404,
      expectedThreadId: 404,
      failure: new Error("permanent download failure"),
      expectedWarning: "Failed to download media",
    },
  ])(
    "keeps $description warnings in their originating Telegram thread",
    async ({ chat, threadId, expectedThreadId, failure, expectedWarning }) => {
      const originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
      telegramBotDepsForTest.getRuntimeConfig = (() => ({
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["777"],
            groupPolicy: "open",
            groups: {
              "-10042": { allowFrom: ["777"], groupPolicy: "open", requireMention: false },
            },
          },
        },
      })) as typeof telegramBotDepsForTest.getRuntimeConfig;

      try {
        const { handler } = await createBotHandlerWithOptions({});
        telegramMediaHarnessSendMessageSpy.mockClear();
        readRemoteMediaBufferSpy.mockRejectedValueOnce(failure);

        await handler({
          message: {
            chat,
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 901,
            message_thread_id: threadId,
            is_topic_message: true,
            caption: "Topic attachment",
            date: 1736380800,
            photo: [{ file_id: "topic-attachment" }],
          },
          me: { username: "openclaw_bot", has_topics_enabled: true },
          getFile: async () => ({ file_path: "photos/topic-attachment.jpg" }),
        });

        expect(telegramMediaHarnessSendMessageSpy).toHaveBeenCalledWith(
          chat.id,
          expect.stringContaining(expectedWarning),
          expect.objectContaining({
            reply_parameters: expect.objectContaining({ message_id: 901 }),
          }),
        );
        const warning = telegramMediaHarnessSendMessageSpy.mock.calls.find(
          ([, text]) => typeof text === "string" && text.includes(expectedWarning),
        );
        if (!warning) {
          throw new Error(`Missing ${expectedWarning} Telegram media warning`);
        }
        const options = warning[2] as { message_thread_id?: number };
        expect(options.message_thread_id).toBe(expectedThreadId);
      } finally {
        telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
      }
    },
  );
});
