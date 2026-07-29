// WhatsApp tests prove filename-derived media facts reach native delivery.
import { describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { loadWebMedia } from "../media.js";
import { deliverWebReply } from "./deliver-reply.js";

const hoisted = vi.hoisted(() => ({
  transcodeAudioBufferToOpus: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return { ...actual, transcodeAudioBufferToOpus: hoisted.transcodeAudioBufferToOpus };
});

vi.mock("../media.js", () => ({ loadWebMedia: vi.fn() }));

describe("WhatsApp filename-only media delivery", () => {
  it.each([
    {
      fileName: "photo.png",
      contentType: undefined,
      payloadKey: "image",
      mimetype: "image/png",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "clip.mp4",
      contentType: undefined,
      payloadKey: "video",
      mimetype: "video/mp4",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "voice.ogg",
      contentType: undefined,
      payloadKey: "audio",
      mimetype: "audio/ogg; codecs=opus",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "voice.mp3",
      contentType: undefined,
      payloadKey: "audio",
      mimetype: "audio/ogg; codecs=opus",
      expectedBuffer: "opus-output",
    },
    {
      fileName: "report.pdf",
      contentType: undefined,
      payloadKey: "document",
      mimetype: "application/pdf",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "unknown.bin",
      contentType: undefined,
      payloadKey: "document",
      mimetype: "application/octet-stream",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "photo.png",
      contentType: "application/octet-stream",
      payloadKey: "image",
      mimetype: "image/png",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "clip.mp4",
      contentType: "application/octet-stream",
      payloadKey: "video",
      mimetype: "video/mp4",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "voice.ogg",
      contentType: "application/octet-stream",
      payloadKey: "audio",
      mimetype: "audio/ogg; codecs=opus",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "voice.mp3",
      contentType: "application/octet-stream",
      payloadKey: "audio",
      mimetype: "audio/ogg; codecs=opus",
      expectedBuffer: "opus-output",
    },
    {
      fileName: "report.pdf",
      contentType: "application/octet-stream",
      payloadKey: "document",
      mimetype: "application/pdf",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "unknown.bin",
      contentType: "application/octet-stream",
      payloadKey: "document",
      mimetype: "application/octet-stream",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "photo.png",
      contentType: "image/jpeg",
      payloadKey: "image",
      mimetype: "image/jpeg",
      expectedBuffer: "filename-only-media",
    },
    {
      fileName: "photo.png",
      contentType: "application/pdf",
      payloadKey: "document",
      mimetype: "application/pdf",
      expectedBuffer: "filename-only-media",
    },
  ] as const)(
    "delivers $fileName with $contentType as native $mimetype",
    async ({ fileName, contentType, payloadKey, mimetype, expectedBuffer }) => {
      vi.clearAllMocks();
      hoisted.transcodeAudioBufferToOpus.mockResolvedValue(Buffer.from("opus-output"));
      vi.mocked(loadWebMedia).mockResolvedValueOnce({
        buffer: Buffer.from("filename-only-media"),
        contentType,
        fileName,
        kind:
          contentType === "application/octet-stream" || contentType === "application/pdf"
            ? "document"
            : contentType === "image/jpeg"
              ? "image"
              : undefined,
      });
      const sendMedia = vi
        .fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>()
        .mockResolvedValue(createAcceptedWhatsAppSendResult("media", "media-1"));
      const reply = vi
        .fn<AdmittedWebInboundMessage["platform"]["reply"]>()
        .mockResolvedValue(createAcceptedWhatsAppSendResult("text", "text-1"));
      const msg = createTestWebInboundMessage({
        event: { id: "msg-1" },
        payload: { body: "hello" },
        platform: {
          chatJid: "15551234567@s.whatsapp.net",
          recipientJid: "+20000000000",
          senderJid: "222@s.whatsapp.net",
          reply,
          sendMedia,
        },
        admission: {
          accountId: "work",
          conversation: { kind: "group", id: "+10000000000" },
          sender: { id: "222@s.whatsapp.net" },
          senderAccess: { reasonCode: "group_policy_allowed" },
        },
      });

      await deliverWebReply({
        replyResult: { text: "caption", mediaUrl: "https://example.com/download" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger: { info: vi.fn(), warn: vi.fn() },
        skipLog: true,
      });

      expect(sendMedia).toHaveBeenCalledOnce();
      const mediaPayload = sendMedia.mock.calls[0]?.[0];
      expect(mediaPayload).toMatchObject({
        [payloadKey]: Buffer.from(expectedBuffer),
        mimetype,
      });
      if (payloadKey === "audio") {
        expect(mediaPayload).toHaveProperty("ptt", true);
        expect(reply).toHaveBeenCalledWith("caption", undefined);
      } else {
        expect(mediaPayload).toHaveProperty("caption", "caption");
      }
      if (payloadKey === "document") {
        expect(mediaPayload).toHaveProperty("fileName", fileName);
      } else {
        expect(mediaPayload).not.toHaveProperty("document");
      }
    },
  );
});
