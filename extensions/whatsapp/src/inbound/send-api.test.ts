import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
// Whatsapp tests cover send api plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareWhatsAppOutboundMedia } from "../outbound-media-contract.js";
import { resolveWhatsAppOutboundMentions } from "./outbound-mentions.js";
import { createWebSendApi } from "./send-api.js";
import { normalizeWhatsAppSendResult, type WhatsAppSendResult } from "./send-result.js";

const recordChannelActivity = vi.hoisted(() => vi.fn());
const imageOps = vi.hoisted(() => ({
  getImageMetadata: vi.fn(),
  resizeToJpeg: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    getImageMetadata: imageOps.getImageMetadata,
    resizeToJpeg: imageOps.resizeToJpeg,
  };
});

const requireRecord = createRequireRecord("object", "label-not-object");

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

function requireMockArg(mock: MockCallSource, callIndex: number, argIndex: number, label: string) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`missing ${label} call ${callIndex + 1}`);
  }
  return call[argIndex];
}

describe("createWebSendApi", () => {
  const sendMessage = vi.fn(
    async (
      _jid: string,
      _content: AnyMessageContent,
      _options?: MiscMessageGenerationOptions,
    ): Promise<WAMessage | undefined> => ({ key: { id: "msg-1" } }) as WAMessage,
  );
  const sendPresenceUpdate = vi.fn(async () => {});
  let api: ReturnType<typeof createWebSendApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    imageOps.getImageMetadata.mockResolvedValue(null);
    imageOps.resizeToJpeg.mockRejectedValue(new Error("unexpected thumbnail generation"));
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
    });
  });

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  function requireSendContent(callIndex = 0): Record<string, unknown> {
    return requireRecord(
      requireMockArg(sendMessage, callIndex, 1, "sent message"),
      "sent message content",
    );
  }

  function requireSendOptions(callIndex = 0): Record<string, unknown> {
    return requireRecord(
      requireMockArg(sendMessage, callIndex, 2, "sent message"),
      "sent message options",
    );
  }

  function expectFirstSendJid(jid: string) {
    expect(requireMockArg(sendMessage, 0, 0, "sent message")).toBe(jid);
  }

  function expectSendContentFields(callIndex: number, fields: Record<string, unknown>) {
    expectRecordFields(requireSendContent(callIndex), fields);
  }

  function expectSendResultFields(result: WhatsAppSendResult, fields: Record<string, unknown>) {
    expectRecordFields(requireRecord(result, "send result"), fields);
  }

  function expectOutboundActivityOnce(accountId = "main") {
    expect(recordChannelActivity).toHaveBeenCalledOnce();
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId,
      direction: "outbound",
    });
  }

  it("uses sendOptions fileName for outbound documents", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf", { fileName: "invoice.pdf" });
    expectFirstSendJid("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      document: payload,
      fileName: "invoice.pdf",
      caption: "doc",
      mimetype: "application/pdf",
    });
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("falls back to a MIME-aware document filename when fileName is absent", async () => {
    const payload = Buffer.from("pdf");
    await api.sendMessage("+1555", "doc", payload, "application/pdf");
    expectFirstSendJid("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      document: payload,
      fileName: "file.pdf",
      caption: "doc",
      mimetype: "application/pdf",
    });
  });

  it("uses MIME mappings for text document filename fallbacks", async () => {
    const payload = Buffer.from("a,b\n1,2\n");
    await api.sendMessage("+1555", "doc", payload, "text/csv");

    expectSendContentFields(0, {
      document: payload,
      fileName: "file.csv",
      caption: "doc",
      mimetype: "text/csv",
    });
  });

  it("keeps the plain default document filename when MIME has no extension mapping", async () => {
    const payload = Buffer.from("unknown");
    await api.sendMessage("+1555", "doc", payload, "application/x-custom");

    expectSendContentFields(0, {
      document: payload,
      fileName: "file",
      caption: "doc",
      mimetype: "application/x-custom",
    });
  });

  it("sends visual media as document when sendOptions.asDocument is true", async () => {
    const payload = Buffer.from("img");
    await api.sendMessage("+1555", "promo", payload, "image/png", {
      asDocument: true,
      fileName: "promo.png",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "promo.png",
        caption: "promo",
        mimetype: "image/png",
      }),
    );
  });

  it("uses MIME-aware filename fallback for forced visual documents", async () => {
    const payload = Buffer.from("img");
    await api.sendMessage("+1555", "promo", payload, "image/png", {
      asDocument: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      expect.objectContaining({
        document: payload,
        fileName: "file.png",
        caption: "promo",
        mimetype: "image/png",
      }),
    );
  });

  it("does not force audio media onto the document branch", async () => {
    const payload = Buffer.from("aud");
    await api.sendMessage("+1555", "voice", payload, "audio/ogg", {
      asDocument: true,
      fileName: "voice.ogg",
    });

    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      audio: payload,
      ptt: true,
      mimetype: "audio/ogg",
    });
  });

  it("sends plain text messages", async () => {
    const res = await api.sendMessage("+1555", "hello");
    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", { text: "hello" });
    expectSendResultFields(res, {
      kind: "text",
      messageId: "msg-1",
      providerAccepted: true,
    });
    expect(res.receipt ? listMessageReceiptPlatformIds(res.receipt) : []).toEqual(["msg-1"]);
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("sends structured contact messages through the canonical send path", async () => {
    const res = await api.sendContact("+1555", {
      displayName: "QA Contact",
      vcard: "BEGIN:VCARD\nFN:QA Contact\nEND:VCARD",
    });

    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      contacts: {
        displayName: "QA Contact",
        contacts: [
          {
            displayName: "QA Contact",
            vcard: "BEGIN:VCARD\nFN:QA Contact\nEND:VCARD",
          },
        ],
      },
    });
    expectSendResultFields(res, {
      kind: "contact",
      messageId: "msg-1",
      providerAccepted: true,
    });
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("sends structured location messages through the canonical send path", async () => {
    const res = await api.sendLocation("+1555", {
      degreesLatitude: 37.7749,
      degreesLongitude: -122.4194,
      name: "QA Location",
    });

    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      location: {
        address: undefined,
        degreesLatitude: 37.7749,
        degreesLongitude: -122.4194,
        name: "QA Location",
      },
    });
    expectSendResultFields(res, {
      kind: "location",
      messageId: "msg-1",
      providerAccepted: true,
    });
  });

  it("sends structured sticker messages through the canonical send path", async () => {
    const payload = Buffer.from("webp");
    const res = await api.sendSticker("+1555", payload);

    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      sticker: payload,
      mimetype: "image/webp",
    });
    expectSendResultFields(res, {
      kind: "sticker",
      messageId: "msg-1",
      providerAccepted: true,
    });
  });

  it("adds native mention metadata to group text sends", async () => {
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      resolveOutboundMentions: ({ jid, text }) =>
        resolveWhatsAppOutboundMentions({
          chatJid: jid,
          text,
          participants: [
            {
              id: "277038292303944:4@lid",
              phoneNumber: "5511976136970@s.whatsapp.net",
            },
          ],
        }),
    });

    await api.sendMessage("120363000000000000@g.us", "ping @+5511976136970");

    expect(sendMessage).toHaveBeenCalledWith("120363000000000000@g.us", {
      text: "ping @277038292303944",
      mentions: ["277038292303944@lid"],
    });
  });

  it("supports image media with caption", async () => {
    const payload = Buffer.from("img");
    await api.sendMessage("+1555", "cap", payload, "image/jpeg");
    expectFirstSendJid("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      image: payload,
      caption: "cap",
      mimetype: "image/jpeg",
    });
  });

  it.each([
    { kind: "image", contentType: " Image/PNG; charset=binary ", mimetype: "image/png" },
    { kind: "video", contentType: " Video/MP4; charset=binary ", mimetype: "video/mp4" },
  ])(
    "preserves the native $kind payload after canonicalizing mixed-case media MIME",
    async ({ kind, contentType, mimetype }) => {
      const payload = Buffer.from(kind);
      const media = await prepareWhatsAppOutboundMedia({ buffer: payload, contentType });

      await api.sendMessage("+1555", "cap", media.buffer, media.mimetype);

      expectSendContentFields(0, {
        [kind]: payload,
        caption: "cap",
        mimetype,
      });
    },
  );

  it("prepopulates image thumbnails and dimensions before Baileys media upload", async () => {
    const payload = Buffer.from("img");
    const thumbnail = Buffer.from("thumb");
    imageOps.getImageMetadata.mockResolvedValueOnce({ width: 640, height: 480 });
    imageOps.resizeToJpeg.mockResolvedValueOnce(thumbnail);

    await api.sendMessage("+1555", "cap", payload, "image/png");

    expect(imageOps.resizeToJpeg).toHaveBeenCalledWith({
      buffer: payload,
      maxSide: 32,
      quality: 50,
      withoutEnlargement: true,
    });
    expectSendContentFields(0, {
      image: payload,
      caption: "cap",
      mimetype: "image/png",
      jpegThumbnail: thumbnail.toString("base64"),
      width: 640,
      height: 480,
    });
  });

  it("adds native mention metadata to group media captions", async () => {
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      resolveOutboundMentions: ({ jid, text }) =>
        resolveWhatsAppOutboundMentions({
          chatJid: jid,
          text,
          participants: [{ id: "15551234567@s.whatsapp.net" }],
        }),
    });
    const payload = Buffer.from("img");

    await api.sendMessage("120363000000000000@g.us", "cap @15551234567", payload, "image/jpeg");

    expectFirstSendJid("120363000000000000@g.us");
    expectSendContentFields(0, {
      image: payload,
      caption: "cap @15551234567",
      mimetype: "image/jpeg",
      mentions: ["15551234567@s.whatsapp.net"],
    });
  });

  it("uses resolved mention caption text for forced-document media", async () => {
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      resolveOutboundMentions: ({ jid, text }) =>
        resolveWhatsAppOutboundMentions({
          chatJid: jid,
          text,
          participants: [
            {
              id: "277038292303944:4@lid",
              phoneNumber: "5511976136970@s.whatsapp.net",
            },
          ],
        }),
    });
    const payload = Buffer.from("img");

    await api.sendMessage("120363000000000000@g.us", "cap @+5511976136970", payload, "image/jpeg", {
      asDocument: true,
      fileName: "promo.jpg",
    });

    expectFirstSendJid("120363000000000000@g.us");
    expectSendContentFields(0, {
      document: payload,
      fileName: "promo.jpg",
      caption: "cap @277038292303944",
      mimetype: "image/jpeg",
      mentions: ["277038292303944@lid"],
    });
  });

  it("supports audio as push-to-talk voice note", async () => {
    const payload = Buffer.from("aud");
    await api.sendMessage("+1555", "", payload, "audio/ogg", { accountId: "alt" });
    expectFirstSendJid("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      audio: payload,
      ptt: true,
      mimetype: "audio/ogg",
    });
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "alt",
      direction: "outbound",
    });
  });

  it("sends visible text separately from push-to-talk voice notes", async () => {
    const payload = Buffer.from("aud");
    sendMessage
      .mockResolvedValueOnce({ key: { id: "voice-1" } })
      .mockResolvedValueOnce({ key: { id: "voice-text-1" } });
    const res = await api.sendMessage("+1555", "voice text", payload, "audio/ogg");
    expectFirstSendJid("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      audio: payload,
      ptt: true,
      mimetype: "audio/ogg",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, "1555@s.whatsapp.net", {
      text: "voice text",
    });
    expectSendResultFields(res, {
      kind: "media",
      messageId: "voice-1",
      providerAccepted: true,
    });
    expect(res.receipt ? listMessageReceiptPlatformIds(res.receipt) : []).toEqual([
      "voice-1",
      "voice-text-1",
    ]);
    expectOutboundActivityOnce();
  });

  it("preserves the accepted voice receipt when its visible caption send disconnects", async () => {
    const captionError = new Error("connection closed while sending the voice caption");
    sendMessage
      .mockResolvedValueOnce({ key: { id: "voice-accepted-1" } })
      .mockRejectedValueOnce(captionError);

    const failure = await api
      .sendMessage("+1555", "voice text", Buffer.from("voice"), "audio/ogg")
      .catch((caught: unknown) => caught);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted voice delivery did not preserve its partial receipt");
    }
    expect(failure.deliveryResult.visibleReplySent).toBe(true);
    expect(failure.deliveryResult.messageIds).toEqual(["voice-accepted-1"]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(["voice-accepted-1"]);
    expect(failure).toHaveProperty("cause", captionError);
    expectOutboundActivityOnce();
  });

  it("composes accepted voice and caption receipts when the caption throws a nested partial", async () => {
    const bookkeepingError = new Error("accepted voice caption bookkeeping failed");
    const acceptedCaption = normalizeWhatsAppSendResult(
      { key: { id: "nested-voice-caption" } } as WAMessage,
      "text",
    );
    sendMessage.mockResolvedValueOnce({ key: { id: "nested-voice-media" } }).mockRejectedValueOnce(
      createChannelPartialDeliveryError(bookkeepingError, {
        messageIds: [acceptedCaption.messageId],
        receipt: acceptedCaption.receipt,
        visibleReplySent: true,
      }),
    );

    const failure = await api
      .sendMessage("+1555", "voice text", Buffer.from("voice"), "audio/ogg")
      .catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("nested accepted voice-caption receipt replaced its earlier voice receipt");
    }
    expect(failure.deliveryResult.messageIds).toEqual([
      "nested-voice-media",
      "nested-voice-caption",
    ]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual([
      "nested-voice-media",
      "nested-voice-caption",
    ]);
    expect(failure).toHaveProperty("cause", bookkeepingError);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expectOutboundActivityOnce();
  });

  it("preserves the accepted voice receipt when Baileys never accepts its caption", async () => {
    sendMessage
      .mockResolvedValueOnce({ key: { id: "voice-accepted-no-caption" } })
      .mockResolvedValueOnce(undefined);

    const failure = await api
      .sendMessage("+1555", "voice text", Buffer.from("voice"), "audio/ogg")
      .catch((caught: unknown) => caught);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted voice delivery was lost when Baileys rejected its caption");
    }
    expect(failure.deliveryResult.messageIds).toEqual(["voice-accepted-no-caption"]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual([
      "voice-accepted-no-caption",
    ]);
    expect(failure).toHaveProperty("cause", expect.any(PlatformMessageNotDispatchedError));
    expectOutboundActivityOnce();
  });

  it("preserves the accepted voice receipt when caption mention resolution fails", async () => {
    const mentionError = new Error("group metadata lookup disconnected");
    api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      resolveOutboundMentions: vi.fn().mockRejectedValue(mentionError),
    });
    sendMessage.mockResolvedValueOnce({ key: { id: "voice-accepted-2" } });

    const failure = await api
      .sendMessage("+1555", "voice text", Buffer.from("voice"), "audio/ogg")
      .catch((caught: unknown) => caught);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted voice delivery was lost during mention resolution");
    }
    expect(failure.deliveryResult.messageIds).toEqual(["voice-accepted-2"]);
    expect(failure).toHaveProperty("cause", mentionError);
    expectOutboundActivityOnce();
  });

  it.each([
    {
      kind: "text",
      send: (sendApi: ReturnType<typeof createWebSendApi>) => sendApi.sendMessage("+1555", "hello"),
    },
    {
      kind: "poll",
      send: (sendApi: ReturnType<typeof createWebSendApi>) =>
        sendApi.sendPoll("+1555", { question: "Q?", options: ["a", "b"] }),
    },
  ])("retains the accepted $kind receipt when activity recording fails", async ({ kind, send }) => {
    const activityError = new Error("channel activity bookkeeping disconnected");
    sendMessage.mockResolvedValueOnce({ key: { id: `${kind}-accepted` } });
    recordChannelActivity.mockImplementationOnce(() => {
      throw activityError;
    });

    const failure = await send(api).catch((caught: unknown) => caught);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted provider delivery was lost during activity bookkeeping");
    }
    expect(failure.deliveryResult.messageIds).toEqual([`${kind}-accepted`]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual([`${kind}-accepted`]);
    expect(failure).toHaveProperty("cause", activityError);
    expectOutboundActivityOnce();
  });

  it("retains the first accepted voice receipt when immediate activity recording fails", async () => {
    const activityError = new Error("channel activity bookkeeping disconnected");
    sendMessage.mockResolvedValueOnce({ key: { id: "voice-accepted-3" } });
    recordChannelActivity.mockImplementationOnce(() => {
      throw activityError;
    });

    const failure = await api
      .sendMessage("+1555", "voice text", Buffer.from("voice"), "audio/ogg")
      .catch((caught: unknown) => caught);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted voice delivery was lost during immediate activity bookkeeping");
    }
    expect(failure.deliveryResult.messageIds).toEqual(["voice-accepted-3"]);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(["voice-accepted-3"]);
    expect(failure).toHaveProperty("cause", activityError);
    expectOutboundActivityOnce();
  });

  it("supports video media and gifPlayback option", async () => {
    const payload = Buffer.from("vid");
    await api.sendMessage("+1555", "cap", payload, "video/mp4", { gifPlayback: true });
    expectFirstSendJid("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      video: payload,
      caption: "cap",
      mimetype: "video/mp4",
      gifPlayback: true,
    });
  });

  it("rejects Baileys results that do not expose an accepted message key", async () => {
    sendMessage.mockResolvedValueOnce({ key: {} as { id: string } });

    await expect(api.sendMessage("+1555", "hello")).rejects.toBeInstanceOf(
      PlatformMessageNotDispatchedError,
    );
    expect(recordChannelActivity).not.toHaveBeenCalled();
  });

  it("sends polls and records outbound activity", async () => {
    const res = await api.sendPoll("+1555", {
      question: "Q?",
      options: ["a", "b"],
      maxSelections: 2,
    });
    expectFirstSendJid("1555@s.whatsapp.net");
    expect(requireSendContent().poll).toEqual({
      name: "Q?",
      values: ["a", "b"],
      selectableCount: 2,
    });
    expect(res.messageId).toBe("msg-1");
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("sends reactions with participant JID normalization", async () => {
    const res = await api.sendReaction("+1555", "msg-2", "👍", false, "+1999");
    expectFirstSendJid("1555@s.whatsapp.net");
    const react = requireRecord(requireSendContent().react, "reaction content");
    expect(react.text).toBe("👍");
    expectRecordFields(requireRecord(react.key, "reaction key"), {
      remoteJid: "1555@s.whatsapp.net",
      id: "msg-2",
      fromMe: false,
      participant: "1999@s.whatsapp.net",
    });
    expectSendResultFields(res, {
      kind: "reaction",
      messageId: "msg-1",
      providerAccepted: true,
    });
  });

  it.each([
    {
      kind: "text",
      send: (sendApi: ReturnType<typeof createWebSendApi>) => sendApi.sendMessage("+1555", "hello"),
    },
    {
      kind: "image",
      send: (sendApi: ReturnType<typeof createWebSendApi>) =>
        sendApi.sendMessage("+1555", "image", Buffer.from("image"), "image/png"),
    },
    {
      kind: "document",
      send: (sendApi: ReturnType<typeof createWebSendApi>) =>
        sendApi.sendMessage("+1555", "file", Buffer.from("file"), "application/pdf"),
    },
    {
      kind: "voice",
      send: (sendApi: ReturnType<typeof createWebSendApi>) =>
        sendApi.sendMessage("+1555", "", Buffer.from("voice"), "audio/ogg"),
    },
    {
      kind: "poll",
      send: (sendApi: ReturnType<typeof createWebSendApi>) =>
        sendApi.sendPoll("+1555", { question: "Q?", options: ["a", "b"] }),
    },
  ])(
    "rejects an unaccepted Baileys $kind send without recording outbound activity",
    async ({ send }) => {
      sendMessage.mockResolvedValueOnce(undefined);

      await expect(send(api)).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(recordChannelActivity).not.toHaveBeenCalled();
    },
  );

  it("keeps direct-chat reactions without a participant key", async () => {
    await api.sendReaction("+1555", "msg-2", "👍", false);
    expectFirstSendJid("1555@s.whatsapp.net");
    const react = requireRecord(requireSendContent().react, "reaction content");
    expect(react.text).toBe("👍");
    expectRecordFields(requireRecord(react.key, "reaction key"), {
      remoteJid: "1555@s.whatsapp.net",
      id: "msg-2",
      fromMe: false,
      participant: undefined,
    });
  });

  it("preserves LID participants in reaction keys", async () => {
    await api.sendReaction("12345@g.us", "msg-2", "👍", false, "123@lid");
    expectFirstSendJid("12345@g.us");
    const react = requireRecord(requireSendContent().react, "reaction content");
    expect(react.text).toBe("👍");
    expectRecordFields(requireRecord(react.key, "reaction key"), {
      remoteJid: "12345@g.us",
      id: "msg-2",
      fromMe: false,
      participant: "123@lid",
    });
  });

  it("sends composing presence updates to the recipient JID", async () => {
    await api.sendComposingTo("+1555");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "1555@s.whatsapp.net");
  });

  it("does not send composing presence to newsletter JIDs", async () => {
    await api.sendComposingTo("120363401234567890@newsletter");
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it("preserves newsletter JIDs for outbound sends", async () => {
    await api.sendMessage("120363401234567890@newsletter", "hello");
    expect(sendMessage).toHaveBeenCalledWith("120363401234567890@newsletter", {
      text: "hello",
    });
  });

  it("sends media as document when mediaType is undefined", async () => {
    const mediaBuffer = Buffer.from("test");

    await api.sendMessage("123", "hello", mediaBuffer, undefined);

    expectFirstSendJid("123@s.whatsapp.net");
    expectSendContentFields(0, {
      document: mediaBuffer,
      mimetype: "application/octet-stream",
    });
  });

  it("does not set mediaType when mediaBuffer is absent", async () => {
    await api.sendMessage("123", "hello");

    expect(sendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", { text: "hello" });
  });

  it("preserves the quoted remoteJid provided by the outbound adapter", async () => {
    await api.sendMessage("+1555", "hello", undefined, undefined, {
      quotedMessageKey: {
        id: "quoted-1",
        remoteJid: "277038292303944@lid",
        fromMe: false,
        participant: "1234@s.whatsapp.net",
        messageText: "quoted body",
      },
    });

    expectFirstSendJid("1555@s.whatsapp.net");
    expect(requireMockArg(sendMessage, 0, 1, "sent message")).toEqual({ text: "hello" });
    const quoted = requireRecord(requireSendOptions().quoted, "quoted message");
    expectRecordFields(requireRecord(quoted.key, "quoted key"), {
      remoteJid: "277038292303944@lid",
      id: "quoted-1",
    });
  });

  it("aligns a lookup-proven LID quote with the final PN destination", async () => {
    await api.sendMessage("+1555", "hello", undefined, undefined, {
      quotedMessageKey: {
        id: "quoted-self",
        remoteJid: "277038292303944@lid",
        fromMe: true,
        lookupTargetJid: "1555@s.whatsapp.net",
        messageText: "quoted body",
      },
    });

    expectFirstSendJid("1555@s.whatsapp.net");
    const quoted = requireRecord(requireSendOptions().quoted, "quoted message");
    expectRecordFields(requireRecord(quoted.key, "quoted key"), {
      remoteJid: "1555@s.whatsapp.net",
      id: "quoted-self",
      fromMe: true,
    });
  });
});

// Integration tests for issue #67378: createWebSendApi must route outbound
// PN-only sends through the LID forward-mapping when authDir is provided,
// otherwise messages going to LID-addressed contacts vanish into a
// sender-only ghost chat.
describe("createWebSendApi LID resolution (issue #67378)", () => {
  const sendMessage = vi.fn(
    async (
      _jid: string,
      _content: AnyMessageContent,
      _options?: MiscMessageGenerationOptions,
    ): Promise<WAMessage | undefined> => ({ key: { id: "msg-1" } }) as WAMessage,
  );
  const sendPresenceUpdate = vi.fn(async () => {});
  let authDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-lid-"));
    fs.writeFileSync(path.join(authDir, "lid-mapping-15555550000.json"), JSON.stringify("987654"));
  });

  afterEach(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  it("resolves PN to LID for sendMessage when authDir is provided", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendMessage("+15555550000", "hello");
    expect(sendMessage).toHaveBeenCalledWith("987654@lid", { text: "hello" });
  });

  it("falls back to PN s.whatsapp.net when no LID mapping exists", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendMessage("+33123456789", "hello");
    expect(sendMessage).toHaveBeenCalledWith("33123456789@s.whatsapp.net", { text: "hello" });
  });

  it("resolves PN to LID for sendPoll", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendPoll("+15555550000", { question: "Q?", options: ["a", "b"] });
    expect(requireMockArg(sendMessage, 0, 0, "send poll")).toBe("987654@lid");
    const payload = requireRecord(
      requireMockArg(sendMessage, 0, 1, "send poll"),
      "send poll payload",
    );
    expect("poll" in payload).toBe(true);
  });

  it("resolves PN to LID for sendReaction", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendReaction("+15555550000", "msg-2", "1️⃣", true);
    expect(requireMockArg(sendMessage, 0, 0, "send reaction")).toBe("987654@lid");
    const payload = requireRecord(
      requireMockArg(sendMessage, 0, 1, "send reaction"),
      "send reaction payload",
    );
    const react = requireRecord(payload.react, "reaction content");
    expect(react.text).toBe("1️⃣");
    expect(requireRecord(react.key, "reaction key")).toMatchObject({
      remoteJid: "987654@lid",
      id: "msg-2",
      fromMe: true,
    });
    expect(requireRecord(react.key, "reaction key").participant).toBeUndefined();
  });

  it("resolves PN to LID for sendComposingTo presence", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendComposingTo("+15555550000");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "987654@lid");
  });

  it("skips newsletter composing presence when authDir is provided", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      authDir,
    });
    await api.sendComposingTo("120363401234567890@newsletter");
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it("preserves legacy behavior (no authDir → PN-only routing)", async () => {
    const api = createWebSendApi({
      sock: { sendMessage, sendPresenceUpdate },
      defaultAccountId: "main",
      // authDir intentionally omitted
    });
    await api.sendMessage("+15555550000", "hello");
    expect(sendMessage).toHaveBeenCalledWith("15555550000@s.whatsapp.net", { text: "hello" });
  });
});
