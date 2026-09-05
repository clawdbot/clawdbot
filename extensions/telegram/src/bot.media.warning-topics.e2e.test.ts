import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onSpy,
  readRemoteMediaBufferSpy,
  telegramBotDepsForTest,
  telegramMediaHarnessSendMessageSpy,
} from "./bot.media.e2e.test-harness.js";
import { createBotHandlerWithOptions, mockTelegramPngDownload } from "./bot.media.test-utils.js";

describe("Telegram media failure notices", () => {
  beforeEach(() => {
    telegramBotDepsForTest.getRuntimeConfig = () => ({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groupAllowFrom: ["777", "-10042"],
          groupPolicy: "open",
          mediaMaxMb: 8,
          groups: {
            "-10042": { groupPolicy: "open", requireMention: false },
          },
        },
      },
    });
    telegramMediaHarnessSendMessageSpy.mockClear();
  });
  it.each([
    {
      description: "forum topic",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 202,
      expectedThreadId: 202,
      failure: new Error("Telegram media exceeds 20 MB limit"),
      expectedWarning: "File too large",
      expectedNotice: "[media unavailable: file exceeds 8MB limit]",
    },
    {
      description: "bot DM topic",
      chat: { id: 4242, type: "private" as const },
      threadId: 303,
      expectedThreadId: 303,
      failure: new Error("Telegram media exceeds 20 MB limit"),
      expectedWarning: "File too large",
      expectedNotice: "[media unavailable: file exceeds 8MB limit]",
    },
    {
      description: "forum General topic",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 1,
      expectedThreadId: undefined,
      failure: new Error("Telegram media exceeds 20 MB limit"),
      expectedWarning: "File too large",
      expectedNotice: "[media unavailable: file exceeds 8MB limit]",
    },
    {
      description: "forum topic after an ordinary download failure",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 404,
      expectedThreadId: 404,
      failure: new Error("permanent download failure"),
      expectedWarning: "Failed to download media",
      expectedNotice: "[media unavailable: download failed]",
    },
  ])(
    "keeps $description warnings in their originating Telegram thread",
    async ({ chat, threadId, expectedThreadId, failure, expectedWarning, expectedNotice }) => {
      const { handler, replySpy } = await createBotHandlerWithOptions({});
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
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        Body: expect.stringContaining(expectedNotice),
        BodyForAgent: `Topic attachment\n\n${expectedNotice}`,
        RawBody: "Topic attachment",
        CommandBody: "Topic attachment",
      });
    },
  );

  it.each([false, true])(
    "keeps channel-post oversize warnings suppressed (failure=%s)",
    async (fails) => {
      const { replySpy } = await createBotHandlerWithOptions({});
      const handler = onSpy.mock.calls.find(([event]) => event === "channel_post")?.[1];
      mockTelegramPngDownload();
      if (fails) {
        readRemoteMediaBufferSpy.mockRejectedValueOnce(
          new Error("Telegram media exceeds 8 MB limit"),
        );
      }
      await handler({
        channelPost: {
          chat: { id: -10042, type: "channel", title: "Announcements" },
          sender_chat: { id: -10042, type: "channel", title: "Announcements" },
          message_id: 902,
          date: 1736380800,
          caption: "Channel attachment",
          photo: [{ file_id: "channel-attachment" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/channel-attachment.jpg" }),
      });
      expect(telegramMediaHarnessSendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0];
      expect(payload).toMatchObject({
        BodyForAgent: fails
          ? "Channel attachment\n\n[media unavailable: file exceeds 8MB limit]"
          : "Channel attachment",
        RawBody: "Channel attachment",
        CommandBody: "Channel attachment",
      });
      expect(payload.Body.includes("[media unavailable:")).toBe(fails);
    },
  );

  it.each([0, 1, 2])("accounts for %s failed attachments in an album", async (failedCount) => {
    const { handler, replySpy } = await createBotHandlerWithOptions({});
    mockTelegramPngDownload();
    for (let index = 0; index < failedCount; index++) {
      readRemoteMediaBufferSpy.mockRejectedValueOnce(
        new Error("Telegram media exceeds 8 MB limit"),
      );
    }
    for (let index = 0; index < 2; index++) {
      await handler({
        message: {
          chat: { id: 4242, type: "private" },
          from: { id: 777, is_bot: false, first_name: "Ada" },
          message_id: 910 + index,
          date: 1736380800,
          media_group_id: "failure-notice-album",
          caption: index === 0 ? "Album attachment" : undefined,
          photo: [{ file_id: `album-${index}` }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: `photos/album-${index}.jpg` }),
      });
    }
    await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
    const payload = replySpy.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      BodyForAgent: failedCount
        ? `Album attachment\n\n[media unavailable: ${failedCount} of 2 attachments could not be downloaded]`
        : "Album attachment",
      RawBody: "Album attachment",
      CommandBody: "Album attachment",
    });
    expect(payload.Body.includes("[media unavailable:")).toBe(failedCount > 0);
    expect(payload.media.filter((media: { path?: string }) => media.path)).toHaveLength(
      2 - failedCount,
    );
  });
});
