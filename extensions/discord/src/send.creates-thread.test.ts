import { ChannelType, Routes } from "discord-api-types/v10";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./internal/discord.js";
import { makeDiscordRest } from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

let addRoleDiscord: typeof import("./send.js").addRoleDiscord;
let banMemberDiscord: typeof import("./send.js").banMemberDiscord;
let createThreadDiscord: typeof import("./send.js").createThreadDiscord;
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

function createRateLimitError(
  response: Response,
  body: { message: string; retry_after: number; global: boolean },
  request?: Request,
): RateLimitError {
  const fallbackRequest =
    request ??
    new Request("https://discord.com/api/v10/channels/789/messages", {
      method: "POST",
    });
  const RateLimitErrorCtor = RateLimitError as unknown as new (
    response: Response,
    body: { message: string; retry_after: number; global: boolean },
    request?: Request,
  ) => RateLimitError;
  return new RateLimitErrorCtor(response, body, fallbackRequest);
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
    await createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "m1" },
      discordClientOpts(rest),
    );
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
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
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
      discordClientOpts(rest),
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
      discordClientOpts(rest),
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
      discordClientOpts(rest),
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
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
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
      discordClientOpts(rest),
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
      discordClientOpts(rest),
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
    expect(thrown).toMatchObject({
      name: "DiscordThreadInitialMessageError",
      initialMessageError: "missing access",
      thread: { id: "t1", name: "thread", type: ChannelType.PublicThread },
    });
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
    await listGuildEmojisDiscord("g1", discordClientOpts(rest));
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
      discordClientOpts(rest),
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
      discordClientOpts(rest),
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
      cfg: DISCORD_TEST_CFG,
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
        cfg: DISCORD_TEST_CFG,
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
  return createRateLimitError(
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
      cfg: DISCORD_TEST_CFG,
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
        cfg: DISCORD_TEST_CFG,
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
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent non-rate-limit errors", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockRejectedValueOnce(new Error("invalid request"));

    await expect(
      sendMessageDiscord("channel:789", "hello", discordClientOpts(rest)),
    ).rejects.toThrow("invalid request");
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient network errors", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

    const result = await sendMessageDiscord("channel:789", "hello", {
      cfg: DISCORD_TEST_CFG,
      rest,
      token: "t",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result).toEqual({ messageId: "msg1", channelId: "789" });
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("retries reactions on rate limits", async () => {
    const { rest, putMock } = makeDiscordRest();
    const rateLimitError = createMockRateLimitError(0);

    putMock.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(undefined);

    const res = await reactMessageDiscord("chan1", "msg1", "ok", {
      cfg: DISCORD_TEST_CFG,
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
      cfg: DISCORD_TEST_CFG,
      rest,
      token: "t",
      mediaUrl: "https://example.com/photo.jpg",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(res.messageId).toBe("msg1");
    expect(postMock).toHaveBeenCalledTimes(3);
  });
});
