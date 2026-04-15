import { RateLimitError } from "@buape/carbon";
import { ChannelType, Routes } from "discord-api-types/v10";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDiscordRest } from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

let addRoleDiscord: typeof import("./send.js").addRoleDiscord;
let banMemberDiscord: typeof import("./send.js").banMemberDiscord;
let createThreadDiscord: typeof import("./send.js").createThreadDiscord;
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

function createCompatRateLimitError(
  response: Response,
  body: { message: string; retry_after: number; global: boolean },
  request?: Request,
): RateLimitError {
  const compatRequest =
    request ??
    new Request("https://discord.com/api/v10/channels/789/messages", {
      method: "POST",
    });
  const RateLimitErrorCtor = RateLimitError as unknown as new (
    response: Response,
    body: { message: string; retry_after: number; global: boolean },
    request?: Request,
  ) => RateLimitError;
  return new RateLimitErrorCtor(response, body, compatRequest);
}

beforeAll(async () => {
  ({
    addRoleDiscord,
    banMemberDiscord,
    createThreadDiscord,
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
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/web-media");
});

describe("sendMessageDiscord", () => {
  it("creates a thread", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread", messageId: "m1" }, { rest, token: "t" });
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("chan1", "m1"),
      expect.objectContaining({ body: { name: "thread" } }),
    );
  });

  it("creates forum threads with an initial message", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, { rest, token: "t" });
    expect(getMock).toHaveBeenCalledWith(Routes.channel("chan1"));
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("chan1"),
      expect.objectContaining({
        body: {
          name: "thread",
          message: { content: "thread" },
        },
      }),
    );
  });

  it("creates media threads with provided content", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildMedia });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", content: "initial forum post" },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("chan1"),
      expect.objectContaining({
        body: {
          name: "thread",
          message: { content: "initial forum post" },
        },
      }),
    );
  });

  it("passes applied_tags for forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "tagged post", appliedTags: ["tag1", "tag2"] },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("chan1"),
      expect.objectContaining({
        body: {
          name: "tagged post",
          message: { content: "tagged post" },
          applied_tags: ["tag1", "tag2"],
        },
      }),
    );
  });

  it("omits applied_tags for non-forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", appliedTags: ["tag1"] },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("chan1"),
      expect.objectContaining({
        body: expect.not.objectContaining({ applied_tags: expect.anything() }),
      }),
    );
  });

  it("falls back when channel lookup is unavailable", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockRejectedValue(new Error("lookup failed"));
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, { rest, token: "t" });
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("chan1"),
      expect.objectContaining({
        body: expect.objectContaining({ name: "thread", type: ChannelType.PublicThread }),
      }),
    );
  });

  it("respects explicit thread type for standalone threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", type: ChannelType.PrivateThread },
      { rest, token: "t" },
    );
    expect(getMock).toHaveBeenCalledWith(Routes.channel("chan1"));
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("chan1"),
      expect.objectContaining({
        body: expect.objectContaining({ name: "thread", type: ChannelType.PrivateThread }),
      }),
    );
  });

  it("sends initial message for non-forum threads with content", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", content: "Hello thread!" },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledTimes(2);
    // First call: create thread
    expect(postMock).toHaveBeenNthCalledWith(
      1,
      Routes.threads("chan1"),
      expect.objectContaining({
        body: expect.objectContaining({ name: "thread", type: ChannelType.PublicThread }),
      }),
    );
    // Second call: send message to thread
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      Routes.channelMessages("t1"),
      expect.objectContaining({
        body: { content: "Hello thread!" },
      }),
    );
  });

  it("sends initial message for message-attached threads with content", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "m1", content: "Discussion here" },
      { rest, token: "t" },
    );
    // Should not detect channel type for message-attached threads
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(2);
    // First call: create thread from message
    expect(postMock).toHaveBeenNthCalledWith(
      1,
      Routes.threads("chan1", "m1"),
      expect.objectContaining({ body: { name: "thread" } }),
    );
    // Second call: send message to thread
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      Routes.channelMessages("t1"),
      expect.objectContaining({
        body: { content: "Discussion here" },
      }),
    );
  });

  it("lists active threads by guild", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ threads: [] });
    await listThreadsDiscord({ guildId: "g1" }, { rest, token: "t" });
    expect(getMock).toHaveBeenCalledWith(Routes.guildActiveThreads("g1"));
  });

  it("times out a member", async () => {
    const { rest, patchMock } = makeDiscordRest();
    patchMock.mockResolvedValue({ id: "m1" });
    await timeoutMemberDiscord(
      { guildId: "g1", userId: "u1", durationMinutes: 10 },
      { rest, token: "t" },
    );
    expect(patchMock).toHaveBeenCalledWith(
      Routes.guildMember("g1", "u1"),
      expect.objectContaining({
        body: expect.objectContaining({
          communication_disabled_until: expect.any(String),
        }),
      }),
    );
  });

  it("adds and removes roles", async () => {
    const { rest, putMock, deleteMock } = makeDiscordRest();
    putMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({});
    await addRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, { rest, token: "t" });
    await removeRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, { rest, token: "t" });
    expect(putMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
    expect(deleteMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
  });

  it("bans a member", async () => {
    const { rest, putMock } = makeDiscordRest();
    putMock.mockResolvedValue({});
    await banMemberDiscord(
      { guildId: "g1", userId: "u1", deleteMessageDays: 2 },
      { rest, token: "t" },
    );
    expect(putMock).toHaveBeenCalledWith(
      Routes.guildBan("g1", "u1"),
      expect.objectContaining({ body: { delete_message_days: 2 } }),
    );
  });
});

describe("listGuildEmojisDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists emojis for a guild", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValue([{ id: "e1", name: "party" }]);
    await listGuildEmojisDiscord("g1", { rest, token: "t" });
    expect(getMock).toHaveBeenCalledWith(Routes.guildEmojis("g1"));
  });
});

describe("uploadEmojiDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads emoji assets", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "e1" });
    await uploadEmojiDiscord(
      {
        guildId: "g1",
        name: "party_blob",
        mediaUrl: "file:///tmp/party.png",
        roleIds: ["r1"],
      },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledWith(
      Routes.guildEmojis("g1"),
      expect.objectContaining({
        body: {
          name: "party_blob",
          image: "data:image/png;base64,aW1n",
          roles: ["r1"],
        },
      }),
    );
    expect(loadWebMediaRaw).toHaveBeenCalledWith("file:///tmp/party.png", 256 * 1024);
  });
});

describe("uploadStickerDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads sticker assets", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "s1" });
    await uploadStickerDiscord(
      {
        guildId: "g1",
        name: "openclaw_wave",
        description: "OpenClaw waving",
        tags: "👋",
        mediaUrl: "file:///tmp/wave.png",
      },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledWith(
      Routes.guildStickers("g1"),
      expect.objectContaining({
        body: {
          name: "openclaw_wave",
          description: "OpenClaw waving",
          tags: "👋",
          files: [
            expect.objectContaining({
              name: "asset.png",
              contentType: "image/png",
            }),
          ],
        },
      }),
    );
    expect(loadWebMediaRaw).toHaveBeenCalledWith("file:///tmp/wave.png", 512 * 1024);
  });
});

describe("sendStickerDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends sticker payloads", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
    const res = await sendStickerDiscord("channel:789", ["123"], {
      rest,
      token: "t",
      content: "hiya",
    });
    expect(res).toEqual({ messageId: "msg1", channelId: "789" });
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({
        body: {
          content: "hiya",
          sticker_ids: ["123"],
        },
      }),
    );
  });
});

describe("sendPollDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends polls with answers", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
    const res = await sendPollDiscord(
      "channel:789",
      {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
      },
      {
        rest,
        token: "t",
      },
    );
    expect(res).toEqual({ messageId: "msg1", channelId: "789" });
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({
        body: expect.objectContaining({
          poll: {
            question: { text: "Lunch?" },
            answers: [{ poll_media: { text: "Pizza" } }, { poll_media: { text: "Sushi" } }],
            duration: 24,
            allow_multiselect: false,
            layout_type: 1,
          },
        }),
      }),
    );
  });
});

function createMockRateLimitError(retryAfter = 0.001): RateLimitError {
  const request = new Request("https://discord.com/api/v10/channels/789/messages", {
    method: "POST",
  });
  const response = new Response(null, {
    status: 429,
    headers: {
      "X-RateLimit-Scope": "user",
      "X-RateLimit-Bucket": "test-bucket",
    },
  });
  return createCompatRateLimitError(
    response,
    {
      message: "You are being rate limited.",
      retry_after: retryAfter,
      global: false,
    },
    request,
  );
}

describe("retry rate limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries on Discord rate limits", async () => {
    const { rest, postMock } = makeDiscordRest();
    const rateLimitError = createMockRateLimitError(0);

    postMock
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

    const res = await sendMessageDiscord("channel:789", "hello", {
      rest,
      token: "t",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(res.messageId).toBe("msg1");
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("uses retry_after delays when rate limited", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    try {
      const { rest, postMock } = makeDiscordRest();
      const rateLimitError = createMockRateLimitError(0.001);

      postMock
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

      const promise = sendMessageDiscord("channel:789", "hello", {
        rest,
        token: "t",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
      });

      await expect(promise).resolves.toEqual({
        messageId: "msg1",
        channelId: "789",
      });
      expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("stops after max retry attempts", async () => {
    const { rest, postMock } = makeDiscordRest();
    const rateLimitError = createMockRateLimitError(0);

    postMock.mockRejectedValue(rateLimitError);

    await expect(
      sendMessageDiscord("channel:789", "hello", {
        rest,
        token: "t",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-rate-limit errors", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockRejectedValueOnce(new Error("network error"));

    await expect(sendMessageDiscord("channel:789", "hello", { rest, token: "t" })).rejects.toThrow(
      "network error",
    );
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("retries reactions on rate limits", async () => {
    const { rest, putMock } = makeDiscordRest();
    const rateLimitError = createMockRateLimitError(0);

    putMock.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(undefined);

    const res = await reactMessageDiscord("chan1", "msg1", "ok", {
      rest,
      token: "t",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(res.ok).toBe(true);
    expect(putMock).toHaveBeenCalledTimes(2);
  });

  it("retries media upload without duplicating overflow text", async () => {
    const { rest, postMock } = makeDiscordRest();
    const rateLimitError = createMockRateLimitError(0);
    const text = "a".repeat(2005);

    postMock
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" })
      .mockResolvedValueOnce({ id: "msg2", channel_id: "789" });

    const res = await sendMessageDiscord("channel:789", text, {
      rest,
      token: "t",
      mediaUrl: "https://example.com/photo.jpg",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(res.messageId).toBe("msg1");
    expect(postMock).toHaveBeenCalledTimes(3);
  });
});
