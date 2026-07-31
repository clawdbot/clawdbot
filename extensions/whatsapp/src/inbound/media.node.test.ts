// Whatsapp tests cover media plugin behavior.
import { Readable } from "node:stream";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNormalizeMessageContent } from "../../../../test/mocks/baileys.js";

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];

const { normalizeMessageContent, downloadMediaMessage, saveMediaStream } = vi.hoisted(() => ({
  normalizeMessageContent: vi.fn((msg: MockMessageInput) => mockNormalizeMessageContent(msg)),
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("fake-media-data")),
  saveMediaStream: vi.fn(),
}));

vi.mock("baileys", async () => {
  return {
    DisconnectReason: { loggedOut: 401 },
    normalizeMessageContent,
    downloadMediaMessage,
  };
});

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaStream,
}));

let downloadInboundMedia: typeof import("./media.js").downloadInboundMedia;

const WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS = 30_000;

const mockSock = {
  updateMediaMessage: vi.fn(),
  logger: { child: () => ({}) },
};

async function expectMimetype(message: Record<string, unknown>, expected: string) {
  const result = await downloadInboundMedia({ message } as never, mockSock as never);
  expect(result).toEqual({
    saved: {
      id: "saved-media",
      path: "/tmp/saved-media",
      size: Buffer.byteLength("fake-media-data"),
      contentType: expected,
    },
    mimetype: expected,
    fileName: undefined,
  });
}

describe("downloadInboundMedia", () => {
  beforeAll(async () => {
    ({ downloadInboundMedia } = await import("./media.js"));
  });

  beforeEach(() => {
    normalizeMessageContent.mockClear();
    downloadMediaMessage.mockClear();
    downloadMediaMessage.mockImplementation(() => Readable.from([Buffer.from("fake-media-data")]));
    saveMediaStream.mockClear();
    saveMediaStream.mockImplementation(
      async (
        stream: AsyncIterable<Buffer>,
        contentType: string | undefined,
        _subdir: string,
        maxBytes: number,
      ) => {
        let total = 0;
        for await (const chunk of stream) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            throw new Error("Media exceeds limit");
          }
        }
        return { id: "saved-media", path: "/tmp/saved-media", size: total, contentType };
      },
    );
    mockSock.updateMediaMessage.mockClear();
  });

  it("returns undefined for messages without media", async () => {
    const msg = { message: { conversation: "hello" } } as never;
    const result = await downloadInboundMedia(msg, mockSock as never);
    expect(result).toBeUndefined();
  });

  it("uses explicit mimetype from audioMessage when present", async () => {
    await expectMimetype({ audioMessage: { mimetype: "audio/mp4", ptt: true } }, "audio/mp4");
  });

  it.each([
    { name: "voice messages without explicit MIME", audioMessage: { ptt: true } },
    { name: "audio messages without MIME or ptt flag", audioMessage: {} },
  ])("defaults to audio/ogg for $name", async ({ audioMessage }) => {
    await expectMimetype({ audioMessage }, "audio/ogg; codecs=opus");
  });

  it("uses explicit mimetype from imageMessage when present", async () => {
    await expectMimetype({ imageMessage: { mimetype: "image/png" } }, "image/png");
  });

  it.each([
    { name: "image", message: { imageMessage: {} }, mimetype: "image/jpeg" },
    { name: "video", message: { videoMessage: {} }, mimetype: "video/mp4" },
    { name: "sticker", message: { stickerMessage: {} }, mimetype: "image/webp" },
  ])("defaults MIME for $name messages without explicit MIME", async ({ message, mimetype }) => {
    await expectMimetype(message, mimetype);
  });

  it("preserves fileName from document messages", async () => {
    const msg = {
      message: {
        documentMessage: { mimetype: "application/pdf", fileName: "report.pdf" },
      },
    } as never;
    const result = await downloadInboundMedia(msg, mockSock as never);
    expect(result).toEqual({
      saved: {
        id: "saved-media",
        path: "/tmp/saved-media",
        size: Buffer.byteLength("fake-media-data"),
        contentType: "application/pdf",
      },
      mimetype: "application/pdf",
      fileName: "report.pdf",
    });
  });

  it("downloads in stream mode and rejects over the configured cap", async () => {
    downloadMediaMessage.mockImplementationOnce(() =>
      Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
    );

    await expect(
      downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
        7,
      ),
    ).rejects.toThrow(/Media exceeds/i);
    expect(downloadMediaMessage.mock.calls[0]?.[1]).toBe("stream");
  });

  it("propagates transport download failures to the message owner", async () => {
    downloadMediaMessage.mockRejectedValueOnce(new Error("expired media reference"));

    await expect(
      downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
      ),
    ).rejects.toThrow("expired media reference");
  });

  describe("chunk-idle timeout", () => {
    function neverYieldingStream(): AsyncIterable<Buffer> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Buffer>> {
              return new Promise<IteratorResult<Buffer>>(() => {});
            },
          };
        },
      };
    }

    it("negative control: never-yielding stream without idle wrap stays pending", async () => {
      // Pre-fix shape: saveMediaStream's unbounded `for await` on a stalled
      // Baileys stream never settles. Prove the hang before asserting the wrap.
      const consume = (async () => {
        // Hang on the first stalled `next()` — same unbounded wait as bare `for await`.
        await neverYieldingStream()[Symbol.asyncIterator]().next();
      })();
      const outcome = await Promise.race([
        consume.then(() => "resolved" as const),
        new Promise<"still-pending">((resolve) => {
          setTimeout(() => resolve("still-pending"), 150);
        }),
      ]);
      expect(outcome).toBe("still-pending");
      console.log(
        `[whatsapp media idle negative control] outcome=${outcome} wait_ms=150 without_idle_wrap=true`,
      );
    });

    function delayedStream(payload: Buffer, delayMs: number): AsyncIterable<Buffer> {
      let yielded = false;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Buffer>> {
              if (yielded) {
                return { value: undefined as unknown as Buffer, done: true };
              }
              await new Promise<void>((resolve) => {
                setTimeout(resolve, delayMs);
              });
              yielded = true;
              return { value: payload, done: false };
            },
          };
        },
      };
    }

    it("rejects when the Baileys stream stalls past chunkTimeoutMs", async () => {
      downloadMediaMessage.mockResolvedValueOnce(neverYieldingStream());
      const startedAt = Date.now();
      const promise = downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
        1024 * 1024,
        { chunkTimeoutMs: 50 },
      );
      await expect(promise).rejects.toMatchObject({
        name: "WhatsAppInboundMediaTimeoutError",
        chunkTimeoutMs: 50,
      });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(1_000);
      console.log(
        `[whatsapp media idle proof] timed_out=true elapsed_ms=${elapsedMs} chunkTimeoutMs=50 production_ms=${WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS}`,
      );
    });

    it("does not reject when chunks arrive within chunkTimeoutMs", async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
      downloadMediaMessage.mockResolvedValueOnce(delayedStream(jpeg, 10));
      const result = await downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
        1024 * 1024,
        { chunkTimeoutMs: 500 },
      );
      expect(result?.mimetype).toBe("image/jpeg");
      expect(result?.saved.size).toBe(jpeg.byteLength);
    });

    it("defaults to a 30s production idle floor when chunkTimeoutMs is omitted", async () => {
      vi.useFakeTimers();
      try {
        downloadMediaMessage.mockResolvedValueOnce(neverYieldingStream());
        const promise = downloadInboundMedia(
          { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
          mockSock as never,
          1024 * 1024,
        );
        const expectation = expect(promise).rejects.toMatchObject({
          name: "WhatsAppInboundMediaTimeoutError",
          chunkTimeoutMs: WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS,
        });
        await vi.advanceTimersByTimeAsync(WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS - 1);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        await expectation;
        console.log(
          `[whatsapp media idle proof] production_default_ms=${WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS} timed_out=true`,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("calls iterator.return() exactly once on timeout so the upstream Readable is destroyed", async () => {
      const returnSpy = vi.fn(async () => ({ value: undefined as unknown as Buffer, done: true }));
      const stream: AsyncIterable<Buffer> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Buffer>> {
              return new Promise<IteratorResult<Buffer>>(() => {});
            },
            return: returnSpy as () => Promise<IteratorResult<Buffer>>,
          };
        },
      };
      downloadMediaMessage.mockResolvedValueOnce(stream);
      await expect(
        downloadInboundMedia(
          { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
          mockSock as never,
          1024 * 1024,
          { chunkTimeoutMs: 50 },
        ),
      ).rejects.toMatchObject({ name: "WhatsAppInboundMediaTimeoutError" });
      expect(returnSpy).toHaveBeenCalledTimes(1);
    });

    it("calls source.destroy() on timeout so the underlying Readable resource closes", async () => {
      const destroySpy = vi.fn();
      const stream: AsyncIterable<Buffer> & { destroy: (err?: Error) => void } = {
        destroy: destroySpy,
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Buffer>> {
              return new Promise<IteratorResult<Buffer>>(() => {});
            },
          };
        },
      };
      downloadMediaMessage.mockResolvedValueOnce(stream);
      await expect(
        downloadInboundMedia(
          { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
          mockSock as never,
          1024 * 1024,
          { chunkTimeoutMs: 50 },
        ),
      ).rejects.toMatchObject({ name: "WhatsAppInboundMediaTimeoutError" });
      expect(destroySpy).toHaveBeenCalledTimes(1);
      const destroyArg = destroySpy.mock.calls[0]?.[0] as Error | undefined;
      expect(destroyArg).toBeDefined();
      expect(destroyArg?.message).toContain("stalled");
    });
  });
});
