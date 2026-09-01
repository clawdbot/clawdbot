// WhatsApp tests cover provider-backed gateway voice delivery, captions, and accepted receipts.
import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSendApi } from "./inbound/send-api.js";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";

const hoisted = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  controllerListeners: new Map<string, ActiveWebListener>(),
  transcodeAudioBufferToOpus: vi.fn(),
}));
const recordChannelActivity = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.fn();
let sendMessageWhatsApp: typeof import("./send.js").sendMessageWhatsApp;
const WHATSAPP_TEST_CFG: OpenClawConfig = { channels: { whatsapp: {} } };

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
  };
});

vi.mock("./connection-controller-runtime-context.js", async () => {
  const actual = await vi.importActual<typeof import("./connection-controller-runtime-context.js")>(
    "./connection-controller-runtime-context.js",
  );
  return {
    ...actual,
    getWhatsAppConnectionController: vi.fn((accountId: string) => {
      const listener = hoisted.controllerListeners.get(accountId) ?? null;
      return listener ? { getActiveListener: () => listener } : null;
    }),
  };
});

vi.mock("openclaw/plugin-sdk/outbound-media", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  );
  return {
    ...actual,
    loadOutboundMediaFromUrl: hoisted.loadOutboundMediaFromUrl,
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    transcodeAudioBufferToOpus: hoisted.transcodeAudioBufferToOpus,
  };
});

describe("WhatsApp gateway voice delivery", () => {
  const sendComposingTo = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => createAcceptedWhatsAppSendResult("text", "msg123"));
  const sendPoll = vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "poll123"));
  const sendReaction = vi.fn(async () =>
    createAcceptedWhatsAppSendResult("reaction", "reaction123"),
  );

  beforeAll(async () => {
    ({ sendMessageWhatsApp } = await import("./send.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.transcodeAudioBufferToOpus.mockReset().mockResolvedValue(Buffer.from("opus-output"));
    hoisted.loadOutboundMediaFromUrl
      .mockReset()
      .mockImplementation(async (mediaUrl: string) => await loadWebMediaMock(mediaUrl));
    hoisted.controllerListeners.clear();
    hoisted.controllerListeners.set("default", {
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
  });

  afterEach(() => {
    recordChannelActivity.mockReset();
    hoisted.controllerListeners.clear();
  });

  it("maps audio to PTT with opus mime when ogg", async () => {
    const buf = Buffer.from("audio");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "audio/ogg",
      kind: "audio",
    });
    await sendMessageWhatsApp("+1555", "voice note", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/voice.ogg",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(1, "+1555", "", buf, "audio/ogg; codecs=opus");
    expect(sendMessage).toHaveBeenNthCalledWith(2, "+1555", "voice note", undefined, undefined);
  });

  it("shares one gateway activity scope across separately accepted producer voice and caption", async () => {
    recordChannelActivity.mockReset();
    recordChannelActivity.mockImplementation(() => {
      if (recordChannelActivity.mock.calls.length > 1) {
        throw new Error("gateway caption producer repeated logical delivery bookkeeping");
      }
    });
    const voice = Buffer.from("gateway-voice");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: voice,
      contentType: "audio/ogg",
      kind: "audio",
    });
    const providerSendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        key: {
          id: "gateway-scoped-voice",
          remoteJid: "1555@s.whatsapp.net",
          fromMe: true,
        },
      } as WAMessage)
      .mockResolvedValueOnce({
        key: {
          id: "gateway-scoped-caption",
          remoteJid: "1555@s.whatsapp.net",
          fromMe: true,
        },
      } as WAMessage);
    const sendApi = createWebSendApi({
      sock: {
        sendMessage: providerSendMessage,
        sendPresenceUpdate: vi.fn(async () => undefined),
      },
      defaultAccountId: "default",
    });
    const listenerSendMessage = vi.fn<ActiveWebListener["sendMessage"]>(
      async (to, text, mediaBuffer, mediaType, options) =>
        await sendApi.sendMessage(to, text, mediaBuffer, mediaType, options),
    );
    hoisted.controllerListeners.set("default", {
      sendComposingTo,
      sendMessage: listenerSendMessage,
      sendPoll,
      sendReaction,
    });
    const onDeliveryResult = vi.fn();

    const result = await sendMessageWhatsApp("+1555", "voice caption", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/gateway-voice.ogg",
      onDeliveryResult,
    });

    expect(result).toEqual({
      messageId: "gateway-scoped-voice",
      toJid: "1555@s.whatsapp.net",
    });
    expect(providerSendMessage).toHaveBeenCalledTimes(2);
    expect(providerSendMessage).toHaveBeenNthCalledWith(1, "1555@s.whatsapp.net", {
      audio: voice,
      ptt: true,
      mimetype: "audio/ogg; codecs=opus",
    });
    expect(providerSendMessage).toHaveBeenNthCalledWith(2, "1555@s.whatsapp.net", {
      text: "voice caption",
    });
    expect(listenerSendMessage).toHaveBeenCalledTimes(2);
    expect(onDeliveryResult).toHaveBeenCalledTimes(2);
    expect(onDeliveryResult).toHaveBeenNthCalledWith(1, {
      messageId: "gateway-scoped-voice",
      toJid: "1555@s.whatsapp.net",
      receipt: expect.objectContaining({
        platformMessageIds: ["gateway-scoped-voice"],
        parts: [
          expect.objectContaining({ platformMessageId: "gateway-scoped-voice", kind: "media" }),
        ],
      }),
    });
    expect(onDeliveryResult).toHaveBeenNthCalledWith(2, {
      messageId: "gateway-scoped-caption",
      toJid: "1555@s.whatsapp.net",
      receipt: expect.objectContaining({
        platformMessageIds: ["gateway-scoped-caption"],
        parts: [
          expect.objectContaining({ platformMessageId: "gateway-scoped-caption", kind: "text" }),
        ],
      }),
    });
    expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "default",
      direction: "outbound",
    });
    recordChannelActivity.mockReset();
  });

  it("normalizes MIME parameters before handing media to the socket transport", async () => {
    const buf = Buffer.from("image");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: " Image/PNG; charset=binary ",
    });

    await sendMessageWhatsApp("+1555", "caption", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/image.png",
    });

    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "caption", buf, "image/png");
  });

  it("reports the accepted voice send before a caption failure", async () => {
    const buf = Buffer.from("audio");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "audio/ogg",
      kind: "audio",
    });
    sendMessage
      .mockResolvedValueOnce(createAcceptedWhatsAppSendResult("media", "voice-accepted"))
      .mockRejectedValueOnce(new Error("caption failed"));
    const onDeliveryResult = vi.fn();

    await expect(
      sendMessageWhatsApp("+1555", "voice note", {
        verbose: false,
        cfg: WHATSAPP_TEST_CFG,
        mediaUrl: "/tmp/voice.ogg",
        onDeliveryResult,
      }),
    ).rejects.toThrow("caption failed");

    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "voice-accepted" }),
    );
  });

  it("retains the accepted voice receipt when its gateway caption has no provider key", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    sendMessage
      .mockResolvedValueOnce(createAcceptedWhatsAppSendResult("media", "gateway-voice-accepted"))
      .mockResolvedValueOnce({
        kind: "text",
        messageId: "unknown",
        keys: [],
        providerAccepted: false,
      });
    const onDeliveryResult = vi.fn();

    const failure = await sendMessageWhatsApp("+1555", "voice note", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/voice.ogg",
      onDeliveryResult,
    }).catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted gateway voice delivery did not preserve its partial receipt");
    }
    expect(failure.deliveryResult.messageIds).toEqual(["gateway-voice-accepted"]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(["gateway-voice-accepted"]);
    expect(failure).toHaveProperty("cause", expect.any(PlatformMessageNotDispatchedError));
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "gateway-voice-accepted" }),
    );
  });

  it("merges accepted gateway voice and nested accepted caption receipts", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/ogg",
      kind: "audio",
    });
    const bookkeepingError = new Error("accepted gateway caption bookkeeping failed");
    const acceptedCaption = createAcceptedWhatsAppSendResult("text", "gateway-caption-accepted");
    sendMessage
      .mockResolvedValueOnce(createAcceptedWhatsAppSendResult("media", "gateway-voice-first"))
      .mockRejectedValueOnce(
        createChannelPartialDeliveryError(bookkeepingError, {
          messageIds: [acceptedCaption.messageId],
          receipt: acceptedCaption.receipt,
          visibleReplySent: true,
        }),
      );

    const failure = await sendMessageWhatsApp("+1555", "voice note", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/voice.ogg",
    }).catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error(
        "gateway discarded its first accepted voice receipt on nested caption failure",
      );
    }
    expect(failure.deliveryResult.messageIds).toEqual([
      "gateway-voice-first",
      "gateway-caption-accepted",
    ]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual([
      "gateway-voice-first",
      "gateway-caption-accepted",
    ]);
    expect(failure).toHaveProperty("cause", bookkeepingError);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "mp3", contentType: "audio/mpeg", fileName: "voice.mp3" },
    { name: "m4a", contentType: "audio/mp4; codecs=mp4a.40.2", fileName: "voice.m4a" },
    { name: "webm", contentType: "audio/webm", fileName: "voice.webm" },
  ])("transcodes $name audio to Ogg Opus before sending a PTT voice note", async (media) => {
    const buf = Buffer.from(media.name);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: media.contentType,
      kind: "audio",
      fileName: media.fileName,
    });

    await sendMessageWhatsApp("+1555", "voice note", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: `/tmp/${media.fileName}`,
    });

    expect(hoisted.transcodeAudioBufferToOpus).toHaveBeenCalledWith({
      audioBuffer: buf,
      inputFileName: media.fileName,
      tempPrefix: "whatsapp-voice-",
      outputFileName: "voice.ogg",
      maxDurationSeconds: MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
      sampleRateHz: 48000,
      channels: 1,
      bitrate: "64k",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "",
      Buffer.from("opus-output"),
      "audio/ogg; codecs=opus",
    );
    expect(sendMessage).toHaveBeenNthCalledWith(2, "+1555", "voice note", undefined, undefined);
  });
});
