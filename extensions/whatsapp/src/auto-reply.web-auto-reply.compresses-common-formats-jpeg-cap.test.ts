// Whatsapp tests cover auto reply.web auto reply.compresses common formats jpeg cap plugin behavior.
import fs from "node:fs/promises";
import { createNoisyPngBuffer, createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMockWebListener,
  createWebInboundDeliverySpies,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import type { WebInboundCallbackMessage, WebInboundMessageInput } from "./inbound.js";
import { createTestWebInboundMessage } from "./inbound/test-message.test-helper.js";

installWebAutoReplyTestHomeHooks();

let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks({ pinDns: true });
  type ListenerFactory = NonNullable<Parameters<typeof monitorWebChannel>[1]>;
  type WebInboundPlatform = WebInboundCallbackMessage["platform"];
  type ReplyMock = ReturnType<typeof vi.fn<WebInboundPlatform["reply"]>>;
  type SendMediaMock = ReturnType<typeof vi.fn<WebInboundPlatform["sendMedia"]>>;
  type SendComposingMock = ReturnType<typeof vi.fn<WebInboundPlatform["sendComposing"]>>;
  const SMALL_MEDIA_CAP_MB = 0.1;
  const SMALL_MEDIA_CAP_BYTES = Math.floor(SMALL_MEDIA_CAP_MB * 1024 * 1024);

  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  async function setupSingleInboundMessage(params: {
    resolverValue: { text: string; mediaUrl: string };
    sendMedia?: SendMediaMock;
    reply?: ReplyMock;
  }) {
    const spies = createWebInboundDeliverySpies() as {
      sendMedia: SendMediaMock;
      reply: ReplyMock;
      sendComposing: SendComposingMock;
    };
    const reply = params.reply ?? spies.reply;
    const sendMedia = params.sendMedia ?? spies.sendMedia;
    const resolver = vi.fn().mockResolvedValue(params.resolverValue);

    let capturedOnMessage: ((msg: WebInboundMessageInput) => Promise<void>) | undefined;
    const listenerFactory: ListenerFactory = async ({ onMessage }) => {
      capturedOnMessage = onMessage;
      return createMockWebListener();
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    if (!capturedOnMessage) {
      throw new Error("expected WhatsApp web message handler");
    }
    const onMessage = capturedOnMessage;

    return {
      reply,
      sendMedia,
      dispatch: async (
        id = "msg1",
        overrides?: Partial<{
          from: string;
          conversationId: string;
          accountId: string;
          recipientJid: string;
          chatJid: string;
        }>,
      ) => {
        const from = overrides?.from ?? "+1";
        const conversationId = overrides?.conversationId ?? from;
        const chatJid = overrides?.chatJid ?? from;
        await onMessage(
          createTestWebInboundMessage({
            event: {
              id,
            },
            payload: {
              body: "hello",
            },
            platform: {
              chatJid,
              recipientJid: overrides?.recipientJid ?? "+2",
              sendComposing: spies.sendComposing,
              reply,
              sendMedia,
            },
            admission: {
              accountId: overrides?.accountId ?? "default",
              conversation: {
                kind: "direct",
                id: conversationId,
              },
              sender: {
                id: from,
              },
            },
          }),
        );
      },
    };
  }

  function getSingleImagePayload(sendMedia: ReturnType<typeof vi.fn>) {
    expect(sendMedia).toHaveBeenCalledTimes(1);
    return imagePayloadAt(sendMedia, 0);
  }

  function imagePayloadAt(sendMedia: ReturnType<typeof vi.fn>, callIndex: number) {
    const call = sendMedia.mock.calls.at(callIndex);
    if (!call) {
      throw new Error(`Expected sendMedia call ${callIndex}`);
    }
    return call[0] as {
      image: Buffer;
      caption?: string;
      mimetype?: string;
    };
  }

  function replyText(reply: ReturnType<typeof vi.fn>): string {
    const call = reply.mock.calls.at(0);
    if (!call || typeof call[0] !== "string") {
      throw new Error("Expected text reply call");
    }
    return call[0];
  }

  async function withMediaCap<T>(mediaMaxMb: number, run: () => Promise<T>): Promise<T> {
    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          mediaMaxMb,
        },
      },
    }));
    try {
      return await run();
    } finally {
      resetLoadConfigMock();
    }
  }

  function fetchResponse(body: Buffer | null, mime: string, status = 200): Response {
    return {
      ok: status < 400,
      body: body ? true : null,
      arrayBuffer: async () =>
        body
          ? body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
          : new ArrayBuffer(0),
      headers: new Headers({ "content-type": mime }),
      status,
    } as unknown as Response;
  }

  function mockFetchMediaBuffer(buffer: Buffer, mime: string) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(fetchResponse(buffer, mime));
  }

  async function expectCompressedImageWithinCap(params: {
    mediaUrl: string;
    mime: string;
    image: Buffer;
    messageId: string;
    mediaMaxMb?: number;
  }) {
    await withMediaCap(params.mediaMaxMb ?? 1, async () => {
      const { reply, dispatch, sendMedia } = await setupSingleInboundMessage({
        resolverValue: { text: "hi", mediaUrl: params.mediaUrl },
      });
      const fetchMock = mockFetchMediaBuffer(params.image, params.mime);

      await dispatch(params.messageId);

      const payload = getSingleImagePayload(sendMedia);
      expect(payload.image.length).toBeLessThanOrEqual((params.mediaMaxMb ?? 1) * 1024 * 1024);
      expect(payload.mimetype).toBe("image/jpeg");
      expect(reply).not.toHaveBeenCalled();
      fetchMock.mockRestore();
    });
  }

  it("sends common in-limit image formats without re-encoding", async () => {
    const jpeg = await fs.readFile("docs/assets/showcase/roof-camera-sky.jpg");
    const webp = await fs.readFile("extensions/whatsapp/src/__fixtures__/large-noisy.webp");
    const formats = [
      {
        name: "png",
        mime: "image/png",
        image: createSolidPngBuffer(64, 64, { r: 80, g: 120, b: 200 }),
      },
      {
        name: "jpeg",
        mime: "image/jpeg",
        image: jpeg,
      },
      {
        name: "webp",
        mime: "image/webp",
        image: webp,
      },
    ] as const;

    await withMediaCap(1, async () => {
      const { reply, dispatch, sendMedia } = await setupSingleInboundMessage({
        resolverValue: {
          text: "hi",
          mediaUrl: "https://example.com/big.image",
        },
      });
      let fetchIndex = 0;

      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const matched = formats[Math.min(fetchIndex, formats.length - 1)] ?? formats[0];
        fetchIndex += 1;
        const { image, mime } = matched;
        return fetchResponse(image, mime);
      });

      try {
        for (const [index, fmt] of formats.entries()) {
          const beforeCalls = sendMedia.mock.calls.length;
          await dispatch(`msg-${fmt.name}-${index}`, {
            from: `+1${index}`,
            conversationId: `conv-${index}`,
            chatJid: `conv-${index}`,
          });
          expect(sendMedia).toHaveBeenCalledTimes(beforeCalls + 1);
          const payload = imagePayloadAt(sendMedia, beforeCalls);
          expect(payload.image.length).toBeGreaterThan(0);
          expect(payload.image.length).toBeLessThanOrEqual(1024 * 1024);
          expect(payload.mimetype).toBe(fmt.mime);
        }
        expect(sendMedia).toHaveBeenCalledTimes(formats.length);
        expect(reply).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });
  });

  it("honors channels.whatsapp.mediaMaxMb for outbound auto-replies", async () => {
    const bigPng = createNoisyPngBuffer(256, 256);
    expect(bigPng.length).toBeGreaterThan(SMALL_MEDIA_CAP_BYTES);
    await expectCompressedImageWithinCap({
      mediaUrl: "https://example.com/big.png",
      mime: "image/png",
      image: bigPng,
      messageId: "msg1",
      mediaMaxMb: SMALL_MEDIA_CAP_MB,
    });
  });

  it("prefers per-account WhatsApp media caps for outbound auto-replies", async () => {
    const bigPng = createNoisyPngBuffer(256, 256);
    expect(bigPng.length).toBeGreaterThan(SMALL_MEDIA_CAP_BYTES);

    setLoadConfigMock(() => ({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          mediaMaxMb: 1,
          accounts: {
            work: {
              mediaMaxMb: SMALL_MEDIA_CAP_MB,
            },
          },
        },
      },
    }));

    try {
      const { reply, dispatch, sendMedia } = await setupSingleInboundMessage({
        resolverValue: { text: "hi", mediaUrl: "https://example.com/account-big.png" },
      });
      const fetchMock = mockFetchMediaBuffer(bigPng, "image/png");

      await dispatch("msg-account-cap", { accountId: "work" });

      const payload = getSingleImagePayload(sendMedia);
      expect(payload.image.length).toBeLessThanOrEqual(SMALL_MEDIA_CAP_BYTES);
      expect(payload.mimetype).toBe("image/jpeg");
      expect(reply).not.toHaveBeenCalled();
      fetchMock.mockRestore();
    } finally {
      resetLoadConfigMock();
    }
  });
  it("sends PDF media as a document", async () => {
    const { reply, dispatch, sendMedia } = await setupSingleInboundMessage({
      resolverValue: { text: "hi", mediaUrl: "https://example.com/file.pdf" },
    });

    const fetchMock = mockFetchMediaBuffer(Buffer.from("%PDF-1.4"), "application/pdf");

    await dispatch("msg-pdf");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const payload = imagePayloadAt(sendMedia, 0) as {
      document?: Buffer;
      caption?: string;
      fileName?: string;
    };
    expect(payload.document).toBeInstanceOf(Buffer);
    expect(payload.fileName).toBe("file.pdf");
    expect(payload.caption).toBe("hi");
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("falls back to text when media send fails", async () => {
    const sendMedia = vi.fn<WebInboundPlatform["sendMedia"]>().mockRejectedValue(new Error("boom"));
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "hi",
        mediaUrl: "https://example.com/img.png",
      },
      sendMedia,
    });

    const smallPng = createSolidPngBuffer(64, 64, { r: 0, g: 255, b: 0 });
    const fetchMock = mockFetchMediaBuffer(smallPng, "image/png");

    await dispatch("msg1");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const fallback = replyText(reply);
    expect(fallback).toContain("hi");
    expect(fallback).toContain("Media failed");
    fetchMock.mockRestore();
  });
  it("returns a warning when remote media fetch 404s", async () => {
    const { reply, dispatch, sendMedia } = await setupSingleInboundMessage({
      resolverValue: {
        text: "caption",
        mediaUrl: "https://example.com/missing.jpg",
      },
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fetchResponse(null, "text/plain", 404));

    await dispatch("msg1");

    expect(sendMedia).not.toHaveBeenCalled();
    const fallback = replyText(reply);
    expect(fallback).toContain("caption");
    expect(fallback).toContain("Media failed");
    expect(fallback).not.toContain("404");

    fetchMock.mockRestore();
  });
  it("sends media with a caption when delivery succeeds", async () => {
    const { reply, dispatch, sendMedia } = await setupSingleInboundMessage({
      resolverValue: {
        text: "hi",
        mediaUrl: "https://example.com/img.png",
      },
    });

    const png = createSolidPngBuffer(64, 64, { r: 0, g: 0, b: 255 });

    const fetchMock = mockFetchMediaBuffer(png, "image/png");

    await dispatch("msg1");

    const payload = getSingleImagePayload(sendMedia);
    expect(payload.caption).toBe("hi");
    expect(payload.image.length).toBeGreaterThan(0);
    // Should not fall back to separate text reply because caption is used.
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });
});
