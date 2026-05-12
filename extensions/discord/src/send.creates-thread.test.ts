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

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call[argIndex];
}

function requestOptions(source: MockCallSource, callIndex = 0) {
  return requireRecord(
    mockArg(source, callIndex, 1, `request options ${callIndex}`),
    "request options",
  );
}

function requestPath(source: MockCallSource, callIndex = 0) {
  return mockArg(source, callIndex, 0, `request path ${callIndex}`);
}

function requestBody(source: MockCallSource, callIndex = 0) {
  return requireRecord(requestOptions(source, callIndex).body, `request body ${callIndex}`);
}

function timerDelayAt(source: MockCallSource, callIndex = 0) {
  return mockArg(source, callIndex, 1, `timer delay ${callIndex}`);
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
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.threads("chan1", "m1"));
    expect(requestBody(postMock as unknown as MockCallSource)).toEqual({ name: "thread" });
  });

  it("creates forum threads with an initial message", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(getMock).toHaveBeenCalledWith(Routes.channel("chan1"));
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock as unknown as MockCallSource)).toEqual({
      name: "thread",
      message: { content: "thread" },
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
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock as unknown as MockCallSource)).toEqual({
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
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock as unknown as MockCallSource)).toEqual({
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
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.threads("chan1"));
    expect("applied_tags" in requestBody(postMock as unknown as MockCallSource)).toBe(false);
  });

  it("falls back when channel lookup is unavailable", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockRejectedValue(new Error("lookup failed"));
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock as unknown as MockCallSource).name).toBe("thread");
    expect(requestBody(postMock as unknown as MockCallSource).type).toBe(ChannelType.PublicThread);
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
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock as unknown as MockCallSource).name).toBe("thread");
    expect(requestBody(postMock as unknown as MockCallSource).type).toBe(ChannelType.PrivateThread);
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
    expect(requestPath(postMock as unknown as MockCallSource, 0)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock as unknown as MockCallSource, 0).name).toBe("thread");
    expect(requestBody(postMock as unknown as MockCallSource, 0).type).toBe(
      ChannelType.PublicThread,
    );
    // Second call: send message to thread
    expect(requestPath(postMock as unknown as MockCallSource, 1)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(requestBody(postMock as unknown as MockCallSource, 1)).toEqual({
      content: "Hello thread!",
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
    expect(requestPath(postMock as unknown as MockCallSource, 0)).toBe(
      Routes.threads("chan1", "m1"),
    );
    expect(requestBody(postMock as unknown as MockCallSource, 0)).toEqual({ name: "thread" });
    // Second call: send message to thread
    expect(requestPath(postMock as unknown as MockCallSource, 1)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(requestBody(postMock as unknown as MockCallSource, 1)).toEqual({
      content: "Discussion here",
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
    expect(requestPath(patchMock as unknown as MockCallSource)).toBe(
      Routes.guildMember("g1", "u1"),
    );
    expect(
      requestBody(patchMock as unknown as MockCallSource).communication_disabled_until,
    ).toBeTypeOf("string");
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
    expect(requestPath(putMock as unknown as MockCallSource)).toBe(Routes.guildBan("g1", "u1"));
    expect(requestBody(putMock as unknown as MockCallSource)).toEqual({ delete_message_days: 2 });
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
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.guildEmojis("g1"));
    expect(requestBody(postMock as unknown as MockCallSource)).toEqual({
      name: "party_blob",
      image: "data:image/png;base64,aW1n",
      roles: ["r1"],
    });
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
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.guildStickers("g1"));
    const stickerBody = requestBody(postMock as unknown as MockCallSource);
    expect(stickerBody.name).toBe("openclaw_wave");
    expect(stickerBody.description).toBe("OpenClaw waving");
    expect(stickerBody.tags).toBe("👋");
    const files = stickerBody.files as Array<{ name?: string; contentType?: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("asset.png");
    expect(files[0]?.contentType).toBe("image/png");
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
    expect(res.messageId).toBe("msg1");
    expect(res.channelId).toBe("789");
    expect(res.receipt.parts[0]?.platformMessageId).toBe("msg1");
    expect(res.receipt.parts[0]?.kind).toBe("card");
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.channelMessages("789"));
    expect(requestBody(postMock as unknown as MockCallSource)).toEqual({
      content: "hiya",
      sticker_ids: ["123"],
    });
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
    expect(res.messageId).toBe("msg1");
    expect(res.channelId).toBe("789");
    expect(res.receipt.parts[0]?.platformMessageId).toBe("msg1");
    expect(res.receipt.parts[0]?.kind).toBe("card");
    expect(requestPath(postMock as unknown as MockCallSource)).toBe(Routes.channelMessages("789"));
    expect(requestBody(postMock as unknown as MockCallSource).poll).toEqual({
      question: { text: "Lunch?" },
      answers: [{ poll_media: { text: "Pizza" } }, { poll_media: { text: "Sushi" } }],
      duration: 24,
      allow_multiselect: false,
      layout_type: 1,
    });
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

      const result = await promise;
      expect(result.messageId).toBe("msg1");
      expect(result.channelId).toBe("789");
      expect(result.receipt.primaryPlatformMessageId).toBe("msg1");
      expect(result.receipt.platformMessageIds).toEqual(["msg1"]);
      expect(timerDelayAt(setTimeoutSpy as unknown as MockCallSource)).toBe(1);
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

    expect(result.messageId).toBe("msg1");
    expect(result.channelId).toBe("789");
    expect(result.receipt.platformMessageIds).toEqual(["msg1"]);
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
