import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_TEST_TIMINGS,
  cacheStickerSpy,
  createBotHandlerWithOptions,
  describeStickerImageSpy,
  getCachedStickerSpy,
} from "./bot.media.test-utils.js";

describe("telegram stickers", () => {
  const STICKER_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 20_000;

  async function createStaticStickerHarness() {
    const proxyFetch = vi.fn().mockResolvedValue(
      new Response(Buffer.from(new Uint8Array([0x52, 0x49, 0x46, 0x46])), {
        status: 200,
        headers: { "content-type": "image/webp" },
      }),
    );
    const handlerContext = await createBotHandlerWithOptions({
      proxyFetch: proxyFetch as unknown as typeof fetch,
    });
    return { proxyFetch, ...handlerContext };
  }

  beforeEach(() => {
    cacheStickerSpy.mockClear();
    getCachedStickerSpy.mockClear();
    describeStickerImageSpy.mockClear();
    // Re-seed defaults so per-test overrides do not leak when using mockClear.
    getCachedStickerSpy.mockReturnValue(undefined);
    describeStickerImageSpy.mockReturnValue(undefined);
  });

  it(
    "refreshes cached sticker metadata on cache hit",
    async () => {
      const { handler, proxyFetch, replySpy, runtimeError } = await createStaticStickerHarness();

      getCachedStickerSpy.mockReturnValue({
        fileId: "old_file_id",
        fileUniqueId: "sticker_unique_456",
        emoji: "😴",
        setName: "OldSet",
        description: "Cached description",
        cachedAt: "2026-01-20T10:00:00.000Z",
      });

      await handler({
        message: {
          message_id: 103,
          chat: { id: 1234, type: "private" },
          from: { id: 777, is_bot: false, first_name: "Ada" },
          sticker: {
            file_id: "new_file_id",
            file_unique_id: "sticker_unique_456",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: "🔥",
            set_name: "NewSet",
          },
          date: 1736380800,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "stickers/sticker.webp" }),
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(cacheStickerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: "new_file_id",
          emoji: "🔥",
          setName: "NewSet",
        }),
      );
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Sticker?.fileId).toBe("new_file_id");
      expect(payload.Sticker?.cachedDescription).toBe("Cached description");
      expect(proxyFetch).toHaveBeenCalledWith(
        "https://api.telegram.org/file/bottok/stickers/sticker.webp",
        expect.objectContaining({ redirect: "manual" }),
      );
    },
    STICKER_TEST_TIMEOUT_MS,
  );

  it(
    "skips animated and video sticker formats that cannot be downloaded",
    async () => {
      const proxyFetch = vi.fn();
      const { handler, replySpy, runtimeError } = await createBotHandlerWithOptions({
        proxyFetch: proxyFetch as unknown as typeof fetch,
      });

      for (const scenario of [
        {
          messageId: 101,
          filePath: "stickers/animated.tgs",
          sticker: {
            file_id: "animated_sticker_id",
            file_unique_id: "animated_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: true,
            is_video: false,
            emoji: "😎",
            set_name: "AnimatedPack",
          },
        },
        {
          messageId: 102,
          filePath: "stickers/video.webm",
          sticker: {
            file_id: "video_sticker_id",
            file_unique_id: "video_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: true,
            emoji: "🎬",
            set_name: "VideoPack",
          },
        },
      ]) {
        replySpy.mockClear();
        runtimeError.mockClear();
        proxyFetch.mockClear();

        await handler({
          message: {
            message_id: scenario.messageId,
            chat: { id: 1234, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            sticker: scenario.sticker,
            date: 1736380800,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: scenario.filePath }),
        });

        expect(proxyFetch).not.toHaveBeenCalled();
        expect(replySpy).not.toHaveBeenCalled();
        expect(runtimeError).not.toHaveBeenCalled();
      }
    },
    STICKER_TEST_TIMEOUT_MS,
  );
});

describe("telegram text fragments", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const TEXT_FRAGMENT_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const TEXT_FRAGMENT_FLUSH_MS = TELEGRAM_TEST_TIMINGS.textFragmentGapMs + 80;

  it(
    "buffers near-limit text and processes sequential parts as one message",
    async () => {
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 777, is_bot: false, first_name: "Ada" },
          message_id: 10,
          date: 1736380800,
          text: part1,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          from: { id: 777, is_bot: false, first_name: "Ada" },
          message_id: 11,
          date: 1736380801,
          text: part2,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      await vi.waitFor(
        () => {
          expect(replySpy).toHaveBeenCalledTimes(1);
        },
        { timeout: TEXT_FRAGMENT_FLUSH_MS * 6, interval: 5 },
      );

      const payload = replySpy.mock.calls[0][0] as { RawBody?: string };
      expect(payload.RawBody).toContain(part1.slice(0, 32));
      expect(payload.RawBody).toContain(part2.slice(0, 32));
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );
});
