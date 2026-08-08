// Telegram tests cover bot.media reply-quote media cache plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRemoteMediaBufferSpy,
  setNextSavedMediaPath,
  undiciFetchSpy,
} from "./bot.media.e2e-harness.js";
import { createBotHandler } from "./bot.media.test-utils.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import type { TelegramContext } from "./bot/types.js";

type ReplyPayload = {
  ReplyChain?: Array<{
    messageId?: string;
    mediaPath?: string;
    mediaRef?: string;
  }>;
} & Record<string, unknown>;

function replyPayload(replySpy: ReturnType<typeof vi.fn>, index = 0): ReplyPayload {
  const call = replySpy.mock.calls[index];
  if (!call) {
    throw new Error(`expected reply payload ${index}`);
  }
  const payload = call[0];
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`expected reply payload ${index}`);
  }
  return payload as ReplyPayload;
}

const PNG_BYTES = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

function makePhotoCtx(fileUniqueId: string, getFile: TelegramContext["getFile"]): TelegramContext {
  return {
    message: {
      message_id: 1,
      chat: { id: 1234, type: "private" },
      from: { id: 777, is_bot: false, first_name: "Ada" },
      photo: [{ file_id: `${fileUniqueId}-id`, file_unique_id: fileUniqueId }],
      date: 1736380800,
    },
    getFile,
  } as unknown as TelegramContext;
}

describe("telegram reply-quote media cache", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const REPLY_QUOTE_CACHE_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "reuses the original download when a reply quotes the same photo",
    async () => {
      const savedPath = "/tmp/media/inbound/reply-quote-9000.png";
      const { handler, replySpy } = await createBotHandler();
      // Only the fetch boundary is mocked; the harness default readRemoteMediaBuffer
      // still crosses it, so undiciFetchSpy counts real HTTP download attempts.
      undiciFetchSpy.mockResolvedValue(
        new Response(PNG_BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
      setNextSavedMediaPath({
        path: savedPath,
        size: PNG_BYTES.byteLength,
        contentType: "image/png",
      });
      const getFileSpy = vi.fn(async () => ({ file_path: "photos/reply-quote.png" }));

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          message_id: 9000,
          date: 1736380700,
          from: { id: 1, is_bot: false, first_name: "Kesava" },
          photo: [{ file_id: "reply-quote-photo-1", file_unique_id: "reply-quote-u1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: getFileSpy,
      });

      expect(getFileSpy).toHaveBeenCalledTimes(1);
      expect(readRemoteMediaBufferSpy).toHaveBeenCalledTimes(1);
      expect(undiciFetchSpy).toHaveBeenCalledTimes(1);

      replySpy.mockClear();
      const hydrationGetFile = vi.fn(async () => ({}));
      await handler({
        message: {
          chat: { id: 7, type: "private" },
          message_id: 9001,
          text: "r u back from hermes",
          date: 1736380750,
          from: { id: 2, is_bot: false, first_name: "Ada" },
          reply_to_message: {
            message_id: 9000,
            photo: [{ file_id: "reply-quote-photo-1", file_unique_id: "reply-quote-u1" }],
            from: { id: 1, is_bot: false, first_name: "Kesava" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: hydrationGetFile,
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replyPayload(replySpy);
      expect(payload.ReplyChain).toHaveLength(1);
      expect(payload.ReplyChain?.[0]?.messageId).toBe("9000");
      // The quoted photo was already downloaded when message 9000 was ingested;
      // hydrating the reply chain must reuse that local file, not re-fetch it.
      expect(payload.ReplyChain?.[0]?.mediaPath).toBe(savedPath);
      expect(payload.ReplyChain?.[0]?.mediaPath).toContain("/media/inbound/");
      expect(payload.ReplyChain?.[0]?.mediaRef).toBeUndefined();
      expect(getFileSpy).toHaveBeenCalledTimes(1);
      expect(hydrationGetFile).not.toHaveBeenCalled();
      expect(readRemoteMediaBufferSpy).toHaveBeenCalledTimes(1);
      expect(undiciFetchSpy).toHaveBeenCalledTimes(1);
    },
    REPLY_QUOTE_CACHE_TEST_TIMEOUT_MS,
  );

  it(
    "enforces a smaller caller limit instead of serving the cached file",
    async () => {
      // The harness media runtime is mocked, so mirror the real download boundary:
      // it rejects the bytes when the caller's maxBytes is smaller than the file.
      readRemoteMediaBufferSpy.mockImplementation(
        async (params: { maxBytes?: number; filePathHint?: string }) => {
          if (typeof params.maxBytes === "number" && PNG_BYTES.byteLength > params.maxBytes) {
            throw new Error(`Media exceeds ${params.maxBytes} byte limit`);
          }
          return {
            buffer: PNG_BYTES,
            contentType: "image/png",
            fileName: params.filePathHint,
          };
        },
      );
      const largeMaxBytes = 1024;
      const smallMaxBytes = PNG_BYTES.byteLength - 1;

      // Control: an uncached file under the small limit is rejected by the
      // download path; the cached call below must fail the same way.
      const controlGetFile = vi.fn(async () => ({ file_path: "photos/limit-control.png" }));
      const controlError = await resolveMedia({
        ctx: makePhotoCtx("limit-control-u1", controlGetFile),
        maxBytes: smallMaxBytes,
        token: "tok",
      }).catch((err: unknown) => err);
      expect(controlError).toBeInstanceOf(Error);
      expect((controlError as Error).message).toContain("exceeds");
      expect(controlGetFile).toHaveBeenCalledTimes(1);
      expect(readRemoteMediaBufferSpy).toHaveBeenCalledTimes(1);

      // A larger per-account limit admits and caches the same file.
      const cachedPath = "/tmp/media/inbound/limit-large.png";
      setNextSavedMediaPath({
        path: cachedPath,
        size: PNG_BYTES.byteLength,
        contentType: "image/png",
      });
      const cachedGetFile = vi.fn(async () => ({ file_path: "photos/limit-cached.png" }));
      const first = await resolveMedia({
        ctx: makePhotoCtx("limit-cached-u1", cachedGetFile),
        maxBytes: largeMaxBytes,
        token: "tok",
      });
      expect(first?.path).toBe(cachedPath);
      expect(cachedGetFile).toHaveBeenCalledTimes(1);
      expect(readRemoteMediaBufferSpy).toHaveBeenCalledTimes(2);

      // The smaller-limit caller must not reuse the cached file: it falls back
      // to getFile + download and is rejected exactly like the uncached control.
      const cachedError = await resolveMedia({
        ctx: makePhotoCtx("limit-cached-u1", cachedGetFile),
        maxBytes: smallMaxBytes,
        token: "tok",
      }).catch((err: unknown) => err);
      expect(cachedError).toBeInstanceOf(Error);
      expect((cachedError as Error).message).toBe((controlError as Error).message);
      expect(cachedGetFile).toHaveBeenCalledTimes(2);
      expect(readRemoteMediaBufferSpy).toHaveBeenCalledTimes(3);

      // The rejected attempt keeps the entry: the original larger-limit caller
      // still hits the cache with no new getFile or HTTP download.
      const third = await resolveMedia({
        ctx: makePhotoCtx("limit-cached-u1", cachedGetFile),
        maxBytes: largeMaxBytes,
        token: "tok",
      });
      expect(third).toEqual(first);
      expect(cachedGetFile).toHaveBeenCalledTimes(2);
      expect(readRemoteMediaBufferSpy).toHaveBeenCalledTimes(3);
    },
    REPLY_QUOTE_CACHE_TEST_TIMEOUT_MS,
  );

  it(
    "re-downloads after the cache entry expires",
    async () => {
      vi.useFakeTimers();
      try {
        readRemoteMediaBufferSpy.mockImplementation(async (params: { filePathHint?: string }) => ({
          buffer: PNG_BYTES,
          contentType: "image/png",
          fileName: params.filePathHint,
        }));
        const getFile = vi.fn(async () => ({ file_path: "photos/expiry.png" }));
        const firstPath = "/tmp/media/inbound/expiry-first.png";
        setNextSavedMediaPath({
          path: firstPath,
          size: PNG_BYTES.byteLength,
          contentType: "image/png",
        });

        const first = await resolveMedia({
          ctx: makePhotoCtx("expiry-u1", getFile),
          maxBytes: 1024,
          token: "tok",
        });
        expect(first?.path).toBe(firstPath);
        expect(getFile).toHaveBeenCalledTimes(1);
        expect(readRemoteMediaBufferSpy).toHaveBeenCalledTimes(1);

        // Within the 55-minute TTL the second resolve is a pure cache hit.
        const second = await resolveMedia({
          ctx: makePhotoCtx("expiry-u1", getFile),
          maxBytes: 1024,
          token: "tok",
        });
        expect(second).toEqual(first);
        expect(getFile).toHaveBeenCalledTimes(1);
        expect(readRemoteMediaBufferSpy).toHaveBeenCalledTimes(1);

        // Past the TTL the entry is gone, so the same file takes the full
        // getFile + HTTP download path again.
        vi.advanceTimersByTime(56 * 60_000);
        const refreshedPath = "/tmp/media/inbound/expiry-second.png";
        setNextSavedMediaPath({
          path: refreshedPath,
          size: PNG_BYTES.byteLength,
          contentType: "image/png",
        });
        const third = await resolveMedia({
          ctx: makePhotoCtx("expiry-u1", getFile),
          maxBytes: 1024,
          token: "tok",
        });
        expect(third?.path).toBe(refreshedPath);
        expect(third?.path).not.toBe(first?.path);
        expect(getFile).toHaveBeenCalledTimes(2);
        expect(readRemoteMediaBufferSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
    REPLY_QUOTE_CACHE_TEST_TIMEOUT_MS,
  );
});
