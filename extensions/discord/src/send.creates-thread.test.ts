import { ChannelType, Routes } from "discord-api-types/v10";
// Discord tests cover send.creates thread plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSendAssetsAndRetriesTests } from "./send.assets-and-retries.test-support.js";
import { makeDiscordRest, requestBody, requestPath } from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

let addRoleDiscord: typeof import("./send.js").addRoleDiscord;
let banMemberDiscord: typeof import("./send.js").banMemberDiscord;
let createThreadDiscord: typeof import("./send.js").createThreadDiscord;
let discordOutbound: typeof import("./outbound-adapter.js").discordOutbound;
let DiscordThreadInitialMessageError: typeof import("./send.js").DiscordThreadInitialMessageError;
let listGuildEmojisDiscord: typeof import("./send.js").listGuildEmojisDiscord;
let listThreadsDiscord: typeof import("./send.js").listThreadsDiscord;
let reactMessageDiscord: typeof import("./send.js").reactMessageDiscord;
let removeRoleDiscord: typeof import("./send.js").removeRoleDiscord;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;
let sendPollDiscord: typeof import("./send.js").sendPollDiscord;
let sendStickerDiscord: typeof import("./send.js").sendStickerDiscord;
let timeoutMemberDiscord: typeof import("./send.js").timeoutMemberDiscord;
let uploadEmojiDiscord: typeof import("./send.js").uploadEmojiDiscord;
let uploadStickerDiscord: typeof import("./send.js").uploadStickerDiscord;

const DISCORD_TEST_CFG = {
  channels: {
    discord: {
      accounts: {
        default: {},
      },
    },
  },
};

function discordClientOpts(rest: ReturnType<typeof makeDiscordRest>["rest"]) {
  return { cfg: DISCORD_TEST_CFG, rest, token: "t" };
}

const requireRecord = createRequireRecord("object", "expected-label");

function createDiscordForumPayloadHarness(parentType: ChannelType = ChannelType.GuildForum) {
  const parentId = "700";
  const { rest, getMock, postMock } = makeDiscordRest();
  let threadCount = 0;
  let messageCount = 0;

  getMock.mockImplementation(async (path: unknown) => {
    const channelId = String(path).split("/").at(-1);
    return {
      id: channelId,
      type: channelId === parentId ? parentType : ChannelType.PublicThread,
    };
  });
  postMock.mockImplementation(async (path: unknown) => {
    if (path === Routes.threads(parentId)) {
      threadCount += 1;
      const threadId = String(700 + threadCount);
      return {
        id: threadId,
        message: { id: `starter-${threadCount}`, channel_id: threadId },
      };
    }
    const channelId = String(path).split("/").at(-2);
    messageCount += 1;
    return { id: `message-${messageCount}`, channel_id: channelId };
  });

  return {
    parentId,
    postMock,
    run: async (
      payload: { text: string; mediaUrls?: string[] },
      options: {
        threadId?: string;
        onDeliveryResult?: Parameters<
          NonNullable<typeof discordOutbound.sendPayload>
        >[0]["onDeliveryResult"];
      } = {},
    ) =>
      await discordOutbound.sendPayload?.({
        cfg: DISCORD_TEST_CFG,
        to: `channel:${parentId}`,
        text: payload.text,
        payload,
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.onDeliveryResult ? { onDeliveryResult: options.onDeliveryResult } : {}),
        deps: {
          discord: async (...[target, text, sendOptions]: Parameters<typeof sendMessageDiscord>) =>
            await sendMessageDiscord(target, text, {
              ...sendOptions,
              rest,
              token: "t",
            }),
        },
      }),
  };
}

beforeAll(async () => {
  ({
    addRoleDiscord,
    banMemberDiscord,
    createThreadDiscord,
    DiscordThreadInitialMessageError,
    listGuildEmojisDiscord,
    listThreadsDiscord,
    reactMessageDiscord,
    removeRoleDiscord,
    sendMessageDiscord,
    sendPollDiscord,
    sendStickerDiscord,
    timeoutMemberDiscord,
    uploadEmojiDiscord,
    uploadStickerDiscord,
  } = await import("./send.js"));
  ({ discordOutbound } = await import("./outbound-adapter.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/web-media");
});

registerSendAssetsAndRetriesTests({
  listGuildEmojisDiscord: (...args) => listGuildEmojisDiscord(...args),
  reactMessageDiscord: (...args) => reactMessageDiscord(...args),
  sendMessageDiscord: (...args) => sendMessageDiscord(...args),
  sendPollDiscord: (...args) => sendPollDiscord(...args),
  sendStickerDiscord: (...args) => sendStickerDiscord(...args),
  uploadEmojiDiscord: (...args) => uploadEmojiDiscord(...args),
  uploadStickerDiscord: (...args) => uploadStickerDiscord(...args),
});

describe("sendMessageDiscord", () => {
  it.each([
    {
      label: "a 2001-character reply",
      payload: { text: "a".repeat(2001) },
      expectedThreadMessages: 1,
    },
    {
      label: "a reply with two image attachments",
      payload: {
        text: "Generated images",
        mediaUrls: ["https://example.com/first.jpg", "https://example.com/second.jpg"],
      },
      expectedThreadMessages: 2,
    },
  ])("keeps $label in one automatically created forum thread", async (testCase) => {
    const { parentId, postMock, run } = createDiscordForumPayloadHarness();
    const onDeliveryResult = vi.fn();

    const result = await run(testCase.payload, { onDeliveryResult });

    const requestPaths = postMock.mock.calls.map((call) => call[0]);
    expect(requestPaths).toEqual([
      Routes.threads(parentId),
      ...Array.from({ length: testCase.expectedThreadMessages }, () =>
        Routes.channelMessages("701"),
      ),
    ]);
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.channelId)).toEqual(
      Array.from({ length: testCase.expectedThreadMessages + 1 }, () => "701"),
    );
    expect(result?.receipt).toMatchObject({
      threadId: "701",
      platformMessageIds: [
        "starter-1",
        ...Array.from(
          { length: testCase.expectedThreadMessages },
          (_, index) => `message-${index + 1}`,
        ),
      ],
    });
  });

  it("keeps chunked regular-channel replies on their original channel", async () => {
    const { parentId, postMock, run } = createDiscordForumPayloadHarness(ChannelType.GuildText);

    const result = await run({ text: "a".repeat(2001) });

    expect(postMock.mock.calls.map((call) => call[0])).toEqual([
      Routes.channelMessages(parentId),
      Routes.channelMessages(parentId),
    ]);
    expect(result?.receipt?.threadId).toBeUndefined();
    expect(result?.receipt?.platformMessageIds).toEqual(["message-2"]);
  });

  it("keeps chunked replies targeted at an explicitly selected thread", async () => {
    const { postMock, run } = createDiscordForumPayloadHarness();

    const result = await run({ text: "a".repeat(2001) }, { threadId: "701" });

    expect(postMock.mock.calls.map((call) => call[0])).toEqual([
      Routes.channelMessages("701"),
      Routes.channelMessages("701"),
    ]);
    expect(result?.receipt?.threadId).toBeUndefined();
    expect(result?.receipt?.platformMessageIds).toEqual(["message-2"]);
  });

  it("does not attempt a follow-up when forum thread creation is rejected", async () => {
    const { parentId, postMock, run } = createDiscordForumPayloadHarness();
    postMock.mockRejectedValueOnce(new Error("missing access"));

    await expect(run({ text: "a".repeat(2001) })).rejects.toThrow("missing access");

    expect(postMock).toHaveBeenCalledOnce();
    expect(postMock.mock.calls[0]?.[0]).toBe(Routes.threads(parentId));
  });

  it("does not send a forum follow-up when delivery bookkeeping rejects the starter", async () => {
    const { parentId, postMock, run } = createDiscordForumPayloadHarness();
    const onDeliveryResult = vi.fn().mockRejectedValue(new Error("delivery bookkeeping failed"));

    await expect(run({ text: "a".repeat(2001) }, { onDeliveryResult })).rejects.toThrow(
      "delivery bookkeeping failed",
    );

    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(postMock.mock.calls.map((call) => call[0])).toEqual([Routes.threads(parentId)]);
  });

  it("creates a thread", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "m1" },
      discordClientOpts(rest),
    );
    expect(getMock).not.toHaveBeenCalled();
    expect(requestPath(postMock)).toBe(Routes.threads("chan1", "m1"));
    expect(requestBody(postMock)).toEqual({ name: "thread" });
  });

  it("creates forum threads with an initial message", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(getMock).toHaveBeenCalledWith(Routes.channel("chan1"));
    expect(requestPath(postMock)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock)).toEqual({
      name: "thread",
      message: { content: "thread" },
    });
  });

  it("inherits default_auto_archive_duration for forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      type: ChannelType.GuildForum,
      default_auto_archive_duration: 1440,
    });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(requestBody(postMock)).toEqual({
      name: "thread",
      auto_archive_duration: 1440,
      message: { content: "thread" },
    });
  });

  it("inherits default_auto_archive_duration for text-channel threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      type: ChannelType.GuildText,
      default_auto_archive_duration: 10080,
    });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(requestBody(postMock)).toEqual({
      name: "thread",
      auto_archive_duration: 10080,
      type: ChannelType.PublicThread,
    });
  });

  it("prefers explicit autoArchiveMinutes over channel default", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      type: ChannelType.GuildForum,
      default_auto_archive_duration: 1440,
    });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", autoArchiveMinutes: 4320 },
      discordClientOpts(rest),
    );
    expect(requestBody(postMock)).toEqual({
      name: "thread",
      auto_archive_duration: 4320,
      message: { content: "thread" },
    });
  });

  it("preserves explicit autoArchiveMinutes for message-attached threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "m1", autoArchiveMinutes: 4320 },
      discordClientOpts(rest),
    );
    expect(getMock).not.toHaveBeenCalled();
    expect(requestBody(postMock)).toEqual({
      name: "thread",
      auto_archive_duration: 4320,
    });
  });

  it("creates media threads with provided content", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildMedia });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", content: "initial forum post" },
      discordClientOpts(rest),
    );
    expect(requestPath(postMock)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock)).toEqual({
      name: "thread",
      message: { content: "initial forum post" },
    });
  });

  it("passes applied_tags for forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "tagged post", appliedTags: ["tag1", "tag2"] },
      discordClientOpts(rest),
    );
    expect(requestPath(postMock)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock)).toEqual({
      name: "tagged post",
      message: { content: "tagged post" },
      applied_tags: ["tag1", "tag2"],
    });
  });

  it("omits applied_tags for non-forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", appliedTags: ["tag1"] },
      discordClientOpts(rest),
    );
    expect(requestPath(postMock)).toBe(Routes.threads("chan1"));
    expect("applied_tags" in requestBody(postMock)).toBe(false);
  });

  it("falls back when channel lookup is unavailable", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockRejectedValue(new Error("lookup failed"));
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(requestPath(postMock)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock).name).toBe("thread");
    expect(requestBody(postMock).type).toBe(ChannelType.PublicThread);
  });

  it("respects explicit thread type for standalone threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", type: ChannelType.PrivateThread },
      discordClientOpts(rest),
    );
    expect(getMock).toHaveBeenCalledWith(Routes.channel("chan1"));
    expect(requestPath(postMock)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock).name).toBe("thread");
    expect(requestBody(postMock).type).toBe(ChannelType.PrivateThread);
  });

  it("sends initial message for non-forum threads with content", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", content: "Hello thread!" },
      discordClientOpts(rest),
    );
    expect(postMock).toHaveBeenCalledTimes(2);
    // First call: create thread
    expect(requestPath(postMock, 0)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock, 0).name).toBe("thread");
    expect(requestBody(postMock, 0).type).toBe(ChannelType.PublicThread);
    // Second call: send message to thread
    expect(requestPath(postMock, 1)).toBe(Routes.channelMessages("t1"));
    expect(requestBody(postMock, 1)).toMatchObject({
      content: "Hello thread!",
      enforce_nonce: true,
    });
  });

  it("keeps created non-forum thread details when initial message send fails", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock
      .mockResolvedValueOnce({ id: "t1", name: "thread", type: ChannelType.PublicThread })
      .mockRejectedValueOnce(new Error("missing access"));

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "Hello thread!" },
        discordClientOpts(rest),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    const error = requireRecord(thrown, "thread initial message error");
    expect(error.name).toBe("DiscordThreadInitialMessageError");
    expect(error.message).toContain("initial message delivery could not be confirmed");
    expect(error.initialMessageError).toBe("missing access");
    expect(error.thread).toEqual({ id: "t1", name: "thread", type: ChannelType.PublicThread });
  });

  it("sends initial message for message-attached threads with content", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "m1", content: "Discussion here" },
      discordClientOpts(rest),
    );
    // Should not detect channel type for message-attached threads
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(2);
    // First call: create thread from message
    expect(requestPath(postMock, 0)).toBe(Routes.threads("chan1", "m1"));
    expect(requestBody(postMock, 0)).toEqual({ name: "thread" });
    // Second call: send message to thread
    expect(requestPath(postMock, 1)).toBe(Routes.channelMessages("t1"));
    expect(requestBody(postMock, 1)).toMatchObject({
      content: "Discussion here",
      enforce_nonce: true,
    });
  });

  it("lists active threads by guild", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ threads: [] });
    await listThreadsDiscord({ guildId: "g1" }, discordClientOpts(rest));
    expect(getMock).toHaveBeenCalledWith(Routes.guildActiveThreads("g1"));
  });

  it("times out a member", async () => {
    const { rest, patchMock } = makeDiscordRest();
    patchMock.mockResolvedValue({ id: "m1" });
    await timeoutMemberDiscord(
      { guildId: "g1", userId: "u1", durationMinutes: 10 },
      discordClientOpts(rest),
    );
    expect(requestPath(patchMock)).toBe(Routes.guildMember("g1", "u1"));
    expect(requestBody(patchMock).communication_disabled_until).toBeTypeOf("string");
  });

  it("rejects timeout durations outside Date range", async () => {
    const { rest, patchMock } = makeDiscordRest();

    await expect(
      timeoutMemberDiscord(
        { guildId: "g1", userId: "u1", durationMinutes: 8_640_000_000_000_001 },
        discordClientOpts(rest),
      ),
    ).rejects.toThrow("Discord timeout duration is outside the supported Date range");
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("rejects timeout durations that overflow from the current clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const { rest, patchMock } = makeDiscordRest();

    await expect(
      timeoutMemberDiscord(
        { guildId: "g1", userId: "u1", durationMinutes: 1 },
        discordClientOpts(rest),
      ),
    ).rejects.toThrow("Discord timeout duration is outside the supported Date range");
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("adds and removes roles", async () => {
    const { rest, putMock, deleteMock } = makeDiscordRest();
    putMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({});
    await addRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, discordClientOpts(rest));
    await removeRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, discordClientOpts(rest));
    expect(putMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
    expect(deleteMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
  });

  it("bans a member", async () => {
    const { rest, putMock } = makeDiscordRest();
    putMock.mockResolvedValue({});
    await banMemberDiscord(
      { guildId: "g1", userId: "u1", deleteMessageDays: 2 },
      discordClientOpts(rest),
    );
    expect(requestPath(putMock)).toBe(Routes.guildBan("g1", "u1"));
    expect(requestBody(putMock)).toEqual({ delete_message_days: 2 });
  });
});
