import { RateLimitError } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
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
} from "./send.js";

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("img"),
    fileName: "photo.jpg",
    contentType: "image/jpeg",
    kind: "image",
  }),
  loadWebMediaRaw: vi.fn().mockResolvedValue({
    buffer: Buffer.from("img"),
    fileName: "asset.png",
    contentType: "image/png",
    kind: "image",
  }),
}));

const makeRest = () => {
  const postMock = vi.fn();
  const putMock = vi.fn();
  const getMock = vi.fn();
  const patchMock = vi.fn();
  const deleteMock = vi.fn();
  return {
    rest: {
      post: postMock,
      put: putMock,
      get: getMock,
      patch: patchMock,
      delete: deleteMock,
    } as unknown as import("@buape/carbon").RequestClient,
    postMock,
    putMock,
    getMock,
    patchMock,
    deleteMock,
  };
};

describe("sendMessageDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a thread", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread", messageId: "m1" }, { rest, token: "t" });
    expect(postMock).toHaveBeenCalledWith(
      Routes.threads("chan1", "m1"),
      expect.objectContaining({ body: { name: "thread" } }),
    );
  });

  it("lists active threads by guild", async () => {
    const { rest, getMock } = makeRest();
    getMock.mockResolvedValue({ threads: [] });
    await listThreadsDiscord({ guildId: "g1" }, { rest, token: "t" });
    expect(getMock).toHaveBeenCalledWith(Routes.guildActiveThreads("g1"));
  });

  it("times out a member", async () => {
    const { rest, patchMock } = makeRest();
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
    const { rest, putMock, deleteMock } = makeRest();
    putMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({});
    await addRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, { rest, token: "t" });
    await removeRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, { rest, token: "t" });
    expect(putMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
    expect(deleteMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
  });

  it("bans a member", async () => {
    const { rest, putMock } = makeRest();
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
    const { rest, getMock } = makeRest();
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
    const { rest, postMock } = makeRest();
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
  });
});

describe("uploadStickerDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads sticker assets", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({ id: "s1" });
    await uploadStickerDiscord(
      {
        guildId: "g1",
        name: "moltbot_wave",
        description: "Moltbot waving",
        tags: "👋",
        mediaUrl: "file:///tmp/wave.png",
      },
      { rest, token: "t" },
    );
    expect(postMock).toHaveBeenCalledWith(
      Routes.guildStickers("g1"),
      expect.objectContaining({
        body: {
          name: "moltbot_wave",
          description: "Moltbot waving",
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
  });
});

describe("sendStickerDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends sticker payloads", async () => {
    const { rest, postMock } = makeRest();
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
    const { rest, postMock } = makeRest();
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
  const response = new Response(null, {
    status: 429,
    headers: {
      "X-RateLimit-Scope": "user",
      "X-RateLimit-Bucket": "test-bucket",
    },
  });
  return new RateLimitError(response, {
    message: "You are being rate limited.",
    retry_after: retryAfter,
    global: false,
  });
}

describe("retry rate limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries on Discord rate limits", async () => {
    const { rest, postMock } = makeRest();
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
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const { rest, postMock } = makeRest();
    const rateLimitError = createMockRateLimitError(0.5);

    postMock
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

    const promise = sendMessageDiscord("channel:789", "hello", {
      rest,
      token: "t",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({
      messageId: "msg1",
      channelId: "789",
    });
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(500);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("stops after max retry attempts", async () => {
    const { rest, postMock } = makeRest();
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
    const { rest, postMock } = makeRest();
    postMock.mockRejectedValueOnce(new Error("network error"));

    await expect(sendMessageDiscord("channel:789", "hello", { rest, token: "t" })).rejects.toThrow(
      "network error",
    );
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("retries reactions on rate limits", async () => {
    const { rest, putMock } = makeRest();
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
    const { rest, postMock } = makeRest();
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
