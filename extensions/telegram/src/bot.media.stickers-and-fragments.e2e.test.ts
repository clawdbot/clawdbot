import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_TEST_TIMINGS,
  cacheStickerSpy,
  createBotHandlerWithOptions,
  describeStickerImageSpy,
  getCachedStickerSpy,
} from "./bot.media.test-utils.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramTransport } from "./fetch.js";

function resolveScheduledTimerForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
) {
  const timerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
    (call: Parameters<typeof setTimeout>) => call[1] === delayMs,
  );
  const flushTimer =
    timerCallIndex >= 0
      ? (setTimeoutSpy.mock.calls[timerCallIndex]?.[0] as (() => unknown) | undefined)
      : undefined;
  if (timerCallIndex >= 0) {
    clearTimeout(
      setTimeoutSpy.mock.results[timerCallIndex]?.value as ReturnType<typeof setTimeout>,
    );
  }
  return flushTimer;
}

async function flushScheduledTimerForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
) {
  const flushTimer = resolveScheduledTimerForDelay(setTimeoutSpy, delayMs);
  expect(flushTimer).toBeTypeOf("function");
  await flushTimer?.();
}

describe("telegram stickers", () => {
  // Parallel Testbox shards can make these media-path e2e tests slower than standalone local runs.
  const STICKER_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

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
      const proxyFetch = vi.fn().mockResolvedValue(
        new Response(Buffer.from(new Uint8Array([0x52, 0x49, 0x46, 0x46])), {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
      );

      getCachedStickerSpy.mockReturnValue({
        fileId: "old_file_id",
        fileUniqueId: "sticker_unique_456",
        emoji: "😴",
        setName: "OldSet",
        description: "Cached description",
        cachedAt: "2026-01-20T10:00:00.000Z",
      });

      const media = await resolveMedia({
        maxBytes: 2 * 1024 * 1024,
        token: "tok",
        transport: {
          close: async () => {},
          fetch: proxyFetch as unknown as typeof fetch,
          sourceFetch: proxyFetch as unknown as typeof fetch,
        } satisfies TelegramTransport,
        ctx: {
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
          getFile: async () => ({ file_path: "stickers/sticker.webp" }),
        } as TelegramContext,
      });

      const [cachedSticker] =
        (
          cacheStickerSpy.mock.calls as unknown as Array<
            [{ emoji?: string; fileId?: string; setName?: string }]
          >
        )[0] ?? [];
      expect(cachedSticker?.fileId).toBe("new_file_id");
      expect(cachedSticker?.emoji).toBe("🔥");
      expect(cachedSticker?.setName).toBe("NewSet");
      expect(media?.stickerMetadata?.fileId).toBe("new_file_id");
      expect(media?.stickerMetadata?.cachedDescription).toBe("Cached description");
      const [fetchUrl, fetchOptions] = proxyFetch.mock.calls[0] ?? [];
      expect(fetchUrl).toBe("https://api.telegram.org/file/bottok/stickers/sticker.webp");
      expect(fetchOptions?.redirect).toBe("manual");
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

  it(
    "buffers near-limit text and processes sequential parts as one message",
    async () => {
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      try {
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
        await flushScheduledTimerForDelay(setTimeoutSpy, TELEGRAM_TEST_TIMINGS.textFragmentGapMs);

        expect(replySpy).toHaveBeenCalledTimes(1);
        const payload = replySpy.mock.calls[0][0] as { RawBody?: string };
        expect(payload.RawBody).toContain(part1.slice(0, 32));
        expect(payload.RawBody).toContain(part2.slice(0, 32));
      } finally {
        setTimeoutSpy.mockRestore();
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );
});
