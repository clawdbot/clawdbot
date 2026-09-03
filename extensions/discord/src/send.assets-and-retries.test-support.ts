import { MessageFlags, Routes } from "discord-api-types/v10";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./internal/discord.js";
import {
  makeDiscordRest,
  requestBody,
  requestPath,
  timerDelayAt,
  type MockCallSource,
} from "./send.test-harness.js";

type SendAssetsAndRetriesDeps = {
  listGuildEmojisDiscord: typeof import("./send.js").listGuildEmojisDiscord;
  reactMessageDiscord: typeof import("./send.js").reactMessageDiscord;
  sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;
  sendPollDiscord: typeof import("./send.js").sendPollDiscord;
  sendStickerDiscord: typeof import("./send.js").sendStickerDiscord;
  uploadEmojiDiscord: typeof import("./send.js").uploadEmojiDiscord;
  uploadStickerDiscord: typeof import("./send.js").uploadStickerDiscord;
};

export function registerSendAssetsAndRetriesTests(deps: SendAssetsAndRetriesDeps): void {
  const {
    listGuildEmojisDiscord,
    reactMessageDiscord,
    sendMessageDiscord,
    sendPollDiscord,
    sendStickerDiscord,
    uploadEmojiDiscord,
    uploadStickerDiscord,
  } = deps;
  const discordTestConfig = {
    channels: {
      discord: {
        accounts: {
          default: {},
        },
      },
    },
  };

  const discordClientOpts = (rest: ReturnType<typeof makeDiscordRest>["rest"]) => ({
    cfg: discordTestConfig,
    rest,
    token: "t",
  });

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
        cfg: discordTestConfig,
        rest,
        token: "t",
        content: "hiya",
      });
      expect(res.messageId).toBe("msg1");
      expect(res.channelId).toBe("789");
      expect(res.receipt.parts[0]?.platformMessageId).toBe("msg1");
      expect(res.receipt.parts[0]?.kind).toBe("card");
      expect(requestPath(postMock as unknown as MockCallSource)).toBe(
        Routes.channelMessages("789"),
      );
      expect(requestBody(postMock as unknown as MockCallSource)).toMatchObject({
        content: "hiya",
        flags: MessageFlags.SuppressEmbeds,
        sticker_ids: ["123"],
        enforce_nonce: true,
      });
      expect(requestBody(postMock as unknown as MockCallSource).nonce).toMatch(/^[0-9a-f]{24}$/);
    });

    it("allows sticker content link embeds when disabled", async () => {
      const { rest, postMock } = makeDiscordRest();
      postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
      await sendStickerDiscord("channel:789", ["123"], {
        cfg: discordTestConfig,
        rest,
        token: "t",
        content: "https://example.com",
        suppressEmbeds: false,
      });

      expect(requestBody(postMock as unknown as MockCallSource)).toMatchObject({
        content: "https://example.com",
        sticker_ids: ["123"],
        enforce_nonce: true,
      });
      expect(requestBody(postMock as unknown as MockCallSource).nonce).toMatch(/^[0-9a-f]{24}$/);
    });

    it.each([
      { silent: true, flags: MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications },
      { silent: false, flags: MessageFlags.SuppressEmbeds },
      { silent: undefined, flags: MessageFlags.SuppressEmbeds },
    ])("preserves sticker notification flags for silent=$silent", async ({ silent, flags }) => {
      const { rest, postMock } = makeDiscordRest();
      postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });

      await sendStickerDiscord("channel:789", ["123"], {
        cfg: discordTestConfig,
        rest,
        token: "t",
        content: "https://example.com",
        ...(silent === undefined ? {} : { silent }),
      });

      expect(requestBody(postMock as unknown as MockCallSource).flags).toBe(flags);
    });

    it("reuses a single nonce across a retried 502 for stickers", async () => {
      const { rest, postMock } = makeDiscordRest();
      postMock
        .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
        .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });
      await sendStickerDiscord("channel:789", ["123"], {
        cfg: discordTestConfig,
        rest,
        token: "t",
        content: "hiya",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
      expect(postMock).toHaveBeenCalledTimes(2);
      const firstNonce = requestBody(postMock as unknown as MockCallSource, 0).nonce;
      const secondNonce = requestBody(postMock as unknown as MockCallSource, 1).nonce;
      expect(firstNonce).toMatch(/^[0-9a-f]{24}$/);
      expect(secondNonce).toBe(firstNonce);
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
          cfg: discordTestConfig,
          rest,
          token: "t",
          threadId: "789",
        },
      );
      expect(res.messageId).toBe("msg1");
      expect(res.channelId).toBe("789");
      expect(res.receipt.parts[0]?.platformMessageId).toBe("msg1");
      expect(res.receipt.parts[0]?.kind).toBe("poll");
      expect(res.receipt.threadId).toBe("789");
      expect(requestPath(postMock as unknown as MockCallSource)).toBe(
        Routes.channelMessages("789"),
      );
      expect(requestBody(postMock as unknown as MockCallSource).flags).toBe(
        MessageFlags.SuppressEmbeds,
      );
      expect(requestBody(postMock as unknown as MockCallSource).poll).toEqual({
        question: { text: "Lunch?" },
        answers: [{ poll_media: { text: "Pizza" } }, { poll_media: { text: "Sushi" } }],
        duration: 24,
        allow_multiselect: false,
        layout_type: 1,
      });
      expect(requestBody(postMock as unknown as MockCallSource)).toMatchObject({
        enforce_nonce: true,
      });
      expect(requestBody(postMock as unknown as MockCallSource).nonce).toMatch(/^[0-9a-f]{24}$/);
    });

    it("reuses a single nonce across a retried 502 for polls", async () => {
      const { rest, postMock } = makeDiscordRest();
      postMock
        .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
        .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });
      await sendPollDiscord(
        "channel:789",
        {
          question: "Lunch?",
          options: ["Pizza", "Sushi"],
        },
        {
          cfg: discordTestConfig,
          rest,
          token: "t",
          retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        },
      );
      expect(postMock).toHaveBeenCalledTimes(2);
      const firstNonce = requestBody(postMock as unknown as MockCallSource, 0).nonce;
      const secondNonce = requestBody(postMock as unknown as MockCallSource, 1).nonce;
      expect(firstNonce).toMatch(/^[0-9a-f]{24}$/);
      expect(secondNonce).toBe(firstNonce);
    });

    it("combines silent and suppress-embeds flags for polls", async () => {
      const { rest, postMock } = makeDiscordRest();
      postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
      await sendPollDiscord(
        "channel:789",
        {
          question: "Lunch?",
          options: ["Pizza", "Sushi"],
        },
        {
          cfg: discordTestConfig,
          rest,
          token: "t",
          content: "https://example.com",
          silent: true,
        },
      );

      expect(requestBody(postMock as unknown as MockCallSource).flags).toBe(
        MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications,
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
        cfg: discordTestConfig,
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
          cfg: discordTestConfig,
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
          cfg: discordTestConfig,
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

    it("retries ambiguous network errors with one stable enforced nonce", async () => {
      const { rest, postMock } = makeDiscordRest();
      postMock
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

      const result = await sendMessageDiscord("channel:789", "hello", {
        cfg: discordTestConfig,
        rest,
        token: "t",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });

      expect(result.messageId).toBe("msg1");
      expect(postMock).toHaveBeenCalledTimes(2);
      const firstBody = requestBody(postMock as unknown as MockCallSource, 0);
      const secondBody = requestBody(postMock as unknown as MockCallSource, 1);
      expect(firstBody.enforce_nonce).toBe(true);
      expect(secondBody.nonce).toBe(firstBody.nonce);
    });

    it("retries reactions on rate limits", async () => {
      const { rest, putMock } = makeDiscordRest();
      const rateLimitError = createMockRateLimitError(0);

      putMock.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(undefined);

      const res = await reactMessageDiscord("chan1", "msg1", "ok", {
        cfg: discordTestConfig,
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
        cfg: discordTestConfig,
        rest,
        token: "t",
        mediaUrl: "https://example.com/photo.jpg",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });

      expect(res.messageId).toBe("msg1");
      expect(postMock).toHaveBeenCalledTimes(3);
    });
  });
}
